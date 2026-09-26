import { ItemView, WorkspaceLeaf, MarkdownView, MarkdownRenderer, Notice, TFile, Component, Scope, setIcon, FuzzySuggestModal } from 'obsidian';
import type Deepsidian from './main';
import { VIEW, type Settings } from './types';
import { buildPrompt, EMPTY_CONTEXT } from './context';
import { readAttachment, attachmentText, FILE_ACCEPT, type Attachment } from './attachments';
import { eventTitle, usageSummary, type TraceEntry } from './trace';
import { renderTraceView } from './trace-view';
import { SetupModal } from './setup';
import { compareVersions } from './versions';
import { commandMatches, parseCommand } from './commands';
import { ComposerContextModal } from './learning-modals';
import { SessionHistory } from './history';

export class LearningView extends ItemView {
  private mode: 'chat' | 'trace' = 'chat';
  private reasoningEl?: HTMLElement;
  private reasoningDetails?: HTMLDetailsElement;
  private executionEl?: HTMLElement;
  private executionCount = -1;
  private attachments: Attachment[] = [];
  private attachmentDrafts = new Map<string,Attachment[]>();
  private draftChatId = '';
  private draftTimer?: ReturnType<typeof setTimeout>;
  private submittedAttachments = 0;
  private preparingAttachments = false;
  private attachmentEl!: HTMLElement;
  private modelSelect!: HTMLSelectElement;
  private effortSelect!: HTMLSelectElement;
  private tokenSelect!: HTMLSelectElement;
  private changing = false;
  private messages!: HTMLElement;
  private statusEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private toolsEl!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private commandMenu!: HTMLElement;
  private commandIndex=0;
  private history?: SessionHistory;
  private chatTitle!: HTMLElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private answerEl?: HTMLElement;
  private timer?: ReturnType<typeof setTimeout>;
  private rendering = false;
  private renderAgain = false;
  private markdown = new Component();
  private closed = false;
  private focusCleanup?: () => void;
  hasFocus() { const doc = this.contentEl.ownerDocument; return !this.closed && !this.changing && doc.hasFocus() && this.contentEl.contains(doc.activeElement); }
  refreshConnection() { if (!this.closed && this.statusEl) { this.renderModels(); this.refreshStatus(); this.renderMessages(); } }
  constructor(leaf: WorkspaceLeaf, readonly plugin: Deepsidian) {
    super(leaf);
    // The host handles shortcuts before DOM listeners (notably Cmd+Enter).
    this.scope = new Scope(this.app.scope);
    for (const modifier of ['Meta', 'Ctrl'] as const) this.scope.register([modifier], 'Enter', event => {
      if (event.target !== this.input || event.isComposing) return;
      void this.send();
      return false;
    });
  }
  getViewType() { return VIEW; }
  getDisplayText() { return 'Deepseedian'; }
  getIcon() { return 'deepsidian-whale'; }
  async onOpen() {
    this.closed = false; this.addChild(this.markdown); this.plugin.attach(this);
    const root = this.contentEl; root.empty(); root.addClass('deepsidian'); root.tabIndex = -1;
    const wake = () => { if (this.hasFocus()) this.plugin.sidebarActivated(); };
    root.addEventListener('focusin', wake);
    root.ownerDocument.defaultView?.addEventListener('focus', wake);
    this.focusCleanup = () => { root.removeEventListener('focusin', wake); root.ownerDocument.defaultView?.removeEventListener('focus', wake); };
    const header = root.createDiv('ds-header');
    const brand = header.createDiv('ds-brand'); setIcon(brand.createSpan('ds-brand-icon'), 'deepsidian-whale');
    this.chatTitle = brand.createEl('strong', { cls: 'ds-chat-title', text: '新对话' });
    const actionsHeader = header.createDiv('ds-header-actions');
    const historyButton = this.iconButton(actionsHeader, 'history', 'Session history', () => {});
    this.history = new SessionHistory(header, historyButton,
      () => ({ ...this.plugin.state, busy: this.plugin.busy || this.changing }),
      async id => {
        if (this.plugin.busy || this.changing) return;
        this.changing = true; this.refreshStatus();
        try { await this.plugin.selectChat(id); this.refreshChats(); this.renderMessages(); }
        catch (error) { new Notice(`切换会话保存失败：${String(error)}`); throw error; }
        finally { this.changing = false; this.refreshStatus(); }
      });
    this.iconButton(actionsHeader, 'settings-2', '连接与首次使用引导', () => new SetupModal(this.plugin, () => { this.renderModels(); this.renderMessages(); }).open());
    this.iconButton(actionsHeader, 'plus', '新对话', () => {
      if (!this.changing) void Promise.resolve().then(() => this.plugin.newChat()).catch(error => new Notice(String(error)));
    });
    const tabs = root.createDiv('ds-tabs');
    for (const [mode, label] of [['chat', '对话'], ['trace', '轨迹']] as const) {
      const button = tabs.createEl('button', { text: label, attr: { 'aria-pressed': String(this.mode === mode) } });
      button.onclick = () => { this.mode = mode; for (const item of Array.from(tabs.children)) item.setAttribute('aria-pressed', String(item === button)); this.renderMessages(); };
    }
    this.messages = root.createDiv('ds-messages');
    this.messages.addEventListener('click',event=>{
      const link=(event.target as Element).closest?.('a.internal-link');
      if(!link||!this.messages.contains(link))return;
      const href=link.getAttribute('data-href')??link.getAttribute('href');if(!href)return;
      event.preventDefault();event.stopPropagation();
      const source=link.closest<HTMLElement>('.ds-message')?.dataset.sourcePath??'';
      const index=Number(link.closest<HTMLElement>('.ds-message')?.dataset.messageIndex);
      const expected=Number.isSafeInteger(index)?this.plugin.chat?.messages.slice(0,index+1).reverse().find(m=>m.role==='user')?.source:undefined;
      void this.plugin.openSource(href,source,event.metaKey||event.ctrlKey,expected).catch(error=>new Notice(String(error)));
    },true);
    this.toolsEl = root.createEl('details', { cls: 'ds-tools' });
    const composer = root.createDiv('ds-composer');
    this.contextEl = composer.createDiv('ds-context');
    this.attachmentEl = composer.createDiv('ds-attachments');
    this.commandMenu=composer.createDiv({cls:'ds-command-menu',attr:{role:'listbox','aria-label':'斜杠指令'}});this.commandMenu.hidden=true;
    this.input = composer.createEl('textarea', { attr: { placeholder: '从一个不理解的概念开始…', 'aria-label': '学习问题', rows: '3' } });
    this.input.addEventListener('input',()=>{this.commandIndex=0;this.renderCommands();this.saveDraftText();});
    this.input.addEventListener('keydown', event => {
      if(event.defaultPrevented || event.isComposing)return;
      const matches=commandMatches(this.input.value);
      if(!this.commandMenu.hidden && matches.length){
        if(event.key==='Escape'){event.preventDefault();this.commandMenu.hidden=true;this.input.removeAttribute('aria-activedescendant');return;}
        if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();this.commandIndex=(this.commandIndex+(event.key==='ArrowDown'?1:-1)+matches.length)%matches.length;this.renderCommands();return;}
        if((event.key==='Enter'&&!event.ctrlKey&&!event.metaKey)||event.key==='Tab'){event.preventDefault();this.chooseCommand(matches[this.commandIndex]!.name);return;}
      }
      if(event.key==='Enter'&&!event.shiftKey&&this.input.value.trim().startsWith('/')){event.preventDefault();void this.send();return;}
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void this.send(); }
    });
    this.input.addEventListener('paste', event => { const files = Array.from(event.clipboardData?.files ?? []); if (files.length) { event.preventDefault(); void this.addFiles(files); } });
    const actions = composer.createDiv('ds-toolbar ds-compose-actions');
    const picker = composer.createEl('input', { attr: { type: 'file', accept: FILE_ACCEPT, multiple: '', hidden: '' } });
    picker.onchange = () => { void this.addFiles(Array.from(picker.files ?? []),pickerChatId); picker.value = ''; };
    let pickerChatId:string|undefined;
    this.iconButton(actions, 'paperclip', '附加文件或截图', () => {pickerChatId=this.plugin.chat?.id;picker.click();});
    this.iconButton(actions, 'files', '选择库内文件', () => {
      const chatId=this.plugin.chat?.id;
      new VaultPicker(this.app, file => { void this.addVaultFile(file,chatId).catch(error=>new Notice(String(error))); }).open();
    });
    this.iconButton(actions, 'text-cursor-input', '使用当前选区', () => { if(this.plugin.busy){new Notice('请等待当前操作结束');return;}this.plugin.clearPinnedContext(); this.plugin.includeContext = true; this.plugin.capture(); this.refreshContext(); });
    this.iconButton(actions, 'list-checks', '查看下次发送的上下文', () => { this.plugin.capture();this.refreshContext();new ComposerContextModal(this.plugin,this).open(); });
    this.modelSelect = actions.createEl('select', { cls: 'ds-model', attr: { 'aria-label': '模型' } });
    this.modelSelect.onchange = () => { const [provider, model] = this.modelSelect.value.split('\n'); void this.changeRoute({ provider, model, reasoningEffort: '' }); };
    this.iconButton(actions, 'refresh-cw', '刷新 DSH 模型列表（不发起对话）', () => void this.loadModels());
    this.sendButton = this.iconButton(actions, 'arrow-up', '发送 · Ctrl/⌘ Enter', () => void this.send()); this.sendButton.addClass('mod-cta');
    this.stopButton = this.iconButton(actions, 'square', '停止回答', () => this.plugin.stopAnswer());
    const parameters = composer.createEl('details', { cls: 'ds-parameters' }); parameters.createEl('summary', { text: '生成参数' });
    const params = parameters.createDiv('ds-toolbar');
    params.createSpan({ text: '思考强度' }); this.effortSelect = params.createEl('select', { attr: { 'aria-label': '思考强度' } });
    this.effortSelect.onchange = () => void this.changeRoute({ reasoningEffort: this.effortSelect.value });
    params.createSpan({ text: '输出上限' }); this.tokenSelect = params.createEl('select', { attr: { 'aria-label': '最大输出 token' } });
    for (const n of [1024,2048,4096,8192,16384]) this.tokenSelect.createEl('option', { text: `${n} tokens`, value: String(n) });
    this.tokenSelect.value = String(this.plugin.state.settings.maxTokens);
    this.tokenSelect.onchange = () => void this.changeRoute({ maxTokens: Number(this.tokenSelect.value) });
    parameters.createDiv({ cls: 'ds-muted', text: '下次发送生效，保留当前会话。输出上限不是目标字数。' });
    this.statusEl = root.createDiv('ds-status');
    this.plugin.capture(); this.refreshChats(); this.refreshContext(); this.refreshStatus(); this.renderMessages(); this.renderModels();
  }
  setQuestion(text: string) { this.input.value = text; this.saveDraftText(); this.input.focus(); this.refreshContext(); this.renderCommands(); }
  private saveDraftText() {
    if(!this.draftChatId)return;
    this.plugin.setDraftText(this.draftChatId,this.input.value);
    clearTimeout(this.draftTimer);
    this.draftTimer=setTimeout(()=>{void this.plugin.persist().catch(()=>new Notice('草稿保存失败；当前文字仍保留，请重试或复制备份'));},350);
  }
  pendingFiles(){return [...this.attachments];}
  removePendingFile(id:string){if(this.preparingAttachments||this.plugin.busy)throw Error('请等待当前操作结束');this.attachments=this.attachments.filter(a=>a.id!==id);this.renderAttachments();}
  removeCurrentContext(){if(this.plugin.busy)throw Error('请等待当前操作结束');this.plugin.clearPinnedContext();this.plugin.includeContext=false;this.plugin.source={...EMPTY_CONTEXT};this.refreshContext();}
  private chooseCommand(name:string){this.input.value=`/${name} `;this.saveDraftText();this.commandMenu.hidden=true;this.input.removeAttribute('aria-activedescendant');this.input.focus();}
  private renderCommands(){
    const matches=commandMatches(this.input.value);this.commandMenu.empty();this.commandMenu.hidden=!matches.length;
    this.input.removeAttribute('aria-activedescendant');
    matches.forEach((c,i)=>{
      const row=this.commandMenu.createEl('button',{cls:'ds-command-option',attr:{role:'option','aria-selected':String(i===this.commandIndex),id:`ds-command-${i}`,type:'button'}});
      row.createEl('strong',{text:`/${c.name} ${c.hint}`});row.createEl('small',{text:c.description});
      row.onmousedown=e=>e.preventDefault();row.onclick=()=>this.chooseCommand(c.name);
    });
    if(matches.length){this.input.setAttribute('aria-activedescendant',`ds-command-${this.commandIndex}`);this.commandMenu.children[this.commandIndex]?.scrollIntoView({block:'nearest'});}
  }
  private iconButton(parent: HTMLElement, icon: string, label: string, action: () => void) {
    // Obsidian uses aria-label for its tooltip; native title produced a second one.
    const button = parent.createEl('button', { cls: 'ds-icon', attr: { 'aria-label': label } });
    setIcon(button, icon); button.onclick = action; return button;
  }
  private async addVaultFile(file:TFile,chatId:string|undefined) {
    await this.addFiles([{name:file.path,size:file.stat.size,arrayBuffer:()=>this.app.vault.readBinary(file)}],chatId);
  }
  private async addFiles(files: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }[], chatId=this.plugin.chat?.id) {
    if(this.closed)return;
    if(this.preparingAttachments){new Notice('正在准备发送，请稍后添加附件');return;}
    for (const file of files) {
      if(chatId!==this.plugin.chat?.id){new Notice('会话已切换，请在目标会话重新添加附件');break;}
      if (this.attachments.length + this.submittedAttachments >= 4) { new Notice('最多 4 个附件；正在发送的附件暂时保留名额，以便失败时恢复'); break; }
      try {
        const attachment = await readAttachment(file);
        if(this.closed)return;
        if(chatId!==this.plugin.chat?.id){new Notice('会话已切换，请在目标会话重新添加附件');break;}
        if(!this.preparingAttachments && this.attachments.length + this.submittedAttachments < 4)this.attachments.push(attachment);
      }
      catch (error) { new Notice(String(error)); }
    }
    this.renderAttachments();
  }
  private renderAttachments() {
    if (this.closed) return;
    this.attachmentEl.empty();
    for (const file of this.attachments) {
      const chip = this.attachmentEl.createDiv('ds-attachment');
      if (file.image) chip.createEl('img', { attr: { src: `data:${file.image.mimeType};base64,${file.image.data}`, alt: file.name } });
      chip.createSpan({ text: file.name });
      if(file.text!==undefined){const detail=chip.createEl('details');detail.createEl('summary',{text:`预览 · ${file.text.length} 字符`});detail.createEl('pre',{text:file.text,cls:'ds-proposal-text'});}
      const remove=this.iconButton(chip, 'x', `移除 ${file.name}`, () => { if(this.preparingAttachments)return;this.attachments = this.attachments.filter(f => f.id !== file.id); this.renderAttachments(); });
      remove.disabled=this.preparingAttachments;
    }
  }
  sourceSummary(){return this.attachments.map(file=>({name:file.name,text:file.text??''}));}
  attachSource(name:string,text:string){
    if(this.closed||this.preparingAttachments)throw Error('侧栏已关闭或正在准备发送');
    if(this.attachments.length+this.submittedAttachments>=4)throw Error('最多4个附件，请先移除部分来源');
    if(!text||text.length>6000)throw Error('片段须为1–6000字符');
    if(this.attachments.some(a=>a.name===name&&a.text===text))throw Error('已附加相同片段');
    this.attachments.push({id:crypto.randomUUID(),name,text});this.renderAttachments();
  }
  private async loadModels() {
    if (this.changing || this.plugin.busy) return;
    try { const client = await this.plugin.connect(); this.plugin.models = await client.models(); if (!this.closed) this.renderModels(); }
    catch (error) { if (!this.closed) new Notice(`读取模型列表失败：${String(error)}`); }
  }
  private renderModels() {
    const settings = this.plugin.state.settings;
    if (!settings.provider && !this.plugin.selectedRoute && !this.plugin.models.length) {
      this.modelSelect.empty(); this.modelSelect.createEl('option', { text: 'DSH 默认 · 尚未连接', value: '' });
      this.effortSelect.empty(); this.effortSelect.createEl('option', { text: 'DSH 默认', value: '' }); return;
    }
    const env = { model: settings.provider ? { provider: settings.provider, model: settings.model } : this.plugin.selectedRoute ?? this.plugin.models[0]! };
    const current = `${env.model.provider}\n${env.model.model}`;
    this.modelSelect.empty();
    const choices = [...this.plugin.models];
    if (!choices.some(m => `${m.provider}\n${m.model}` === current)) choices.unshift(env.model);
    for (const model of choices) this.modelSelect.createEl('option', { text: `${model.name ?? model.model}${model.inputModalities?.includes('image') ? ' · 图片' : ''} (${model.provider})`, value: `${model.provider}\n${model.model}` });
    this.modelSelect.value = current;
    const selected = choices.find(m => `${m.provider}\n${m.model}` === current);
    this.effortSelect.empty(); this.effortSelect.createEl('option', { text: 'DSH 默认', value: '' });
    for (const effort of selected?.reasoning?.efforts ?? []) this.effortSelect.createEl('option', { text: effort.name, value: effort.id });
    this.effortSelect.value = this.plugin.state.settings.reasoningEffort;
  }
  private async changeRoute(change: Partial<Settings>) {
    if (this.plugin.busy || this.changing) return;
    this.changing = true; this.refreshStatus();
    try { await this.plugin.disconnect(); Object.assign(this.plugin.state.settings, change); await this.plugin.persist(); this.renderModels(); }
    catch (error) { new Notice(String(error)); }
    finally { this.changing = false; this.refreshStatus(); }
  }
  private async send() {
    let text = this.input.value.trim() || (this.attachments.length ? '请结合这些资料解释我需要理解的重点。' : '');
    if (!text || this.plugin.busy || this.changing) return;
    if(text.startsWith('/')){
      if((this.attachments.length) && !['plan','context'].includes(parseCommand(text)?.name??'')){new Notice('此指令不接收附件，请先移除附件；草稿已保留');return;}
      const commandChatId=this.plugin.chat!.id,commandDraft=this.input.value;
      this.changing=true;this.refreshStatus();
      try {
        const result=await this.plugin.runCommand(text);
        if(!result.question){
          const original=this.plugin.state.chats.find(c=>c.id===commandChatId);
          if(original?.draft?.text===commandDraft)this.plugin.setDraftText(commandChatId,'');
          if(this.plugin.chat?.id===commandChatId && this.input.value===commandDraft)this.input.value='';
          await this.plugin.persist();this.commandMenu.hidden=true;return;
        }
        text=result.question;
      } catch(error){new Notice(String(error));return;}
      finally{this.changing=false;this.refreshStatus();}
    }
    this.plugin.capture();
    const promptQuestion=this.plugin.chat?.goal?`本会话目标：${this.plugin.chat.goal}\n\n本次问题：${text}`:text;
    if ((buildPrompt(promptQuestion, '', this.plugin.source) + attachmentText(this.attachments)).length > 40000) { new Notice('上下文超过 40000 字符，请减少附件或选区。'); return; }
    let env; try { env = this.plugin.resolveEnvironment(); } catch { new SetupModal(this.plugin).open(); return; }
    if (this.attachments.some(f => f.image) && !this.plugin.models.find(m => m.provider === env.model.provider && m.model === env.model.model)?.inputModalities?.includes('image')) { new Notice('当前模型未声明图片输入能力，请刷新列表并选择标注“图片”的模型。附件已保留。'); return; }
    const files = [...this.attachments], draft = this.input.value;
    let submitted = false;
    this.preparingAttachments=true;this.renderAttachments();
    try {await this.plugin.ask(text, files, () => {
        submitted = true;
        this.submittedAttachments = files.length;
        this.preparingAttachments=false;
      this.attachments = this.attachments.filter(file => !files.includes(file));
      if (this.input.value === draft) this.input.value = '';
      this.saveDraftText();
      this.commandMenu.hidden = true; this.renderAttachments();
      });
      if (submitted && this.plugin.chat?.messages.at(-1)?.status === '失败') { this.attachments.push(...files); this.renderAttachments(); }
    } finally {this.preparingAttachments=false;this.submittedAttachments=0;this.renderAttachments();}
  }
  refreshChats() {
    const id=this.plugin.chat?.id??'';
    if(this.input && id!==this.draftChatId){
      if(this.draftChatId)this.attachmentDrafts.set(this.draftChatId,this.attachments);
      this.attachments=this.attachmentDrafts.get(id)??[];this.draftChatId=id;
      this.input.value=this.plugin.chat?.draft?.text??'';this.renderAttachments();this.renderCommands();
    }

    if (this.chatTitle) this.chatTitle.setText(this.plugin.chat?.title || '新对话');
    this.history?.refresh();
  }
  refreshContext() {
    if (!this.contextEl) return;
    this.contextEl.empty(); this.contextEl.hidden = !this.plugin.source.path;
    if (!this.plugin.source.path) return;
    const chip = this.contextEl.createDiv('ds-file-chip');
    const file = this.iconButton(chip, 'file-text', this.plugin.source.path, () => {
      const detail = this.contextEl.querySelector('pre'); if (detail) detail.toggleAttribute('hidden');
    });
    file.setAttribute('aria-label',`查看本次编辑上下文：${this.plugin.source.path}`);
    chip.createSpan({ text: this.plugin.source.path.split('/').pop() ?? this.plugin.source.path, attr: { title: this.plugin.source.path } });
    this.iconButton(chip, 'x', '移除当前文件', () => { try{this.removeCurrentContext();}catch(error){new Notice(String(error));} });
    const source=this.plugin.source;
    if(source.pinned)chip.createSpan({text:`选区快照${source.startLine?' · 行 '+source.startLine+'–'+source.endLine:''}`,cls:'ds-muted'});
    this.contextEl.createEl('pre', { text: [source.heading?'标题：'+source.heading:'',source.selection,source.nearby,source.truncated?'片段已截断':''].filter(Boolean).join('\n\n'), attr: { hidden: '' } });
  }
  refreshStatus() {
    if (!this.statusEl) return;
    const update = this.plugin.state.updates;
    this.statusEl.setText(this.plugin.creatingFork ? '正在保存分支…' : this.plugin.creatingChat ? '正在保存新会话…' : this.plugin.busy ? this.plugin.stopRequested ? '正在停止当前回答…' : 'DSH 正在处理 · 可随时停止' : this.plugin.status);
    if (update?.error) this.statusEl.createEl('span', { text: ' · 更新检查暂不可用' });
    if (update?.newest && this.plugin.runtimeVersion && compareVersions(update.newest, this.plugin.runtimeVersion) > 0) this.statusEl.createEl('span', { text: ` · 可更新 DSH ${update.newest}` });
    for (const button of this.messages.querySelectorAll<HTMLButtonElement>('button[data-ds-branch-available]')) button.disabled = this.plugin.busy || this.changing || button.dataset.dsBranchAvailable !== 'true';
    this.sendButton.disabled = this.plugin.busy || this.changing; this.sendButton.hidden = this.plugin.busy; this.stopButton.hidden = !this.plugin.busy || this.plugin.creatingChat || this.plugin.creatingFork; for (const control of [this.modelSelect, this.effortSelect, this.tokenSelect]) if (control) control.disabled = this.plugin.busy || this.changing; this.stopButton.disabled = !this.plugin.busy || this.plugin.stopRequested || this.plugin.creatingChat || this.plugin.creatingFork; this.history?.refresh();
  }
  refreshTools() { if (!this.toolsEl) return; this.toolsEl.empty(); this.toolsEl.hidden = true; this.toolsEl.createEl('summary', { text: `运行记录（${this.plugin.toolEvents.length}）` }); this.toolsEl.createEl('pre', { text: this.plugin.toolEvents.join('\n') }); }
  renderMessages() {
    if (this.closed || !this.messages) return;
    this.markdown.unload(); this.markdown.load(); this.messages.empty(); this.answerEl = undefined;
    this.reasoningEl = undefined; this.executionEl = undefined; this.reasoningDetails = undefined; this.executionCount = -1;
    const chat = this.plugin.chat;
    if (!this.plugin.state.settings.setupComplete && !this.plugin.selectedRoute) {
      const onboarding = this.messages.createDiv('ds-onboarding');
      onboarding.createEl('strong', { text: '连接本地 DeepSeek Harness' });
      onboarding.createEl('p', { text: this.plugin.state.settings.autoConnect ? '将自动连接本机 DSH；若无法连接，可打开引导检查安装和模型配置。' : '自动连接已关闭。发送消息时连接，也可打开引导检查安装和模型配置。' });
      onboarding.createEl('button', { text: '开始设置', cls: 'mod-cta' }).onclick = () => new SetupModal(this.plugin, () => { this.renderModels(); this.renderMessages(); }).open();
    }
    if (this.mode === 'trace') { this.renderTrace(); return; }
    if (chat?.fork) {
      const origin = this.messages.createDiv('ds-branch-origin');
      origin.createSpan({ text: `分支自：${chat.fork.parentTitle} · 第 ${Math.floor(chat.fork.messageIndex / 2) + 1} 次回答` });
      const back = origin.createEl('button', { text: '返回原对话' });
      back.dataset.dsBranchAvailable = String(this.plugin.state.chats.some(c => c.id === chat.fork!.parentId));
      back.disabled = this.plugin.busy || this.changing || !this.plugin.state.chats.some(c => c.id === chat.fork!.parentId);
      back.onclick = () => {
        if (this.changing || this.plugin.busy) return;
        this.changing = true;
        void this.plugin.selectChat(chat.fork!.parentId).then(() => { this.refreshChats(); this.renderMessages(); })
          .catch(error => new Notice(String(error))).finally(() => { this.changing = false; this.renderMessages(); this.refreshStatus(); });
      };
    }
    if (chat?.systemPrompt) { const system = this.messages.createEl('details', { cls: 'ds-system' }); system.createEl('summary', { text: '系统提示词 · DSH 实际组装结果' }); system.createEl('pre', { text: chat.systemPrompt }); }
    if (!chat?.messages.length) { const empty = this.messages.createDiv('ds-empty'); setIcon(empty.createDiv('ds-empty-icon'), 'deepsidian-whale'); empty.createEl('h2', { text: '今天想理解什么？' }); empty.createEl('p', { text: '结合当前笔记，逐步展开解释。' }); empty.createEl('small', { text: '选中术语带入上下文，或附上资料开始提问。' }); return; }
    let sourcePath='';
    for (const [messageIndex, message] of chat.messages.entries()) {
      if(message.role==='user')sourcePath=message.source?.path??'';
      const card = this.messages.createDiv(`ds-message ds-${message.role}`);
      card.dataset.sourcePath=sourcePath;card.dataset.messageIndex=String(messageIndex);
      card.createDiv({ cls: 'ds-label', text: message.role === 'user' ? '你' : `Deepseedian${message.model ? ' · ' + message.model : ''}${message.status ? ' · ' + message.status : ''}` });
      if (message.source?.path) card.createEl('button', { cls: 'ds-source', text: message.source.path }).onclick = () => { void this.plugin.openSource(message.source!.path,'',false,message.source).catch(error=>new Notice(String(error))); };
      if(message.manifest){
        const manifest=message.manifest,detail=card.createEl('details',{cls:'ds-context-manifest'});
        detail.createEl('summary',{text:'发送时上下文清单'});
        detail.createEl('p',{text:`初始用户请求 ${manifest.promptChars} 字符（含本轮记忆提示）；另有 ${manifest.historyMessages} 条界面历史。系统提示词、历史和后续工具输出不计入此字符数。记忆读取${manifest.memoryEnabled?'开启':'关闭'}。`});
        for(const item of manifest.items)detail.createEl('p',{text:`${item.label} · ${item.chars!==undefined?item.chars+' 字符':item.bytes+' 字节'} · SHA-256 ${item.hash.slice(0,12)}`});
      }
      if (message.attachments?.length) card.createDiv({ cls: 'ds-muted', text: '附件 · ' + message.attachments.join(' · ') });
      if (message.role === 'assistant') {
        const work = card.createEl('details', { cls: 'ds-work' });
        work.createEl('summary', { text: message.status === '生成中' ? '正在处理…' : `${message.elapsedMs === undefined ? '旧版未记录耗时' : '用时 ' + Math.max(1, Math.round(message.elapsedMs / 1000)) + ' 秒'} · 运行过程` });
        const reasoning = work.createEl('details', { cls: 'ds-reasoning' });
        reasoning.createEl('summary', { text: '思考 · 模型返回的 reasoning' });
        const reasoningBody = reasoning.createEl('pre', { text: message.reasoning || '本次尚无 reasoning 输出。' });
        const execution = work.createDiv('ds-execution');
        this.fillExecution(execution, message.trace ?? []);
        if (message === chat?.messages.at(-1)) { this.reasoningEl = reasoningBody; this.reasoningDetails = work; this.executionEl = execution; this.executionCount = message.trace?.length ?? 0; }
      }
      const body = card.createDiv('ds-body');body.dataset.sourcePath=sourcePath;
      if (message.role === 'user') body.setText(message.text);
      else {
        void MarkdownRenderer.render(this.app, message.text, body, sourcePath, this.markdown);
        this.answerEl = body;
        card.createDiv({ cls: 'ds-usage ds-muted', text: usageSummary(message.trace ?? []) });
        if (message.status === '完成') {
          const actions = card.createDiv('ds-message-actions');
          const available = Number.isSafeInteger(message.forkSeq) && message.forkSeq! >= 0;
          const button = this.iconButton(actions, 'git-fork', available ? '分支到新聊天' : '此旧回答未记录分支位置，请从新回答创建分支', () => {
            if (this.plugin.busy || this.changing) return;
            this.changing = true;
            void this.plugin.forkChat(messageIndex).catch(error => new Notice(`分支未创建：${String(error)}`))
              .finally(() => { this.changing = false; this.renderMessages(); this.refreshStatus(); });
          });
          button.dataset.dsBranchAvailable = String(available);
          button.disabled = !available || this.plugin.busy || this.changing;
        }

      }
    }
    this.refreshTools(); this.messages.scrollTop = this.messages.scrollHeight;
  }
  private fillExecution(target: HTMLElement, entries: TraceEntry[]) {
    const open = new Set(Array.from(target.querySelectorAll('details[open]')).map(el => el.getAttribute('data-event')));
    target.empty();
    for (const [i, event] of entries.entries()) {
      if (!['tool/call', 'tool/result', 'step/start', 'assistant/message'].includes(event.type)) continue;
      const detail = target.createEl('details', { cls: 'ds-event', attr: { 'data-event': String(i) } });
      detail.open = open.has(String(i));
      detail.createEl('summary', { text: `${eventTitle(event)} · ${new Date(event.at).toLocaleTimeString()}` });
      detail.createEl('pre', { text: event.detail });
    }
  }
  private renderTrace() {
    if (!this.messages || this.closed) return;
    renderTraceView(this.messages, this.plugin.chat, this.plugin.busy);
  }
  scheduleAnswer() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.renderAnswer(); }, 80);
  }
  private async renderAnswer() {
    if (this.rendering) { this.renderAgain = true; return; }
    if (this.mode === 'trace') { this.renderTrace(); return; }
    const message = this.plugin.chat?.messages.at(-1), target = this.answerEl;
    if (message && this.reasoningEl) this.reasoningEl.setText(message.reasoning || '本次尚无 reasoning 输出。');
    if (message && this.executionEl && this.executionCount !== (message.trace?.length ?? 0)) { this.fillExecution(this.executionEl, message.trace ?? []); this.executionCount = message.trace?.length ?? 0; }
    if (!target || !message || this.closed) return;
    this.rendering = true;
    const follow = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 90;
    try { target.empty(); await MarkdownRenderer.render(this.app, message.text, target, target.dataset.sourcePath??'', this.markdown); if (follow) this.messages.scrollTop = this.messages.scrollHeight; }
    finally { this.rendering = false; if (this.renderAgain) { this.renderAgain = false; this.scheduleAnswer(); } }
  }
  async onClose() { this.closed = true; clearTimeout(this.draftTimer); this.focusCleanup?.(); this.history?.dispose(); clearTimeout(this.timer); this.plugin.detach(this); this.markdown.unload(); await this.plugin.persist().catch(()=>new Notice('草稿保存失败')); }
}

class VaultPicker extends FuzzySuggestModal<TFile> {
  constructor(app: Deepsidian['app'], private choose: (file: TFile) => void) { super(app); this.setPlaceholder('搜索并附加笔记或图片'); }
  getItems() { return this.app.vault.getFiles().filter(f => FILE_ACCEPT.split(',').includes('.' + f.extension.toLowerCase())); }
  getItemText(file: TFile) { return file.path; }
  onChooseItem(file: TFile) { this.choose(file); }
}
