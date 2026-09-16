import { Modal, Notice } from 'obsidian';
import type Deepsidian from '../main';
import type { MemorySnapshot } from './store';

export class MemoryModal extends Modal {
  private closed = false;
  private busy = false;
  private snapshot?: MemorySnapshot;
  private selected?: string;
  private query = '';
  private error = '';
  private saved = '';
  private confirming = false;
  private needsRefresh = false;
  private committedText = '';
  private focusKey?: string;
  private maintenanceOpen = false;
  private drafts: Map<string,string>;
  constructor(readonly plugin: Deepsidian, private tab: 'entries'|'rules' = 'entries') {
    super(plugin.app);
    this.drafts = plugin.memoryDrafts ?? new Map();
    this.selected = [...this.drafts.keys()].find(key => key !== 'rules');
  }
  onOpen() { this.closed = false; this.contentEl.addClass('ds-memory-modal'); this.modalEl?.addClass('ds-memory-dialog'); void this.refresh(); }
  onClose() {
    this.closed = true;
    if(this.drafts.size) new Notice('未提交草稿已暂存，重新打开记忆窗口可继续；重启 Obsidian 前请保存。');
  }
  private button(parent: HTMLElement, text: string, action: () => void, cls = '') {
    const button = parent.createEl('button', {text, cls, attr:{type:'button'}});
    button.setAttribute('data-memory-focus',text);
    button.disabled = this.busy || this.needsRefresh; button.onclick = action; return button;
  }
  private async refresh() {
    if(this.busy) return;
    this.busy = true; this.render();
    try { this.snapshot = await this.plugin.memory().snapshot(); this.error = ''; this.needsRefresh = false; }
    catch(error) { this.error = String(error); }
    finally { this.busy = false; this.render(); }
  }
  private async action(fn: () => Promise<unknown>, saved?: {key:string;value:string}, removed?: string) {
    if(this.busy || this.needsRefresh) return;
    this.busy = true; this.error = ''; this.saved = ''; this.render();
    let committed = false;
    try {
      await fn(); committed = true; this.committedText = saved?.value ?? (removed ? '记忆已删除' : '索引已重建');
      if(saved && this.drafts.get(saved.key) === saved.value) this.drafts.delete(saved.key);
      if(removed) { this.drafts.delete(removed); this.selected = undefined; }
      if(saved?.key === 'add') this.selected = undefined;
      this.confirming = false;
      this.snapshot = await this.plugin.memory().snapshot();
      this.saved = removed ? '已删除，下次提问起不再读取' : '已保存到本库';
    } catch(error) {
      this.needsRefresh = committed;
      this.error = committed ? `已保存，但读取最新内容失败：${String(error)}。请重新读取，不必重复提交。` : `${String(error)}。草稿已保留；若有版本冲突，请刷新并核对后再保存。`;
    }
    finally { this.busy = false; this.render(); }
  }
  private select(key?: string) { if(this.busy)return; this.selected = key; this.focusKey = key ? `editor:${key}` : '搜索记忆'; this.confirming = false; this.saved = ''; this.render(); }
  private render() {
    if(this.closed) return;
    const active = this.contentEl.ownerDocument?.activeElement as HTMLElement | null;
    if(!this.focusKey && active && this.contentEl.contains(active)) this.focusKey = active.getAttribute('data-memory-focus') ?? undefined;
    this.maintenanceOpen = this.contentEl.querySelector?.<HTMLDetailsElement>('.ds-memory-maintenance')?.open ?? this.maintenanceOpen;
    this.draw();
    if(!this.busy && this.focusKey) {
      const target = Array.from(this.contentEl.querySelectorAll?.<HTMLElement>('[data-memory-focus]') ?? []).find(el=>el.getAttribute('data-memory-focus')===this.focusKey && !(el as HTMLButtonElement).disabled);
      (target ?? this.contentEl.querySelector?.<HTMLElement>('input:not(:disabled),button:not(:disabled)'))?.focus();
      this.focusKey = undefined;
    }
  }
  private draw() {
    if(this.closed) return;
    const root = this.contentEl; root.empty();
    const header = root.createDiv('ds-memory-heading');
    header.createEl('h2', {text:'本库记忆'});
    header.createEl('p', {cls:'ds-memory-subtitle',text:this.plugin.state.settings.useMemory ? '同一知识库共享 · 保存后从下一次提问生效' : '同一知识库共享 · 当前已关闭记忆读取，可在设置开启'});
    const tabs = root.createDiv({cls:'ds-memory-tabs',attr:{role:'group','aria-label':'记忆管理页面'}});
    for(const [id,label] of [['entries','记忆'],['rules','整理规则']] as const) {
      const button = this.button(tabs,label,()=>{this.tab=id;this.focusKey=label;this.confirming=false;this.saved='';this.render();});
      button.setAttribute('aria-pressed',String(this.tab===id));
    }
    const feedback = root.createDiv({cls:'ds-memory-feedback',attr:{role:this.error?'alert':'status','aria-live':'polite'}});
    feedback.setText(this.error || (this.busy ? '正在处理…' : this.saved));
    if(!this.snapshot || this.needsRefresh) {
      if(this.needsRefresh) root.createEl('pre',{text:this.committedText});
      const retry=this.button(root,'重新读取',()=>void this.refresh()); retry.disabled=this.busy;
      return;
    }
    if(this.tab === 'rules') this.renderRules(root);
    else this.renderEntries(root);
    const more = root.createEl('details', {cls:'ds-memory-maintenance'});
    more.open = this.maintenanceOpen;
    more.createEl('summary', {text:'存储、维护与隐私说明',attr:{'data-memory-focus':'存储、维护与隐私说明'}});
    more.createEl('p',{text:'记忆读取由设置中的“使用本库长期记忆”控制。删除不会擦除已发送的聊天；下一轮会通知模型撤回旧记忆。自动提炼和闲时整理尚未启用。'});
    more.createEl('p',{text:'未保存草稿只在本次 Obsidian 运行期间保留，不会发送给模型。刷新不清除草稿；重启前请保存。'});
    this.button(more,'刷新已保存内容',()=>void this.refresh());
    this.button(more,'重建本地索引',()=>void this.action(()=>this.plugin.memory().update(this.snapshot!.revision,{organize:true})));
    more.createEl('small',{text:'重建索引不调用模型，也不合并或提炼记忆。'});
  }
  private renderEntries(root: HTMLElement) {
    const toolbar = root.createDiv('ds-memory-toolbar');
    const search = toolbar.createEl('input',{attr:{type:'search','aria-label':'搜索记忆','data-memory-focus':'搜索记忆',placeholder:'搜索内容或来源…'}});
    search.value = this.query; search.disabled = this.busy;
    this.button(toolbar,'新增记忆',()=>this.select('add'),'mod-cta');
    const body = root.createDiv('ds-memory-layout');
    const list = body.createDiv('ds-memory-list');
    const drawList = () => {
      list.empty();
      const query = this.query.trim().toLocaleLowerCase();
      const entries = this.snapshot!.entries.filter(e => `${e.text} ${e.source}`.toLocaleLowerCase().includes(query));
      list.createEl('small',{cls:'ds-memory-count',text:`${entries.length} / ${this.snapshot!.entries.length} 条记忆`});
      if(!entries.length) list.createEl('p',{cls:'ds-memory-empty',text:query?'没有匹配的记忆':'尚无记忆，点击“新增记忆”开始。'});
      for(const entry of entries) {
        const row = this.button(list,'',()=>this.select(entry.id),'ds-memory-row');
        row.setAttribute('data-memory-focus',`row:${entry.id}`);
        row.setAttribute('aria-pressed',String(this.selected===entry.id));
        row.createEl('span',{text:entry.text.replace(/\s+/g,' ').slice(0,100)});
        row.createEl('small',{text:`${entry.createdAt.slice(0,10)}${this.drafts.has(entry.id)?' · 未保存':''}`});
      }
    };
    search.oninput = () => { this.query = search.value; drawList(); }; drawList();
    const editor = body.createDiv('ds-memory-detail');
    if(!this.selected) { editor.createEl('p',{cls:'ds-memory-empty',text:'选择一条记忆查看全文，或新增记忆。'}); return; }
    const entry = this.snapshot!.entries.find(e=>e.id===this.selected);
    if(this.selected !== 'add' && !entry) {
      editor.createEl('p',{text:'这条记忆已不存在。'});
      if(this.drafts.has(this.selected)) {
        editor.createEl('pre',{text:this.drafts.get(this.selected)});
        const key=this.selected;
        this.button(editor,'放弃此草稿',()=>{this.drafts.delete(key);this.select();});
      }
      return;
    }
    editor.createEl('h3',{text:entry?'编辑记忆':'新增记忆'});
    if(entry) editor.createEl('p',{cls:'ds-memory-source',text:`来源：${entry.source}`});
    this.renderEditor(editor,this.selected,entry?.text??'',2000,entry?'记忆内容':'新记忆');
    if(entry) {
      const danger = editor.createDiv('ds-memory-danger');
      if(this.confirming) {
        danger.createEl('p',{text:'删除这条记忆？下次提问将不再读取，旧聊天历史仍保留。'});
        this.button(danger,'确认删除',()=>void this.action(()=>this.plugin.memory().update(this.snapshot!.revision,{remove:entry.id}),undefined,entry.id),'mod-warning');
        this.button(danger,'取消删除',()=>{this.confirming=false;this.render();});
      } else this.button(danger,'删除记忆',()=>{this.confirming=true;this.render();});
    }
  }
  private renderRules(root: HTMLElement) {
    const editor = root.createDiv('ds-memory-rules');
    editor.createEl('p',{cls:'ds-memory-subtitle',text:'用于未来的模型整理器；当前不会执行这些规则，也不会自动改写记忆。'});
    this.renderEditor(editor,'rules',this.snapshot!.rules,12000,'记忆整理规则');
  }
  private renderEditor(parent: HTMLElement, key: string, original: string, limit: number, label: string) {
    const area = parent.createEl('textarea',{cls:`ds-memory-editor${key==='rules'?' ds-memory-rule-editor':''}`,attr:{'aria-label':label,'data-memory-focus':`editor:${key}`,spellcheck:'false'}});
    area.value = this.drafts.get(key) ?? original; area.disabled = this.busy;
    const status = parent.createDiv({cls:'ds-memory-edit-status',attr:{'aria-live':'polite'}});
    const actions = parent.createDiv('ds-memory-editor-actions');
    const save = this.button(actions,key==='rules'?'保存规则':key==='add'?'保存记忆':'保存修改',()=>{
      const value=area.value;
      const change=key==='rules'?{rules:value}:key==='add'?{add:value,source:`用户手动保存 · 会话 ${this.plugin.chat?.id??''}`}:{edit:{id:key,text:value}};
      void this.action(()=>this.plugin.memory().update(this.snapshot!.revision,change),{key,value});
    },'mod-cta');
    this.button(actions,'取消编辑',()=>{this.drafts.delete(key);if(key==='add')this.selected=undefined;this.saved='';this.render();});
    const update = () => {
      const dirty = area.value !== original;
      if(dirty) this.drafts.set(key,area.value); else this.drafts.delete(key);
      status.setText(`${area.value.length} / ${limit} 字符 · ${area.value.length>limit?'超过长度限制':dirty?'未保存':'已保存'}`);
      save.disabled = this.busy || !dirty || area.value.length>limit || (key!=='rules'&&!area.value.trim());
    };
    area.oninput=update; update();
  }
}
