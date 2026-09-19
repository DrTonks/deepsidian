import { Modal } from 'obsidian';
import type Deepsidian from '../main';
import type { ProposalBatch } from './proposals';

export class OrganizerModal extends Modal {
  private chatId:string;
  private controller?:AbortController;
  private batch?:ProposalBatch;
  private selected=new Set<number>();
  private saving=false;
  private closed=false;
  private message='';
  private committed=false;
  constructor(readonly plugin:Deepsidian,private pending?:{id:string;batch:ProposalBatch}){super(plugin.app);this.chatId=pending?.batch.chatId??plugin.chat?.id??'';if(pending){this.batch=structuredClone(pending.batch);this.message='闲时提案已保存；请核对来源后选择要保存的项目。';}}
  onOpen(){this.modalEl.addClass('ds-memory-dialog');this.contentEl.addClass('ds-memory-modal');this.render();}
  onClose(){this.closed=true;this.controller?.abort();}
  private button(parent:HTMLElement,label:string,action:()=>void,disabled=false){const button=parent.createEl('button',{text:label,attr:{type:'button'}});button.disabled=disabled;button.onclick=action;return button;}
  private async generate(){
    if(this.controller || this.saving)return;
    const controller=new AbortController();this.controller=controller;this.message='正在提炼，可随时取消…';this.batch=undefined;this.committed=false;this.render();
    try {this.batch=await this.plugin.extractMemory(this.chatId,controller.signal);this.selected.clear();this.message=this.batch.proposals.length?'请选择要保存的提案；未勾选的不会保存。':'没有符合规则的记忆提案。';}
    catch(error){this.message=controller.signal.aborted?'已取消，未保存记忆。':String(error);}
    finally{this.controller=undefined;this.render();}
  }
  private async save(){
    if(this.saving || this.controller || !this.batch || this.committed)return;
    this.saving=true;this.render();
    try {await this.plugin.applyMemoryProposals(this.batch,[...this.selected],this.pending?.id);this.committed=true;this.message='所选提案已保存到本库，下次提问生效。';}
    catch(error){this.message=String(error);}
    finally{this.saving=false;this.render();}
  }
  private async discard(){
    if(!this.pending || this.saving)return;
    this.saving=true;this.render();
    try{await this.plugin.discardIdleMemory(this.pending.id);this.committed=true;this.message='已放弃这批提案；该批来源不再自动处理，可手动提炼。';}
    catch(error){this.message=String(error);}
    finally{this.saving=false;this.render();}
  }
  private render(){
    if(this.closed)return;
    const root=this.contentEl;root.empty();root.createEl('h2',{text:this.pending?'闲时记忆提案':'从会话提炼记忆'});
    root.createEl('p',{text:this.pending?'这批提案来自允许贡献的会话，按持久进度从旧到新处理最多20条用户消息，已排除遗忘来源。没有自动写入记忆；只保存你勾选确认的内容。未选中项目随本批结束丢弃。':'仅从所选会话最近 20 条用户消息中排除已遗忘来源后，连同现有记忆和整理规则发送给当前模型；不会向前补齐，不发送附件、笔记上下文或助手回答。会产生模型调用费用，生成后不会自动保存。'});
    const select=root.createEl('select',{attr:{'aria-label':'来源会话'}});
    for(const chat of this.plugin.state.chats)select.createEl('option',{text:`${chat.title}${chat.contributeMemory===false?'（贡献已关闭）':''}`,value:chat.id});
    select.value=this.chatId;select.disabled=!!this.controller||this.saving||!!this.pending;
    select.onchange=()=>{this.chatId=select.value;this.batch=undefined;this.committed=false;this.message='';this.render();};
    const chat=this.plugin.state.chats.find(c=>c.id===this.chatId);
    const sources=root.createEl('details');sources.createEl('summary',{text:'查看候选来源消息（生成时会排除已遗忘来源）'});
    let preview=this.batch?.sources??[];
    if(!this.batch && chat && chat.contributeMemory!==false){try{preview=this.plugin.memoryContributionPreview(chat.id).sources;}catch(error){sources.createEl('p',{text:String(error)});}}
    if(chat && chat.contributeMemory!==false)for(const source of preview){sources.createEl('p',{text:`消息 ${source.index+1}`});sources.createEl('pre',{text:source.text,cls:'ds-proposal-text'});}
    if(!this.pending)this.button(root,this.batch?'重新生成提案':'生成提案',()=>void this.generate(),!!this.controller||this.saving||chat?.contributeMemory===false||!chat);
    if(this.controller)this.button(root,'取消整理',()=>{this.controller?.abort();});
    root.createEl('p',{text:this.message,attr:{role:'status','aria-live':'polite'}});
    if(this.batch && !this.committed){
      for(const [index,p] of this.batch.proposals.entries()) {
        const card=root.createDiv('ds-memory-proposal');
        const label=card.createEl('label');const check=label.createEl('input',{type:'checkbox'});check.checked=this.selected.has(index);check.disabled=this.saving;
        label.createSpan({text:p.kind==='add'?'新增记忆':'更正已有记忆（需要确认覆盖）'});
        check.onchange=()=>{check.checked?this.selected.add(index):this.selected.delete(index);save.disabled=!this.selected.size||this.saving;};
        if(p.id){card.createEl('small',{text:'修改前'});card.createEl('pre',{text:this.batch.snapshot.entries.find(e=>e.id===p.id)?.text??'',cls:'ds-proposal-text'});}
        card.createEl('small',{text:p.kind==='edit'?'修改后':'拟保存内容'});card.createEl('pre',{text:p.text,cls:'ds-proposal-text'});
        card.createEl('p',{text:p.reason});
        for(const evidence of p.evidence){const source=this.batch.sources.find(s=>s.key===evidence.key)!;card.createEl('small',{text:`来源：${this.batch.title} · 消息 ${source.index+1}`});card.createEl('blockquote',{text:evidence.quote});}
      }
      const save=this.button(root,'确认保存所选提案',()=>void this.save(),!this.selected.size||this.saving);
      if(this.pending)this.button(root,'放弃这批提案',()=>void this.discard(),this.saving);
    }
    root.createEl('small',{text:`${this.pending?(this.committed?'本批处理已结束。':'关闭窗口会保留待审提案，重启后也可继续查看。'):'关闭窗口会取消生成并丢弃未提交提案。'}模型整理日志保存在插件的 .memory-runtime 中；取消不会擦除已发送给供应商的数据。/organize 仍只重建本地索引。`});
  }
}
