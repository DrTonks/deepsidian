import {Modal,Notice} from 'obsidian';
import type Deepsidian from './main';
import type {LearningView} from './view';

export class ComposerContextModal extends Modal {
  private chatId:string;
  constructor(private plugin:Deepsidian,private view:LearningView){super(plugin.app);this.chatId=plugin.chat!.id;}
  onOpen(){this.draw();}
  private draw(){
    if(this.plugin.chat?.id!==this.chatId){this.close();return;}
    const el=this.contentEl;el.empty();el.addClass('ds-memory-modal');this.modalEl.addClass('ds-memory-dialog');
    el.createEl('h2',{text:'下次发送的上下文'});
    const manifest=this.plugin.previewContext(this.view.pendingFiles());
    el.createEl('p',{text:'这是当前预览。手动选区使用已保存的快照，普通当前笔记在发送时重新捕获；同时保存实际清单；工具随后读取的内容见运行轨迹。字符数不等于 token 或费用。'});
    el.createEl('p',{text:`已有 ${manifest.historyMessages} 条界面消息，其中 ${manifest.inheritedMessages} 条来自分支继承。移除下面的资料不会擦除历史中已发送的内容；完整历史不保证每轮原样进入模型窗口。`});
    const note=(title:string,text:string)=>{const detail=el.createEl('details');detail.createEl('summary',{text:title});detail.createEl('pre',{text,cls:'ds-proposal-text'});return detail;};
    if(this.plugin.source.path){
      const item=manifest.items.find(i=>i.kind==='note')!;
      note(`当前笔记：${item.label} · ${item.chars} 字符`,item.text!);
      el.createEl('p',{text:'移除后将持续停止附带当前笔记，直到手动重新选择；切换会话不会自动恢复。'});
      this.action(el,'停止附带当前笔记',()=>{this.view.removeCurrentContext();});
    }
    if(!this.plugin.includeContext)this.action(el,'重新附带当前笔记',()=>{
      this.plugin.includeContext=true;this.plugin.capture();this.view.refreshContext();
    });
    for(const file of this.view.pendingFiles()){
      const item=manifest.items.find(i=>i.id===file.id&&(i.kind==='image'||i.kind==='attachment'))!;
      note(`${file.name} · ${item.chars!==undefined?item.chars+' 字符':item.bytes+' 字节'} · 内容指纹 ${item.hash.slice(0,12)}`,file.text??'图片以图像输入发送，无法据此精确估计 token。');
      this.action(el,`移除 ${file.name}`,()=>this.view.removePendingFile(file.id));
    }
    const enabled=manifest.memoryEnabled;
    el.createEl('p',{text:`长期记忆读取：${enabled?'开启（发送时获取当时快照）':'关闭'}。同库共享；旧历史中的记忆内容不会被此开关擦除。`});
    this.action(el,enabled?'关闭本会话记忆读取':'开启本会话记忆读取',async()=>{
      if(!this.plugin.state.settings.useMemory)throw Error('全局记忆读取已关闭，请在设置中开启');
      await this.plugin.setChatMemory(this.chatId,{useMemory:!enabled});
    });
    el.createEl('p',{text:'问题草稿随会话保存。普通附件仅在当前侧栏暂存，重启后需重新添加。'});
  }
  private action(el:HTMLElement,label:string,run:()=>void|Promise<void>){
    const button=el.createEl('button',{text:label});button.disabled=this.plugin.busy;
    button.onclick=async()=>{
      if(this.plugin.chat?.id!==this.chatId||this.plugin.busy)return;
      button.disabled=true;
      try{await run();this.draw();}catch(error){new Notice(String(error));button.disabled=false;}
    };
  }
}
