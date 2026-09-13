import { Modal, Notice } from 'obsidian';
import type Deepsidian from '../main';
import type { MemorySnapshot } from './store';

export class MemoryModal extends Modal {
  private closed=false;
  private snapshot?:MemorySnapshot;
  constructor(readonly plugin:Deepsidian, private tab:'entries'|'rules'='entries') { super(plugin.app); }
  onOpen(){ this.contentEl.addClass('ds-memory-modal'); void this.refresh(); }
  onClose(){this.closed=true;}
  private async action(fn:()=>Promise<unknown>) {
    try { await fn(); if(!this.closed) await this.refresh(); }
    catch(error){new Notice(String(error));}
  }
  private async refresh(){
    try { const snapshot=await this.plugin.memory().snapshot(); if(this.closed)return; this.snapshot=snapshot; this.render(); }
    catch(error){ if(!this.closed){this.contentEl.empty();this.contentEl.createEl('p',{text:String(error)});} }
  }
  private render(){
    const root=this.contentEl; root.empty();
    root.createEl('h2',{text:this.tab==='rules'?'记忆整理规则':'本库记忆'});
    root.createEl('p',{cls:'ds-muted',text:'当前支持手动保存、编辑和本地索引整理。跨会话自动召回与模型自动提炼尚未启用。'});
    const nav=root.createDiv('ds-toolbar');
    const switcher=nav.createEl('button',{text:this.tab==='rules'?'管理记忆':'编辑规则'});
    switcher.onclick=()=>{this.tab=this.tab==='rules'?'entries':'rules';this.render();};
    const refresh=nav.createEl('button',{text:'刷新'});refresh.onclick=()=>void this.refresh();
    if(this.tab==='rules'){
      const area=root.createEl('textarea',{cls:'ds-memory-editor',attr:{'aria-label':'记忆整理规则'}});area.value=this.snapshot!.rules;
      root.createEl('p',{cls:'ds-muted',text:'规则保存在本库 RULES.md，供后续模型整理器使用；本地索引重建不执行这些自然语言规则。'});
      const save=root.createEl('button',{text:'保存规则'}); save.onclick=()=>void this.action(()=>this.plugin.memory().update(this.snapshot!.revision,{rules:area.value}));
      return;
    }
    const add=root.createEl('textarea',{cls:'ds-memory-editor',attr:{rows:'3',placeholder:'要记住的内容…','aria-label':'新记忆'}});
    const save=root.createEl('button',{text:'记住'});save.onclick=()=>void this.action(()=>this.plugin.memory().update(this.snapshot!.revision,{add:add.value,source:`用户手动保存 · 会话 ${this.plugin.chat?.id??''}`}));
    const organize=root.createEl('button',{text:'重建索引'});organize.onclick=()=>void this.action(()=>this.plugin.memory().update(this.snapshot!.revision,{organize:true}));
    for(const entry of this.snapshot!.entries){
      const row=root.createDiv('ds-memory-entry'); const area=row.createEl('textarea',{cls:'ds-memory-editor',attr:{rows:'3','aria-label':'记忆内容'}});area.value=entry.text;
      row.createEl('small',{text:entry.source});
      const actions=row.createDiv('ds-toolbar');
      const edit=actions.createEl('button',{text:'保存修改'});edit.onclick=()=>void this.action(()=>this.plugin.memory().update(this.snapshot!.revision,{edit:{id:entry.id,text:area.value}}));
      const remove=actions.createEl('button',{text:'删除'});remove.onclick=()=>{remove.textContent='确认删除';remove.onclick=()=>void this.action(()=>this.plugin.memory().update(this.snapshot!.revision,{remove:entry.id}));};
    }
  }
}
