import {ComposerContextModal} from '../../src/plugin/learning-modals';
/** Production composer with synthetic conversations. */
export async function checkLearning(plugin:any,view:any){
  const check=(value:boolean,label:string)=>{if(!value)throw Error(label);};
  const parent={id:'main',title:'主线',messages:[],draft:{text:'已有草稿'}};
  const child={id:'branch',title:'支线',messages:[],fork:{parentId:'main',inheritedMessages:0}};
  plugin.state.chats=[parent,child];plugin.state.activeId='main';view.refreshChats();view.renderMessages();
  check(view.input.value==='已有草稿','parent draft restored');
  view.input.value='新的主线草稿';view.input.dispatchEvent(new Event('input'));
  plugin.state.activeId='branch';view.refreshChats();check(view.input.value==='','branch has independent draft');
  plugin.state.activeId='main';view.refreshChats();check(view.input.value==='新的主线草稿','switch restores parent draft');
  view.attachments=[{id:'sample',name:'sample.txt',text:'sample'}];view.renderAttachments();
  const context=new ComposerContextModal(plugin,view);context.open();
  const remove=Array.from(context.contentEl.querySelectorAll('button')).find(b=>b.textContent==='移除 sample.txt')!;
  remove.click();await new Promise(r=>setTimeout(r,0));check(view.attachments.length===0,'context removes pending attachment');
  check(context.contentEl.textContent!.includes('不会擦除历史'),'context explains historical boundary');
  const source={...plugin.source},capture=plugin.capture;
  try {
    const stop=Array.from(context.contentEl.querySelectorAll('button')).find(b=>b.textContent==='停止附带当前笔记')!;
    check(context.contentEl.textContent!.includes('切换会话不会自动恢复'),'context states persistent exclusion');
    stop.click();await new Promise(r=>setTimeout(r,0));
    check(!plugin.includeContext&&!plugin.source.path,'stop removes current note');
    plugin.capture=()=>{if(plugin.includeContext)plugin.source={...source};};
    const resume=Array.from(context.contentEl.querySelectorAll('button')).find(b=>b.textContent==='重新附带当前笔记')!;
    resume.click();await new Promise(r=>setTimeout(r,0));
    check(plugin.includeContext&&plugin.source.path===source.path,'context allows explicit resume');
  } finally {plugin.capture=capture;}
  context.close();
  const readBinary=plugin.app.vault.readBinary;
  try {
    let release!:(data:ArrayBuffer)=>void;
    plugin.app.vault.readBinary=()=>new Promise<ArrayBuffer>(resolve=>{release=resolve;});
    const file={path:'main-only.txt',stat:{size:6}};
    const adding=view.addVaultFile(file,'main');
    plugin.state.activeId='branch';view.refreshChats();
    release(new TextEncoder().encode('source').buffer);await adding;
    check(view.pendingFiles().length===0,'deferred vault file must not enter another chat');
    plugin.state.activeId='main';view.refreshChats();
    check(view.pendingFiles().length===0,'cancelled vault file does not silently reappear');
    plugin.app.vault.readBinary=async()=>new TextEncoder().encode('source').buffer;
    await view.addVaultFile(file,'main');
    check(view.pendingFiles().length===1&&view.pendingFiles()[0].text==='source','current chat accepts vault file');
    view.removePendingFile(view.pendingFiles()[0].id);
  } finally {plugin.app.vault.readBinary=readBinary;}
  const selected={path:'学习笔记/注意力机制.md',selection:'复用 Key 和 Value',nearby:'周围的解释',heading:'自回归生成',startLine:12,endLine:13,revision:'synthetic-selected-revision',pinned:true};
  plugin.includeContext=true;plugin.chat.draft.context={...selected};plugin.capture();view.refreshContext();
  const chip=document.querySelector<HTMLElement>('.ds-file-chip')!;
  check(chip.textContent!.includes('选区快照 · 行 12–13'),'selection chip identifies pinned line range');
  const preview=chip.querySelector<HTMLButtonElement>('button[aria-label^="查看本次编辑上下文"]')!;
  preview.click();
  const excerpt=document.querySelector<HTMLElement>('.ds-context pre')!;
  check(!excerpt.hidden&&excerpt.textContent!.includes('标题：自回归生成')&&excerpt.textContent!.includes('复用 Key 和 Value'),'selection expands snapshot and heading');
  const selectedContext=new ComposerContextModal(plugin,view);selectedContext.open();
  check(selectedContext.contentEl.textContent!.includes('synthetic-selected-revision'),'context manifest previews pinned snapshot');
  selectedContext.close();
  chip.querySelector<HTMLButtonElement>('button[aria-label="移除当前文件"]')!.click();
  check(!plugin.chat.draft.context&&!plugin.source.path&&!plugin.includeContext,'selection removal clears persisted draft context');
  plugin.capture();view.refreshContext();
  check(!document.querySelector('.ds-file-chip'),'removed selection does not reappear after capture');
  check(!document.body.textContent!.includes('带回父对话'),'no return workflow');
  document.body.createEl('p',{text:'ALL LEARNING CHECKS PASSED: draft restore, chat isolation, context removal, deferred vault attachment isolation, pinned selection preview and removal, no return workflow'});
}
