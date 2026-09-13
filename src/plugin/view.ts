import { ItemView, WorkspaceLeaf, MarkdownView, MarkdownRenderer, Notice, TFile, Component, setIcon, FuzzySuggestModal } from 'obsidian';
import type Deepsidian from './main';
import { VIEW, type Settings } from './types';
import { buildPrompt, EMPTY_CONTEXT } from './context';
import { readAttachment, attachmentText, FILE_ACCEPT, type Attachment } from './attachments';
import { eventTitle, usageSummary, type TraceEntry } from './trace';
import { renderTraceView } from './trace-view';
import { SetupModal } from './setup';
import { compareVersions } from './versions';

export class LearningView extends ItemView {
  private mode: 'chat' | 'trace' = 'chat';
  private reasoningEl?: HTMLElement;
  private reasoningDetails?: HTMLDetailsElement;
  private executionEl?: HTMLElement;
  private executionCount = -1;
  private attachments: Attachment[] = [];
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
  private chats!: HTMLSelectElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private answerEl?: HTMLElement;
  private timer?: ReturnType<typeof setTimeout>;
  private rendering = false;
  private renderAgain = false;
  private markdown = new Component();
  private closed = false;
  constructor(leaf: WorkspaceLeaf, readonly plugin: Deepsidian) { super(leaf); }
  getViewType() { return VIEW; }
  getDisplayText() { return 'Deepsidian'; }
  getIcon() { return 'deepsidian-whale'; }
  async onOpen() {
    this.closed = false; this.addChild(this.markdown); this.plugin.attach(this);
    const root = this.contentEl; root.empty(); root.addClass('deepsidian');
    const header = root.createDiv('ds-header');
    const brand = header.createDiv('ds-brand'); setIcon(brand.createSpan('ds-brand-icon'), 'deepsidian-whale');
    brand.createEl('strong', { text: 'Deepsidian' });
    this.iconButton(header, 'settings-2', '连接与首次使用引导', () => new SetupModal(this.plugin, () => { this.renderModels(); this.renderMessages(); }).open());
    this.iconButton(header, 'plus', '新对话', () => this.plugin.newChat());
    const toolbar = root.createDiv('ds-toolbar ds-history');
    this.chats = toolbar.createEl('select'); this.chats.ariaLabel = '历史对话';
    this.chats.onchange = () => { if (this.plugin.busy) return; this.plugin.state.activeId = this.chats.value; void this.plugin.persist(); this.renderMessages(); };
    const tabs = root.createDiv('ds-tabs');
    for (const [mode, label] of [['chat', '对话'], ['trace', '轨迹']] as const) {
      const button = tabs.createEl('button', { text: label, attr: { 'aria-pressed': String(this.mode === mode) } });
      button.onclick = () => { this.mode = mode; for (const item of Array.from(tabs.children)) item.setAttribute('aria-pressed', String(item === button)); this.renderMessages(); };
    }
    this.messages = root.createDiv('ds-messages');
    this.toolsEl = root.createEl('details', { cls: 'ds-tools' });
    const composer = root.createDiv('ds-composer');
    this.contextEl = composer.createDiv('ds-context');
    this.attachmentEl = composer.createDiv('ds-attachments');
    this.input = composer.createEl('textarea', { attr: { placeholder: '从一个不理解的概念开始…', 'aria-label': '学习问题', rows: '3' } });
    this.input.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void this.send(); } });
    this.input.addEventListener('paste', event => { const files = Array.from(event.clipboardData?.files ?? []); if (files.length) { event.preventDefault(); void this.addFiles(files); } });
    const actions = composer.createDiv('ds-toolbar ds-compose-actions');
    const picker = composer.createEl('input', { attr: { type: 'file', accept: FILE_ACCEPT, multiple: '', hidden: '' } });
    picker.onchange = () => { void this.addFiles(Array.from(picker.files ?? [])); picker.value = ''; };
    this.iconButton(actions, 'paperclip', '附加文件或截图', () => picker.click());
    this.iconButton(actions, 'files', '选择库内文件', () => new VaultPicker(this.app, file => {
      if (file.stat.size > 5 * 1024 * 1024) { new Notice('附件超过 5MB'); return; }
      void this.app.vault.readBinary(file).then(data => this.addFiles([{ name: file.path, size: file.stat.size, arrayBuffer: async () => data }])).catch(error => new Notice(String(error)));
    }).open());
    this.iconButton(actions, 'text-cursor-input', '使用当前选区', () => { this.plugin.includeContext = true; this.plugin.capture(); this.refreshContext(); });
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
  setQuestion(text: string) { this.input.value = text; this.input.focus(); this.refreshContext(); }
  private iconButton(parent: HTMLElement, icon: string, label: string, action: () => void) {
    const button = parent.createEl('button', { cls: 'ds-icon', attr: { 'aria-label': label, title: label } });
    setIcon(button, icon); button.onclick = action; return button;
  }
  private async addFiles(files: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }[]) {
    for (const file of files) {
      if (this.attachments.length >= 4) { new Notice('每次最多附加 4 个文件'); break; }
      try { const attachment = await readAttachment(file); if (this.attachments.length < 4) this.attachments.push(attachment); }
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
      this.iconButton(chip, 'x', `移除 ${file.name}`, () => { this.attachments = this.attachments.filter(f => f.id !== file.id); this.renderAttachments(); });
    }
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
    const text = this.input.value.trim() || (this.attachments.length ? '请结合这些资料解释我需要理解的重点。' : '');
    if (!text || this.plugin.busy || this.changing) return;
    this.plugin.capture();
    if ((buildPrompt(text, '', this.plugin.source) + attachmentText(this.attachments)).length > 40000) { new Notice('上下文超过 40000 字符，请减少附件或选区。'); return; }
    let env; try { env = this.plugin.resolveEnvironment(); } catch { new SetupModal(this.plugin).open(); return; }
    if (this.attachments.some(f => f.image) && !this.plugin.models.find(m => m.provider === env.model.provider && m.model === env.model.model)?.inputModalities?.includes('image')) { new Notice('当前模型未声明图片输入能力，请刷新列表并选择标注“图片”的模型。附件已保留。'); return; }
    const files = this.attachments; this.attachments = []; this.input.value = ''; this.renderAttachments();
    await this.plugin.ask(text, files);
    if (this.plugin.chat?.messages.at(-1)?.status === '失败') { this.attachments.push(...files); this.renderAttachments(); }
  }
  refreshChats() {
    if (!this.chats) return;
    this.chats.empty(); for (const chat of this.plugin.state.chats) this.chats.createEl('option', { text: chat.title, value: chat.id });
    this.chats.value = this.plugin.state.activeId; this.chats.disabled = this.plugin.busy;
  }
  refreshContext() {
    if (!this.contextEl) return;
    this.contextEl.empty(); this.contextEl.hidden = !this.plugin.source.path;
    if (!this.plugin.source.path) return;
    const chip = this.contextEl.createDiv('ds-file-chip');
    const file = this.iconButton(chip, 'file-text', this.plugin.source.path, () => {
      const detail = this.contextEl.querySelector('pre'); if (detail) detail.toggleAttribute('hidden');
    });
    file.title = '查看本次编辑上下文';
    chip.createSpan({ text: this.plugin.source.path.split('/').pop() ?? this.plugin.source.path, attr: { title: this.plugin.source.path } });
    this.iconButton(chip, 'x', '移除当前文件', () => { this.plugin.includeContext = false; this.plugin.source = { ...EMPTY_CONTEXT }; this.refreshContext(); });
    this.contextEl.createEl('pre', { text: this.plugin.source.selection || this.plugin.source.nearby, attr: { hidden: '' } });
  }
  refreshStatus() {
    if (!this.statusEl) return;
    const update = this.plugin.state.updates;
    this.statusEl.setText(this.plugin.busy ? this.plugin.stopRequested ? '正在停止当前回答…' : 'DSH 正在处理 · 可随时停止' : this.plugin.status);
    if (update?.error) this.statusEl.createEl('span', { text: ' · 更新检查暂不可用' });
    if (update?.newest && this.plugin.runtimeVersion && compareVersions(update.newest, this.plugin.runtimeVersion) > 0) this.statusEl.createEl('span', { text: ` · 可更新 DSH ${update.newest}` });
    this.sendButton.disabled = this.plugin.busy || this.changing; this.sendButton.hidden = this.plugin.busy; this.stopButton.hidden = !this.plugin.busy; for (const control of [this.modelSelect, this.effortSelect, this.tokenSelect]) if (control) control.disabled = this.plugin.busy || this.changing; this.stopButton.disabled = !this.plugin.busy || this.plugin.stopRequested; this.chats.disabled = this.plugin.busy;
  }
  refreshTools() { if (!this.toolsEl) return; this.toolsEl.empty(); this.toolsEl.hidden = true; this.toolsEl.createEl('summary', { text: `运行记录（${this.plugin.toolEvents.length}）` }); this.toolsEl.createEl('pre', { text: this.plugin.toolEvents.join('\n') }); }
  renderMessages() {
    if (this.closed || !this.messages) return;
    this.markdown.unload(); this.markdown.load(); this.messages.empty(); this.answerEl = undefined;
    this.reasoningEl = undefined; this.executionEl = undefined; this.reasoningDetails = undefined; this.executionCount = -1;
    const chat = this.plugin.chat;
    if (!this.plugin.state.settings.setupComplete) {
      const onboarding = this.messages.createDiv('ds-onboarding');
      onboarding.createEl('strong', { text: '连接本地 DeepSeek Harness' });
      onboarding.createEl('p', { text: '安装运行时 → 配置模型 → 检查连接。打开侧栏不会自动启动运行时。' });
      onboarding.createEl('button', { text: '开始设置', cls: 'mod-cta' }).onclick = () => new SetupModal(this.plugin, () => { this.renderModels(); this.renderMessages(); }).open();
    }
    if (this.mode === 'trace') { this.renderTrace(); return; }
    if (chat?.systemPrompt) { const system = this.messages.createEl('details', { cls: 'ds-system' }); system.createEl('summary', { text: '系统提示词 · DSH 实际组装结果' }); system.createEl('pre', { text: chat.systemPrompt }); }
    if (!chat?.messages.length) { const empty = this.messages.createDiv('ds-empty'); setIcon(empty.createDiv('ds-empty-icon'), 'deepsidian-whale'); empty.createEl('h2', { text: '今天想理解什么？' }); empty.createEl('p', { text: '结合当前笔记，逐步展开解释。' }); empty.createEl('small', { text: '选中术语带入上下文，或附上资料开始提问。' }); return; }
    for (const message of chat.messages) {
      const card = this.messages.createDiv(`ds-message ds-${message.role}`);
      card.createDiv({ cls: 'ds-label', text: message.role === 'user' ? '你' : `Deepsidian${message.model ? ' · ' + message.model : ''}${message.status ? ' · ' + message.status : ''}` });
      if (message.source?.path) card.createEl('button', { cls: 'ds-source', text: message.source.path }).onclick = () => { void this.plugin.app.workspace.openLinkText(message.source!.path, '', false); };
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
      const body = card.createDiv('ds-body');
      if (message.role === 'user') body.setText(message.text);
      else {
        void MarkdownRenderer.render(this.app, message.text, body, message.source?.path ?? '', this.markdown);
        this.answerEl = body;
        card.createDiv({ cls: 'ds-usage ds-muted', text: usageSummary(message.trace ?? []) });

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
    try { target.empty(); await MarkdownRenderer.render(this.app, message.text, target, '', this.markdown); if (follow) this.messages.scrollTop = this.messages.scrollHeight; }
    finally { this.rendering = false; if (this.renderAgain) { this.renderAgain = false; this.scheduleAnswer(); } }
  }
  async onClose() { this.closed = true; clearTimeout(this.timer); this.plugin.detach(this); this.markdown.unload(); }
}

class VaultPicker extends FuzzySuggestModal<TFile> {
  constructor(app: Deepsidian['app'], private choose: (file: TFile) => void) { super(app); this.setPlaceholder('搜索并附加笔记或图片'); }
  getItems() { return this.app.vault.getFiles().filter(f => FILE_ACCEPT.split(',').includes('.' + f.extension.toLowerCase())); }
  getItemText(file: TFile) { return file.path; }
  onChooseItem(file: TFile) { this.choose(file); }
}
