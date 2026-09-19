import { TESTED_DSH } from './versions';
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
import { prepareRecall, readRecall, MEMORY_DISABLED, type Recall } from './memory/recall';
import { MemoryManager, MANAGEMENT_ENABLED, MANAGEMENT_DISABLED } from './memory/manage';
import { commands, parseCommand } from './commands';
import { extractionSources, extractionPrompt, parseProposals, sourceKey, memoryStartKey, memorySourceStart, type ProposalBatch } from './memory/proposals';
import { runOrganizer } from './memory/organizer';
import { OrganizerModal } from './memory/organizer-modal';
import { MemoryScheduler, newIdleMemory, type IdleMemoryState } from './memory/scheduler';

export default class Deepsidian extends Plugin {
  state: Saved = { settings: { ...defaults }, chats: [], activeId: '' };
  client?: DshClient;
  models: ModelChoice[] = [];
  selectedRoute?: ModelChoice;
  busy = false;
  creatingChat = false;
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
  private activeRecall?: Recall;
  private organizerAbort?:AbortController;
  private memoryReadChars = 0;
  private activeManager?:MemoryManager;
  async setManageMemory(enabled:boolean) {
    if(this.busy)throw Error('请先结束当前回答，再修改 AI 记忆管理权限');
    this.busy=true;
    try {
      await this.disconnect();
      await this.saveChange(draft=>{draft.settings.manageMemory=enabled;},()=>{this.state.settings.manageMemory=enabled;});
    } finally {this.busy=false;this.view?.refreshStatus();}
  }
  readonly memoryDrafts = new Map<string,string>();
  private autoAttempt?: Promise<void>;
  private retryAt = 0;
  private retryDelay = 2000;
  private layoutReady = false;
  private memoryDocuments=new Map<Document,()=>void>();
  private watchMemoryDocument(doc:Document){
    if(this.disposed || this.memoryDocuments.has(doc))return;
    const events=['keydown','pointerdown','pointermove','wheel','focusin'] as const;
    const activity=()=>this.memoryActivity();
    for(const event of events)doc.addEventListener(event,activity,{passive:true});
    this.memoryDocuments.set(doc,()=>{for(const event of events)doc.removeEventListener(event,activity);});
  }
  readonly idleScheduler=new MemoryScheduler({
    enabled:()=>this.state.settings.idleMemory,
    blocked:()=>this.busy || this.disposed || !this.layoutReady,
    chats:()=>this.state.chats,state:()=>this.state.idleMemory??newIdleMemory(),
    save:change=>this.saveIdleMemory(change),snapshot:()=>this.memory().snapshot(),
    run:(prompt,signal)=>this.runMemoryModel(prompt,signal),
  });
  memoryActivity(){this.idleScheduler.activity();}
  private saveIdleMemory(change:(state:IdleMemoryState)=>void){
    let next:IdleMemoryState;
    return this.saveChange(draft=>{next=draft.idleMemory??newIdleMemory();change(next);draft.idleMemory=next;},()=>{this.state.idleMemory=next;});
  }
  async setIdleMemory(enabled:boolean){
    this.memoryActivity();
    await this.saveChange(draft=>{draft.settings.idleMemory=enabled;},()=>{this.state.settings.idleMemory=enabled;});
  }
  async discardIdleMemory(id:string){
    this.memoryActivity();
    if(this.busy)throw Error('正在处理提案或回答，请完成后再放弃');
    this.busy=true;
    try{await this.clearIdleMemory(id);}finally{this.busy=false;this.view?.refreshStatus();}
  }
  private clearIdleMemory(id:string){
    return this.saveIdleMemory(state=>{if(state.pending?.id!==id)throw Error('待审提案已改变，请重新打开');delete state.pending;});
  }
  async onload() {
    addIcon('deepsidian-whale', WHALE_ICON);
    const saved = await this.loadData() as Partial<Saved> | null;
    this.state = { settings: { ...defaults, ...saved?.settings }, chats: saved?.chats ?? [], activeId: saved?.activeId ?? '', updates: saved?.updates, idleMemory:saved?.idleMemory };
    if (!this.chat) await this.newChat();
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
      this.memoryActivity();
      const current = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (current) { this.lastMarkdown = current; if (this.includeContext) this.capture(current); this.view?.refreshContext(); }
    }));
    this.addSettingTab(new DeepsidianSettings(this));
    this.addCommand({ id: 'setup', name: '设置与连接引导', callback: () => new SetupModal(this).open() });
    this.addCommand({id:'memory',name:'管理本库记忆',callback:()=>this.openMemory()});
    this.addCommand({id:'memory-rules',name:'编辑记忆整理规则',callback:()=>this.openMemory('rules')});
    this.addCommand({id:'memory-organize',name:'整理记忆索引（本地）',callback:()=>void this.organizeMemory().catch(e=>new Notice(String(e)))});
    this.app.workspace.onLayoutReady(()=>{
      if(this.disposed)return;
      this.layoutReady = true;
      this.app.workspace.iterateAllLeaves?.(leaf=>this.watchMemoryDocument(leaf.view.containerEl.ownerDocument));
      void this.ensureAutomaticConnection();
    });
    this.registerEvent(this.app.workspace.on('window-open',(_workspace,win)=>{this.memoryActivity();this.watchMemoryDocument(win.document);}));
    this.registerEvent(this.app.workspace.on('window-close',(_workspace,win)=>{this.memoryDocuments.get(win.document)?.();this.memoryDocuments.delete(win.document);}));
    this.registerInterval(window.setInterval(() => this.maintainConnection(), 1000));
    if(typeof document!=='undefined')this.watchMemoryDocument(document);
  }
  onunload() { this.disposed = true;for(const cleanup of this.memoryDocuments.values())cleanup();this.memoryDocuments.clear();this.idleScheduler.dispose();this.organizerAbort?.abort(); void this.client?.stop(); }
  memory(){
    if(!this.memoryStore){
      if(!(this.app.vault.adapter instanceof FileSystemAdapter))throw Error('记忆仅支持桌面本地库');
      this.memoryStore=new MemoryStore(join(this.app.vault.adapter.getBasePath(),this.manifest.dir??`${this.app.vault.configDir}/plugins/${this.manifest.id}`,'memory'));
    }
    return this.memoryStore;
  }
  openMemory(tab:'entries'|'rules'='entries'){this.memoryActivity();new MemoryModal(this,tab).open();}
  openOrganizer(){this.memoryActivity();new OrganizerModal(this,this.state.idleMemory?.pending).open();}
  async extractMemory(chatId:string,signal:AbortSignal):Promise<ProposalBatch> {
    if(this.idleScheduler.running)await this.idleScheduler.stop();
    if(this.busy || this.disposed)throw Error('请先结束当前操作');
    const chat=this.state.chats.find(c=>c.id===chatId);if(!chat)throw Error('会话不存在');
    if(chat.contributeMemory===false)throw Error('本会话已关闭记忆贡献');
    this.busy=true;const controller=new AbortController();this.organizerAbort=controller;
    const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();this.view?.refreshStatus();
    try {
      const frozen=structuredClone(chat),snapshot=await this.memory().snapshot();
      const sources=extractionSources(frozen,snapshot.excludedSources),prompt=extractionPrompt(snapshot,sources);
      controller.signal.throwIfAborted();
      const raw=await this.runMemoryModel(prompt,controller.signal);
      controller.signal.throwIfAborted();
      return {chatId,title:frozen.title,snapshot,sources,proposals:parseProposals(raw,snapshot,sources),memoryPolicyVersion:frozen.memoryPolicyVersion??0};
    } finally {signal.removeEventListener('abort',abort);this.organizerAbort=undefined;this.busy=false;this.view?.refreshStatus();}
  }
  private async runMemoryModel(prompt:string,signal:AbortSignal) {
    const env=this.resolveEnvironment();
    if(!(this.app.vault.adapter instanceof FileSystemAdapter))throw Error('仅支持桌面端');
    const base=this.app.vault.adapter.getBasePath();
    const directory=join(base,this.manifest.dir??`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    return runOrganizer({packageRoot:env.root,nodePath:env.node,dshHome:env.home,runtimeHome:join(directory,'.memory-runtime'),bridgePath:join(directory,'bridge.mjs'),cwd:base,...env.model},prompt,signal);
  }
  async applyMemoryProposals(batch:ProposalBatch,selected:number[],pendingId?:string) {
    this.memoryActivity();
    if(this.busy || this.disposed)throw Error('请先结束当前操作');
    this.busy=true;
    try {
      if(pendingId && this.state.idleMemory?.pending?.id!==pendingId)throw Error('待审提案已改变，请重新打开');
      const chat=this.state.chats.find(c=>c.id===batch.chatId);
      if(!chat || chat.contributeMemory===false)throw Error('来源会话不存在或已关闭贡献');
      if((batch.memoryPolicyVersion??0)!==(chat.memoryPolicyVersion??0))throw Error('会话来源范围已改变，请重新生成提案');
      const start=memorySourceStart(chat);
      if(!selected.length || new Set(selected).size!==selected.length || selected.some(i=>!Number.isInteger(i)||!batch.proposals[i]))throw Error('请选择有效提案');
      for(const source of batch.sources) {
        const message=chat.messages[source.index];
        if(source.index<start || !message || message.role!=='user' || sourceKey(chat.id,source.index,message.text)!==source.key)throw Error('来源消息已改变或已排除，请重新生成提案');
      }
      const snapshot=await this.memory().snapshot();
      if(snapshot.revision!==batch.snapshot.revision)throw Error('记忆或规则已改变，请重新生成提案');
      const proposals=parseProposals(JSON.stringify({proposals:selected.map(i=>batch.proposals[i])}),snapshot,batch.sources);
      await this.memory().update(snapshot.revision,{batch:proposals.map(p=>({id:p.id,text:p.text,source:`模型提案，经用户确认 · 会话 ${batch.chatId}`,sourceKeys:p.evidence.map(e=>e.key)}))});
      if(pendingId)try{await this.clearIdleMemory(pendingId);}catch{new Notice('记忆已保存，但待审记录清理失败；重新打开后可放弃旧提案，无需重复保存。');}
    } finally {this.busy=false;this.view?.refreshStatus();}
  }
  async setChatMemory(id: string, change: {useMemory?: boolean; contributeMemory?: boolean}) {
    this.memoryActivity();
    if(this.busy) throw Error('请先结束当前回答，再修改会话记忆设置');
    const chat = this.state.chats.find(c => c.id === id);
    if(!chat) throw Error('会话不存在');
    const patch:Partial<Chat> = Object.fromEntries(Object.entries(change).filter(([key,value]) => ['useMemory','contributeMemory'].includes(key) && typeof value === 'boolean'));
    const policyChanged=patch.contributeMemory!==undefined && (chat.contributeMemory!==false)!==patch.contributeMemory;
    if(policyChanged)patch.memoryPolicyVersion=(chat.memoryPolicyVersion??0)+1;
    this.busy=true;
    try {await this.saveChange(draft => {Object.assign(draft.chats.find(c => c.id === id)!,patch);if(policyChanged && draft.idleMemory?.pending?.batch.chatId===id)delete draft.idleMemory.pending;}, () => {Object.assign(chat,patch);if(policyChanged && this.state.idleMemory?.pending?.batch.chatId===id)delete this.state.idleMemory.pending;});}
    finally {this.busy=false;this.view?.refreshStatus();}
  }
  async setChatMemoryStart(id:string,mode:'now'|'all') {
    this.memoryActivity();
    if(this.busy || this.disposed)throw Error('请先结束当前操作，再修改来源范围');
    const chat=this.state.chats.find(c=>c.id===id);if(!chat)throw Error('会话不存在');
    if(mode!=='now' && mode!=='all')throw Error('无效的来源范围');
    const memoryStart=mode==='now'?{index:chat.messages.length,key:memoryStartKey(chat,chat.messages.length)}:undefined;
    const version=(chat.memoryPolicyVersion??0)+1;
    this.busy=true;
    try {await this.saveChange(draft=>{
      Object.assign(draft.chats.find(c=>c.id===id)!,{memoryStart,memoryPolicyVersion:version});
      if(draft.idleMemory){if(draft.idleMemory.pending?.batch.chatId===id)delete draft.idleMemory.pending;delete draft.idleMemory.cursors[id];}
    },()=>{
      Object.assign(chat,{memoryStart,memoryPolicyVersion:version});
      if(this.state.idleMemory){if(this.state.idleMemory.pending?.batch.chatId===id)delete this.state.idleMemory.pending;delete this.state.idleMemory.cursors[id];}
    });} finally {this.busy=false;this.view?.refreshStatus();}
  }
  memoryContributionPreview(id:string){
    const chat=this.state.chats.find(c=>c.id===id);if(!chat)throw Error('会话不存在');
    return {start:memorySourceStart(chat),sources:chat.contributeMemory===false?[]:extractionSources(chat)};
  }
  async organizeMemory(){const s=await this.memory().snapshot();await this.memory().update(s.revision,{organize:true});new Notice('已重建记忆索引；未调用模型或提炼聊天');}
  async runCommand(text:string):Promise<{question?:string}> {
    this.memoryActivity();
    const command=parseCommand(text); if(!command)throw Error('指令格式无效，输入 / 查看指令');
    const {name,args}=command;
    if(!commands.some(c=>c.name===name))throw Error(`未知指令 /${name}；输入 / 查看可用指令`);
    if(['memory','rules','organize','extract','new','connect','help'].includes(name) && args)throw Error(`/${name} 不接受参数`);
    if(this.busy && ['plan','goal','new','connect'].includes(name))throw Error('请先结束当前回答');
    if(name==='plan'){if(!args)throw Error('用法：/plan 要规划的问题');return {question:`请先为以下问题制定可检查的计划，说明目标、步骤、依赖和验收条件。本轮仅研究和规划，不执行实施步骤。\n\n${args}`};}
    if(name==='goal'){
      if(args.length>2000)throw Error('目标最多 2000 字符');
      if(!args){new Notice(this.chat?.goal?`当前目标：${this.chat.goal}`:'用法：/goal 目标内容；/goal clear 清除。不自动续跑。',8000);return {};}
      const chat=this.chat;if(!chat)throw Error('当前会话不存在');
      const goal=args==='clear'?undefined:args;
      await this.saveChange(draft => { draft.chats.find(c => c.id === chat.id)!.goal = goal; }, () => { chat.goal = goal; });
      new Notice(args==='clear'?'已清除会话目标':'已设置本会话目标；后续提问会带入，不自动续跑');return {};
    }
    if(name==='remember') {
      if(!args)throw Error('用法：/remember 要记住的内容');
      if(this.busy)throw Error('请先结束当前操作');
      const chat=this.chat;
      if(!chat || chat.contributeMemory===false) throw Error('本会话已关闭记忆贡献；可在 /memory 的“本会话”中修改');
      this.busy=true;
      try {const s=await this.memory().snapshot();
        await this.memory().update(s.revision,{add:args,source:`显式 /remember · 会话 ${chat.id}`});new Notice('已保存到本库记忆；下次提问时可读取');}
      finally {this.busy=false;this.view?.refreshStatus();}
    }
    if(name==='memory')this.openMemory();
    if(name==='rules')this.openMemory('rules');
    if(name==='organize')await this.organizeMemory();
    if(name==='extract')this.openOrganizer();
    if(name==='new')await this.newChat();
    if(name==='connect')await this.connect();
    if(name==='help')new Notice(commands.map(c=>`/${c.name} ${c.hint} — ${c.description}`).join('\n'),15000);
    return {};
  }
  get chat() { return this.state.chats.find(c => c.id === this.state.activeId); }
  // Snapshot at execution time; staged changes only become visible after a successful write.
  private saveChange(change: (draft: Saved) => void = () => {}, commit: () => void = () => {}) {
    const job = this.saveQueue.catch(() => {}).then(async () => {
      const draft: Saved = JSON.parse(JSON.stringify(this.state));
      change(draft);
      await this.saveData(draft);
      commit();
    });
    this.saveQueue = job;
    return job;
  }
  persist() { return this.saveChange(); }
  async selectChat(id: string) {
    if (this.busy) throw Error('请等待当前操作结束后切换会话');
    if (!this.state.chats.some(chat => chat.id === id)) throw Error('会话不存在');
    await this.saveChange(draft => { draft.activeId = id; }, () => { this.state.activeId = id; });
  }
  async newChat() {
    if (this.busy) throw Error('请等待当前操作结束后新建对话');
    const chat: Chat = { id: randomUUID(), title: '新的学习对话', messages: [] };
    this.busy = true; this.creatingChat = true;
    this.view?.refreshStatus();
    try {
      await this.saveChange(draft => { draft.chats.unshift(chat); draft.activeId = chat.id; },
        () => { this.state.chats.unshift(chat); this.state.activeId = chat.id; });
      this.toolEvents = [];
    } catch (error) { throw Error(`新建会话保存失败：${String(error)}`); }
    finally {
      this.busy = false; this.creatingChat = false;
      this.view?.renderMessages(); this.view?.refreshChats(); this.view?.refreshStatus();
    }
  }
  sidebarActivated() {
    this.memoryActivity();
    this.lastUsed = Date.now();
    void this.ensureAutomaticConnection();
  }
  private maintainConnection() {
    if (this.disposed || !this.layoutReady) return;
    void this.idleScheduler.tick();
    if (this.view?.hasFocus()) {
      this.lastUsed = Date.now();
      void this.ensureAutomaticConnection();
    } else if (!this.busy && !this.connecting && !this.disconnecting && this.client?.connected && Date.now() - this.lastUsed > 300000) {
      void this.disconnect().catch(() => {});
    }
  }
  private async ensureAutomaticConnection() {
    if (this.disposed || !this.layoutReady || !this.state.settings.autoConnect || this.busy || this.disconnecting || this.autoAttempt || Date.now() < this.retryAt) return;
    if (this.client?.connected && !this.connecting) return;
    const job = (async () => {
      try { await this.connect(); this.retryAt = 0; this.retryDelay = 2000; }
      catch (error) {
        this.retryAt = Date.now() + this.retryDelay;
        this.retryDelay = Math.min(this.retryDelay * 2, 30000);
        if (!this.disposed) { this.status = `暂未连接：${String(error)}；侧栏聚焦时自动重试，可在设置中诊断`; this.view?.refreshStatus(); }
      }
    })();
    this.autoAttempt = job;
    try { await job; } finally { if (this.autoAttempt === job) this.autoAttempt = undefined; }
  }
  async open() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false)!; await leaf.setViewState({ type: VIEW, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
    this.sidebarActivated();
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
    if(this.connecting)return this.connecting;
    if (this.client?.connected) return this.client;
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
    this.client = new DshClient({ packageRoot: env.root, nodePath: env.node, dshHome: env.home, runtimeHome: join(directory, '.runtime'), bridgePath: join(directory, 'bridge.mjs'), cwd: base, ...env.model, reasoningEffort: this.state.settings.reasoningEffort, maxTokens: this.state.settings.maxTokens, webSearch: this.state.settings.webSearch, webFetch: this.state.settings.webFetch, manageMemory:this.state.settings.manageMemory },
      (name, args) => this.handleTool(name, args), (method, data) => this.onRuntime(method, data));
    const client=this.client;
    try {await client.start(); if(this.disposed)throw Error('插件已关闭');}
    catch(error){await client.stop();if(this.client===client)this.client=undefined;throw error;}
    this.selectedRoute = env.model;
    let catalogWarning='';
    try {this.models=await client.models();}
    catch {this.models=[env.model];catalogWarning=' · 模型目录暂不可用，保留当前模型；可重连重试';}
    if(this.disposed || !client.connected){await client.stop();if(this.client===client)this.client=undefined;throw Error('DSH 连接已结束');}
    if (this.state.settings.checkUpdates) void this.update(false).catch(() => {});
    this.status = `${env.model.model} · DSH ${env.versions.dsh}${Object.values(env.versions).every(v => v === TESTED_DSH) ? '' : ' · 此版本未验证'}${catalogWarning}`;
    this.view?.refreshConnection(); return client;
  }
  async disconnect() {
    if(this.disconnecting)return this.disconnecting;
    const job=(async()=>{await this.connecting?.catch(()=>{});await this.client?.stop();this.client=undefined;this.status=this.state.settings.autoConnect?'运行时已休眠，返回侧栏将自动连接':'运行时已休眠，发送消息时连接';this.view?.refreshStatus();})();
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
    if (method === 'disconnected') { this.status = this.state.settings.autoConnect ? '连接已中断，侧栏聚焦时自动重连' : '连接已中断，发送消息时重连'; this.view?.refreshStatus(); }
  }
  async ask(question: string, attachments: Attachment[] = [], accepted?: () => void) {
    this.memoryActivity();
    if (this.busy || !question.trim()) return;
    this.capture();
    const source = { ...this.source };
    const inputQuestion=this.chat?.goal?`本会话目标：${this.chat.goal}\n\n本次问题：${question}`:question;
    let prompt = buildPrompt(inputQuestion, '', source) + attachmentText(attachments);
    if (prompt.length > 40000) { new Notice('本次上下文超过 40000 字符，请减少附件或选区。'); return; }
    const chat = this.chat!;
    this.busy = true; this.stopRequested = false; this.activeSource = source;
    this.activeRecall = undefined; this.activeManager=undefined; this.memoryReadChars = 0; this.view?.refreshStatus();
    try {
      if(this.state.settings.useMemory && chat.useMemory!==false) this.activeRecall = prepareRecall(await this.memory().snapshot(), question);
      if(this.state.settings.manageMemory && chat.contributeMemory!==false && this.activeRecall) {
        const index=chat.messages.length;
        const manager=new MemoryManager(this.memory(),this.activeRecall.snapshot,{chatId:chat.id,index,text:question},()=>{
          if(this.activeManager!==manager||this.disposed||this.stopRequested||!this.busy||!this.activeMessage||this.chat!==chat||!this.state.settings.manageMemory||!this.state.settings.useMemory||chat.useMemory===false||chat.contributeMemory===false)
            throw Error('本轮 AI 记忆管理权限已关闭或请求已停止');
          if(chat.messages[index]?.role!=='user'||chat.messages[index]?.text!==question||memorySourceStart(chat)>index)throw Error('当前授权消息或来源范围已改变');
        });
        this.activeManager=manager;
      }
      prompt += '\n\n' + (this.activeRecall?.prompt ?? MEMORY_DISABLED);
      prompt += '\n\n' + (this.activeManager?MANAGEMENT_ENABLED:MANAGEMENT_DISABLED);
      if(prompt.length>40000) throw Error('包含记忆后上下文超过40000字符，请减少附件或选区');
      if(this.disposed || this.stopRequested) throw Error('已在发送前停止');
    } catch(error) {
      this.busy=false; this.activeRecall=undefined; this.activeManager=undefined; this.view?.refreshStatus();
      new Notice(`未发送，草稿已保留：${String(error)}`); return;
    }
    accepted?.();
    this.toolEvents = []; this.attempt = ''; this.committed = ''; this.reasoningAttempt = ''; this.reasoningCommitted = '';
    chat.messages.push({ role: 'user', text: question, source: { ...this.activeSource }, attachments: attachments.map(f => f.name) });
    if (chat.messages.length === 1) chat.title = question.slice(0, 28);
    const answer: Message = { role: 'assistant', text: '', status: '生成中', trace: [traceEntry({type:'memory/snapshot',data:{enabled:!!this.activeRecall,revision:this.activeRecall?.snapshot.revision,index:this.activeRecall?.index??[],note:'仅记录提供给模型的索引；不代表模型已使用，正文读取见memory/read'}})], startedAt: Date.now() };
    chat.messages.push(answer); this.activeMessage = answer;
    this.view?.renderMessages(); this.view?.refreshStatus(); this.view?.refreshChats();
    try {
      await this.persist();
      const client = await this.connect();
      if (this.stopRequested) throw Error('已在发送模型请求前停止');
      answer.model = client.options.model;
      const reason = await client.prompt(chat.id, prompt, attachments.flatMap(f => f.image ? [f.image] : []));
      answer.status = reason.kind === 'completed' ? '完成' : reason.kind === 'aborted' ? '已停止' : `已结束：${reason.kind}`;
      if (!answer.text) answer.text = answer.status === '完成' ? '模型未返回可显示文本。可检查模型配置或再次提问。' : '本次回答已停止。';
    } catch (error) { answer.status = this.stopRequested ? '已停止' : '失败'; answer.text += `\n\n${String(error)}`; }
    finally { this.lastUsed = Date.now(); answer.elapsedMs = Date.now() - answer.startedAt!; this.busy = false; this.activeMessage = undefined; this.activeRecall = undefined; this.activeManager=undefined; try { await this.persist(); } catch { new Notice('无法保存聊天记录，请检查笔记库写入权限'); } this.view?.renderMessages(); this.view?.refreshStatus(); }
  }
  stopAnswer() { this.stopRequested = true; this.organizerAbort?.abort(); this.client?.cancel(); this.view?.refreshStatus(); }
  async handleTool(name: string, args: Record<string, unknown>) {
    if (!this.busy) throw Error('当前没有活动的学习请求');
    this.toolEvents.push(`调用 ${name}${name === 'obsidian_read' ? ' · ' + String(args.path) : name === 'obsidian_search' ? ' · ' + String(args.query) : ''}`);
    this.toolEvents = this.toolEvents.slice(-30); this.view?.refreshTools();
    if (name === 'memory_search' || name === 'memory_read') {
      if(!this.activeMessage || !this.activeRecall || this.stopRequested) throw Error('本轮记忆读取未启用或请求已停止');
      const result=readRecall(this.activeRecall,name,args);
      const length=JSON.stringify(result).length;
      if(this.memoryReadChars+length>24000) throw Error('本轮记忆读取预算已用完');
      this.memoryReadChars+=length;
      this.activeMessage.trace?.push(traceEntry({type:name==='memory_read'?'memory/read':'memory/search',data:result}));
      this.view?.scheduleAnswer();
      return result;
    }
    if(name==='memory_manage') {
      if(!this.activeManager)throw Error('本轮未启用 AI 记忆管理');
      const manager=this.activeManager;
      const result=await manager.execute(args);
      if(this.activeManager===manager) {
        this.activeRecall=prepareRecall(manager.snapshot,'');
        this.activeMessage?.trace?.push(traceEntry({type:'memory/manage',data:{...result,quote:args.quote}}));
        this.view?.scheduleAnswer();
        new Notice('本库记忆已更新；可在 /memory 的维护页撤销最近操作');
      }
      return result;
    }
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
