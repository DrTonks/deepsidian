import { Plugin, MarkdownView, Notice, FileSystemAdapter, TFile, addIcon } from 'obsidian';
import { join } from 'node:path';
import { relative, isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DshClient, discover, configuredModels, assistantText, type ModelChoice } from './dsh';
import { buildPrompt, EMPTY_CONTEXT, safeNotePath, excerpt, type NoteContext } from './context';
import { checkUpdates, compareVersions, type UpdateInfo } from './updates';
import { attachmentText, type Attachment } from './attachments';
import { reasoningText, traceEntry, eventLabels } from './trace';

import { WHALE_ICON } from './logo';

import { VIEW, defaults, type Saved, type Chat, type Message } from './types';
import { LearningView } from './view';
import { DeepsidianSettings } from './settings';
import { SetupModal } from './setup';
import { MemoryStore } from './memory/store';
import { MemoryModal } from './memory/modal';
import { commands, parseCommand } from './commands';

export default class Deepsidian extends Plugin {
  state: Saved = { settings: { ...defaults }, chats: [], activeId: '' };
  client?: DshClient;
  models: ModelChoice[] = [];
  selectedRoute?: ModelChoice;
  busy = false;
  stopRequested = false;
  runtimeVersion = '';
  status = '选择术语，或直接提问';
  source: NoteContext = { ...EMPTY_CONTEXT };
  includeContext = true;
  private lastMarkdown?: MarkdownView;
  activeSource: NoteContext = { ...EMPTY_CONTEXT };
  toolEvents: string[] = [];
  private saveQueue = Promise.resolve();
  private activeMessage?: Message;
  private attempt = '';
  private committed = '';
  private reasoningAttempt = '';
  private reasoningCommitted = '';
  private view?: LearningView;
  private disposed = false;
  private updateTask?: Promise<void>;
  private lastUsed = Date.now();
  private connecting?: Promise<DshClient>;
  private disconnecting?: Promise<void>;
  private memoryStore?: MemoryStore;
  async onload() {
    addIcon('deepsidian-whale', WHALE_ICON);
    const saved = await this.loadData() as Partial<Saved> | null;
    this.state = { settings: { ...defaults, ...saved?.settings }, chats: saved?.chats ?? [], activeId: saved?.activeId ?? '', updates: saved?.updates };
    if (!this.chat) this.newChat();
    // Connect only after Obsidian has restored its layout; do not block onload.
    for (const chat of this.state.chats) for (const message of chat.messages) if (message.status === '生成中') message.status = '上次运行被中断';
    this.registerView(VIEW, leaf => new LearningView(leaf, this));
    this.addRibbonIcon('deepsidian-whale', 'Deepsidian 学习助手', () => void this.open());
    this.addCommand({ id: 'open', name: '打开学习侧栏', callback: () => void this.open() });
    this.addCommand({ id: 'explain-selection', name: '解释选中的术语', editorCallback: (editor, view) => {
      this.includeContext = true;
      if (view instanceof MarkdownView) this.capture(view);
      const question = editor.getSelection().trim() ? `解释这段内容：${editor.getSelection().slice(0, 2000)}` : '请解释当前段落里最需要理解的概念。';
      void this.open().then(() => this.view?.setQuestion(question));
    } });
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      const current = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (current) { this.lastMarkdown = current; if (this.includeContext) this.capture(current); this.view?.refreshContext(); }
    }));
    this.addSettingTab(new DeepsidianSettings(this));
    this.addCommand({ id: 'setup', name: '设置与连接引导', callback: () => new SetupModal(this).open() });
    this.addCommand({id:'memory',name:'管理本库记忆',callback:()=>this.openMemory()});
    this.addCommand({id:'memory-rules',name:'编辑记忆整理规则',callback:()=>this.openMemory('rules')});
    this.addCommand({id:'memory-organize',name:'整理记忆索引（本地）',callback:()=>void this.organizeMemory().catch(e=>new Notice(String(e)))});
    this.app.workspace.onLayoutReady(()=>{
      if(this.disposed || !this.state.settings.autoConnect)return;
      void this.connect().catch(error=>{ if(!this.disposed){this.status=`自动连接未完成：${String(error)}；可打开连接引导`;this.view?.refreshStatus();} });
    });
    this.registerInterval(window.setInterval(() => { if (!this.busy && this.client?.connected && Date.now() - this.lastUsed > 300000) void this.disconnect(); }, 30000));
  }
  onunload() { this.disposed = true; void this.client?.stop(); }
  memory(){
    if(!this.memoryStore){
      if(!(this.app.vault.adapter instanceof FileSystemAdapter))throw Error('记忆仅支持桌面本地库');
      this.memoryStore=new MemoryStore(join(this.app.vault.adapter.getBasePath(),this.manifest.dir??`${this.app.vault.configDir}/plugins/${this.manifest.id}`,'memory'));
    }
    return this.memoryStore;
  }
  openMemory(tab:'entries'|'rules'='entries'){new MemoryModal(this,tab).open();}
  async organizeMemory(){const s=await this.memory().snapshot();await this.memory().update(s.revision,{organize:true});new Notice('已重建记忆索引；未调用模型或提炼聊天');}
  async runCommand(text:string):Promise<{question?:string}> {
    const command=parseCommand(text); if(!command)throw Error('指令格式无效，输入 / 查看指令');
    const {name,args}=command;
    if(!commands.some(c=>c.name===name))throw Error(`未知指令 /${name}；输入 / 查看可用指令`);
    if(['memory','rules','organize','new','connect','help'].includes(name) && args)throw Error(`/${name} 不接受参数`);
    if(this.busy && ['plan','goal','new','connect'].includes(name))throw Error('请先结束当前回答');
    if(name==='plan'){if(!args)throw Error('用法：/plan 要规划的问题');return {question:`请先为以下问题制定可检查的计划，说明目标、步骤、依赖和验收条件。本轮仅研究和规划，不执行实施步骤。\n\n${args}`};}
    if(name==='goal'){
      if(args.length>2000)throw Error('目标最多 2000 字符');
      if(!args){new Notice(this.chat?.goal?`当前目标：${this.chat.goal}`:'用法：/goal 目标内容；/goal clear 清除。不自动续跑。',8000);return {};}
      const chat=this.chat;if(!chat)throw Error('当前会话不存在');chat.goal=args==='clear'?undefined:args;await this.persist();new Notice(args==='clear'?'已清除会话目标':'已设置本会话目标；后续提问会带入，不自动续跑');return {};
    }
    if(name==='remember') {if(!args)throw Error('用法：/remember 要记住的内容');const s=await this.memory().snapshot();await this.memory().update(s.revision,{add:args,source:`显式 /remember · 会话 ${this.chat?.id??''}`});new Notice('已保存到本库记忆；自动召回尚未启用');}
    if(name==='memory')this.openMemory();
    if(name==='rules')this.openMemory('rules');
    if(name==='organize')await this.organizeMemory();
    if(name==='new')this.newChat();
    if(name==='connect')await this.connect();
    if(name==='help')new Notice(commands.map(c=>`/${c.name} ${c.hint} — ${c.description}`).join('\n'),15000);
    return {};
  }
  get chat() { return this.state.chats.find(c => c.id === this.state.activeId); }
  persist() {
    const snapshot = JSON.parse(JSON.stringify(this.state));
    const job = this.saveQueue.catch(() => {}).then(() => this.saveData(snapshot));
    this.saveQueue = job;
    return job;
  }
  newChat() {
    if (this.busy) { new Notice('请先停止当前回答'); return; }
    const chat: Chat = { id: randomUUID(), title: '新的学习对话', messages: [] };
    this.state.chats.unshift(chat); this.state.activeId = chat.id;
    this.toolEvents = []; void this.persist(); this.view?.renderMessages(); this.view?.refreshChats();
  }
  async open() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false)!; await leaf.setViewState({ type: VIEW, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }
  attach(view: LearningView) { this.view = view; }
  detach(view: LearningView) { if (this.view === view) this.view = undefined; }
  capture(view: MarkdownView | null = this.app.workspace.getActiveViewOfType(MarkdownView) ?? this.lastMarkdown ?? null) {
    if (!this.includeContext) return;
    if (!view?.file) return;
    this.lastMarkdown = view;
    const editor = view.editor, from = editor.getCursor('from').line, to = editor.getCursor('to').line;
    this.source = { path: view.file.path, selection: editor.getSelection().slice(0, 6000), nearby: editor.getRange({ line: Math.max(0, from - 6), ch: 0 }, { line: Math.min(editor.lastLine(), to + 6), ch: editor.getLine(Math.min(editor.lastLine(), to + 6)).length }).slice(0, 10000) };
  }
  resolveEnvironment() {
    const s = this.state.settings;
    const env = discover(s.packageRoot, s.nodePath, s.dshHome);
    const configured = configuredModels(env.root, env.home);
    return { ...env, model: s.provider && s.model ? { provider: s.provider, model: s.model } : configured.selected, choices: configured.choices };
  }
  async connect() {
    await this.disconnecting;
    if(this.disposed)throw Error('插件已关闭');
    this.lastUsed = Date.now();
    if (this.client?.connected) return this.client;
    if(this.connecting)return this.connecting;
    const job=this.connectRuntime();this.connecting=job;
    try{return await job;}finally{if(this.connecting===job)this.connecting=undefined;}
  }
  private async connectRuntime() {
    const env = this.resolveEnvironment();
    this.runtimeVersion = env.versions.dsh!;
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) throw Error('此插件目前仅支持桌面端本地笔记库');
    const base = this.app.vault.adapter.getBasePath();
    const directory = join(base, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    this.status = '正在连接本地 DSH…'; this.view?.refreshStatus();
    this.client = new DshClient({ packageRoot: env.root, nodePath: env.node, dshHome: env.home, runtimeHome: join(directory, '.runtime'), bridgePath: join(directory, 'bridge.mjs'), cwd: base, ...env.model, reasoningEffort: this.state.settings.reasoningEffort, maxTokens: this.state.settings.maxTokens, webSearch: this.state.settings.webSearch, webFetch: this.state.settings.webFetch },
      (name, args) => this.handleTool(name, args), (method, data) => this.onRuntime(method, data));
    const client=this.client;
    try {await client.start();if(this.disposed)throw Error('插件已关闭');}
    catch(error){await client.stop();if(this.client===client)this.client=undefined;throw error;}
    this.selectedRoute = env.model;
    if (this.state.settings.checkUpdates) void this.update(false);
    this.status = `${env.model.model} · DSH ${env.versions.dsh}${Object.values(env.versions).every(v => v === '0.1.5-rc.2') ? '' : ' · 此版本未验证'}`;
    this.view?.refreshStatus(); return client;
  }
  async disconnect() {
    if(this.disconnecting)return this.disconnecting;
    const job=(async()=>{await this.connecting?.catch(()=>{});await this.client?.stop();this.client=undefined;this.status='已断开，下次提问会重新连接';this.view?.refreshStatus();})();
    this.disconnecting=job;
    try{await job;}finally{if(this.disconnecting===job)this.disconnecting=undefined;}
  }
  private onRuntime(method: string, data: any) {
    if (this.disposed) return;
    if (method === 'deepsidian.stream' && data.sessionId === this.chat?.id && this.activeMessage) {
      const frame = data.frame;
      if (frame.type === 'start') { this.attempt = ''; this.reasoningAttempt = ''; }
      if (frame.type === 'chunk' && frame.chunk.type === 'reasoning-delta') {
        this.reasoningAttempt += frame.chunk.text; this.activeMessage.reasoning = this.reasoningCommitted + this.reasoningAttempt; this.view?.scheduleAnswer();
      }
      if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
        this.attempt += frame.chunk.text; this.activeMessage.text = this.committed + this.attempt; this.view?.scheduleAnswer();
      }
    }
    if (method === 'session.event' && data.sessionId === this.chat?.id) {
      const event = data.event;
      if (event.type === 'system/message' && this.chat) this.chat.systemPrompt = event.data.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      if (this.activeMessage && (eventLabels[event.type] || event.type.startsWith('web/'))) {
        (this.activeMessage.trace ??= []).push(traceEntry(event));
        this.view?.scheduleAnswer();
      }
      if (event.type === 'assistant/message' && this.activeMessage) {
        const reasoning = reasoningText(event.data.stream);
        this.reasoningCommitted += (this.reasoningCommitted && reasoning ? '\n\n' : '') + reasoning;
        this.reasoningAttempt = ''; this.activeMessage.reasoning = this.reasoningCommitted;
        const text = assistantText(event.data.stream);
        this.committed += (this.committed && text ? '\n\n' : '') + text;
        this.attempt = ''; this.activeMessage.text = this.committed; this.view?.scheduleAnswer();
      }
      if (event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'step/start') {
        this.toolEvents.push(`${event.type}${event.data.name ? ' · ' + event.data.name : ''}`);
        this.toolEvents = this.toolEvents.slice(-30); this.view?.refreshTools();
      }
    }
    if (method === 'disconnected') { this.status = 'DSH 已断开，下次提问将重新连接'; this.view?.refreshStatus(); }
  }
  async ask(question: string, attachments: Attachment[] = []) {
    if (this.busy || !question.trim()) return;
    const inputQuestion=this.chat?.goal?`本会话目标：${this.chat.goal}\n\n本次问题：${question}`:question;
    const prompt = buildPrompt(inputQuestion, '', this.source) + attachmentText(attachments);
    if (prompt.length > 40000) { new Notice('本次上下文超过 40000 字符，请减少附件或选区。'); return; }
    const chat = this.chat!;
    this.busy = true; this.stopRequested = false; this.capture(); this.activeSource = { ...this.source };
    this.toolEvents = []; this.attempt = ''; this.committed = ''; this.reasoningAttempt = ''; this.reasoningCommitted = '';
    chat.messages.push({ role: 'user', text: question, source: { ...this.activeSource }, attachments: attachments.map(f => f.name) });
    if (chat.messages.length === 1) chat.title = question.slice(0, 28);
    const answer: Message = { role: 'assistant', text: '', status: '生成中', trace: [], startedAt: Date.now() };
    chat.messages.push(answer); this.activeMessage = answer;
    this.view?.renderMessages(); this.view?.refreshStatus(); this.view?.refreshChats();
    try {
      await this.persist();
      const client = await this.connect();
      if (this.stopRequested) throw Error('已在发送模型请求前停止');
      answer.model = client.options.model;
      const reason = await client.prompt(chat.id, buildPrompt(inputQuestion, '', this.activeSource) + attachmentText(attachments), attachments.flatMap(f => f.image ? [f.image] : []));
      answer.status = reason.kind === 'completed' ? '完成' : reason.kind === 'aborted' ? '已停止' : `已结束：${reason.kind}`;
      if (!answer.text) answer.text = answer.status === '完成' ? '模型未返回可显示文本。可检查模型配置或再次提问。' : '本次回答已停止。';
    } catch (error) { answer.status = this.stopRequested ? '已停止' : '失败'; answer.text += `\n\n${String(error)}`; }
    finally { this.lastUsed = Date.now(); answer.elapsedMs = Date.now() - answer.startedAt!; this.busy = false; this.activeMessage = undefined; try { await this.persist(); } catch { new Notice('无法保存聊天记录，请检查笔记库写入权限'); } this.view?.renderMessages(); this.view?.refreshStatus(); }
  }
  stopAnswer() { this.stopRequested = true; this.client?.cancel(); this.view?.refreshStatus(); }
  async handleTool(name: string, args: Record<string, unknown>) {
    if (!this.busy) throw Error('当前没有活动的学习请求');
    this.toolEvents.push(`调用 ${name}${name === 'obsidian_read' ? ' · ' + String(args.path) : name === 'obsidian_search' ? ' · ' + String(args.query) : ''}`);
    this.toolEvents = this.toolEvents.slice(-30); this.view?.refreshTools();
    if (name === 'obsidian_context') return this.activeSource;
    if (name === 'obsidian_metadata') {
      const path = safeNotePath(args.path), file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw Error('找不到笔记');
      await this.assertContained(path);
      const cache = this.app.metadataCache.getFileCache(file);
      const backlinks = Object.entries(this.app.metadataCache.resolvedLinks).filter(([source, links]) => links[path] && !source.split('/').some(p => p.startsWith('.'))).slice(0, 30).map(([source]) => source);
      return { path, headings: cache?.headings?.slice(0, 80).map(h => ({ text: h.heading, level: h.level, line: h.position.start.line + 1 })), tags: cache?.tags?.slice(0, 40).map(t => t.tag), links: cache?.links?.slice(0, 40).map(l => l.link), backlinks, limits: { headings: 80, tags: 40, links: 40, backlinks: 30 } };
    }
    if (name === 'obsidian_read') {
      const path = safeNotePath(args.path), file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw Error('找不到笔记');
      await this.assertContained(file.path);
      if (file.stat.size > 1_000_000) throw Error('笔记超过 1MB，请选择更小的资料');
      const open = this.app.workspace.getLeavesOfType('markdown').map(l => l.view).find(v => v instanceof MarkdownView && v.file?.path === path) as MarkdownView | undefined;
      return { path, ...excerpt(open ? open.editor.getValue() : await this.app.vault.read(file), args.offset) };
    }
    if (name === 'obsidian_search') {
      const query = String(args.query ?? '').trim().toLocaleLowerCase();
      if (!query || query.length > 100) throw Error('请输入 1–100 字的搜索词');
      const results: { path: string; snippet: string }[] = [];
      const files = this.app.vault.getMarkdownFiles().filter(f => !f.path.split('/').some(p => p.startsWith('.')) && f.stat.size <= 200000);
      files.sort((a,b) => Number(b.path.toLocaleLowerCase().includes(query)) - Number(a.path.toLocaleLowerCase().includes(query)) || a.path.localeCompare(b.path));
      let scanned = 0;
      for (const file of files.slice(0, 300)) {
        if (!this.busy) throw Error('请求已停止');
        try { await this.assertContained(file.path); } catch { continue; }
        const content = await this.app.vault.cachedRead(file); scanned++;
        const index = content.toLocaleLowerCase().indexOf(query);
        if (index >= 0 || file.path.toLocaleLowerCase().includes(query)) results.push({ path: file.path, snippet: content.slice(Math.max(0,index - 100), Math.max(0,index) + 300) });
        if (results.length === 8) break;
      }
      return { results, scanned, total: files.length, limited: scanned < files.length };
    }
    throw Error('未知工具');
  }
  private async assertContained(path: string) {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) throw Error('需要本地笔记库');
    const base = await realpath(this.app.vault.adapter.getBasePath());
    const target = await realpath(join(base, path));
    const rel = relative(base, target);
    if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw Error('笔记实际路径超出当前库');
  }
  async update(force: boolean) {
    if (this.updateTask) return this.updateTask;
    this.updateTask = (async () => {
      this.state.updates = await checkUpdates(this.state.updates, force); await this.persist(); this.view?.refreshStatus();
      if (force) new Notice(this.state.updates.error ? `更新检查失败：${this.state.updates.error}` : `官方发布：${this.state.updates.newest}；不会自动安装`);
    })();
    try { await this.updateTask; } finally { this.updateTask = undefined; }
  }
}

