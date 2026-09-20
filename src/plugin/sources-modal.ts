import {Modal,Notice} from 'obsidian';
import type Deepsidian from './main';

/** Read-only previews stay local until explicitly attached to the composer. */
export class SourcesModal extends Modal {
  private closed=false;
  constructor(private plugin:Deepsidian,private link=''){super(plugin.app);}
  onClose(){this.closed=true;}
  onOpen(){this.closed=false;this.contentEl.empty();void this.draw();}
  private async draw(){
    this.contentEl.addClass('ds-memory-modal');this.modalEl.addClass('ds-memory-dialog');
    this.contentEl.createEl('h2',{text:'本轮来源与关联笔记'});
    this.plugin.capture();const source={...this.plugin.source};
    this.contentEl.createEl('p',{text:'预览留在本地；点击“附加片段”后才会随下次提问发送。当前笔记和附件可在输入框上方移除。最多4个附件，单片段最多6000字符；包含记忆的初始请求最多40000字符，超限会保留草稿。'});
    const selected=this.plugin.sourceSummary();
    for(const item of [{name:source.path||'无当前笔记',text:source.selection||source.nearby},...selected]){
      const detail=this.contentEl.createEl('details');detail.createEl('summary',{text:`${item.name} · ${item.text.length} 字符`});detail.createEl('pre',{text:item.text||'无文本片段（图片另行发送）',cls:'ds-proposal-text'});
    }
    const row=this.contentEl.createDiv('ds-source-resolve');
    const input=row.createEl('input',{value:this.link||source.path,attr:{'aria-label':'笔记链接或块引用',placeholder:'[[笔记#标题]] 或 [[笔记#^块ID]]'}});
    const button=row.createEl('button',{text:'定位与预览'});
    const preview=this.contentEl.createDiv();
    let generation=0;
    const resolve=async(link:string)=>{
      const serial=++generation;preview.empty();preview.createEl('p',{text:'正在读取…'});
      try{
        const result=await this.plugin.knowledge(link.toLowerCase().endsWith('.base')?'obsidian_base':'obsidian_resolve',link.toLowerCase().endsWith('.base')?{path:link}:{link,source:source.path},source.path) as any;
        if(this.closed||serial!==generation)return;
        preview.empty();preview.createEl('p',{text:`${result.path}${result.startLine?` · 行 ${result.startLine}–${result.endLine}`:''}${(result.truncated||String(result.content??'').length>6000)?' · 片段已截断':''}`});
        const content=String(result.content??'').slice(0,6000);preview.createEl('pre',{text:content,cls:'ds-proposal-text'});
        const open=preview.createEl('button',{text:'跳转原文'});
        open.onclick=()=>{void this.plugin.openSource(result.path+(result.subpath?'#'+result.subpath:''),source.path).then(()=>this.close()).catch(error=>new Notice(String(error)));};
        const attach=preview.createEl('button',{text:'附加片段'});
        attach.onclick=()=>{try{this.plugin.attachSource(`${result.path}${result.startLine?`:${result.startLine}`:''}`,content);new Notice('已附加，可在发送前移除');attach.disabled=true;}catch(error){new Notice(String(error));}};
      }catch(error){if(!this.closed&&serial===generation){preview.empty();preview.createEl('p',{text:String(error)});}}
    };
    button.onclick=()=>void resolve(input.value.trim());input.onkeydown=event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();void resolve(input.value.trim());}};
    if(this.link)void resolve(this.link);
    const related=this.contentEl.createDiv();related.createEl('h3',{text:'关联候选（未自动发送）'});
    if(source.path.toLowerCase().endsWith('.base')){related.createEl('p',{text:'当前是 Bases 配置。可在上方定位具体笔记；关联候选需要以 Markdown 笔记为起点。'});return;}
    if(!source.path){related.createEl('p',{text:'打开一篇笔记后可查看一跳链接和共同标签候选。'});return;}
    try{
      const result=await this.plugin.knowledge('obsidian_related',{path:source.path},source.path) as any;
      if(this.closed)return;
      for(const item of result.candidates??[]){const b=related.createEl('button',{text:item.path});related.createEl('p',{text:item.reasons.join('；')});b.onclick=()=>{input.value=item.path;void resolve(item.path);};}
      if(!result.candidates?.length)related.createEl('p',{text:'暂无关联候选；可以在上方输入链接。'});
    }catch(error){if(!this.closed)related.createEl('p',{text:String(error)});}
  }
}
