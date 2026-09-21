import {checkCompletion} from './completion-checks';
import {checkLearning} from './learning-checks';
import {DeepsidianSettings} from '../../src/plugin/settings';
import { TESTED_DSH } from '../../src/plugin/versions';
import { LearningView } from '../../src/plugin/view';
import { SetupModal } from '../../src/plugin/setup';
import { defaults } from '../../src/plugin/types';
import { traceEntry } from '../../src/plugin/trace';
import { WHALE_ICON } from '../../src/plugin/logo';
import { addIcon } from './obsidian-mock';
import {MemoryModal} from '../../src/plugin/memory/modal';
import {OrganizerModal} from '../../src/plugin/memory/organizer-modal';
import {SourcesModal} from '../../src/plugin/sources-modal';
import {parseCommand} from '../../src/plugin/commands';
import type { Chat } from '../../src/plugin/types';
import { checkHistory } from './history-checks';
import { checkAttachments } from './attachment-checks';
import { checkMemoryControls, checkOrganizerControls } from './memory-checks';

addIcon('deepsidian-whale',WHALE_ICON);
const start=Date.UTC(2026,8,13,2,0,0);
const event=(type:string,data:any,offset:number)=>({...traceEntry({type,data}),at:start+offset});
const answer='KV cache 保存注意力计算中已经算过的 Key 和 Value。生成下一个 token 时，可以复用之前的结果，避免重复计算。\n\n可以把它理解为增量渲染：旧内容的中间结果留在缓存里，新内容只补算新增部分。不过随着上下文增长，缓存也会占用更多显存。\n\n你的笔记已经介绍了 Q、K、V，可以接着对照注意力公式看：哪些量随新 token 改变，哪些量能够复用。';
const trace=[
  event('turn/start',{turn:1},0),event('step/start',{turn:1,step:1},10),
  event('system/message',{turn:1,step:1,message:{content:[{type:'text',text:'你是学习笔记助手。引用资料使用 [[笔记路径]]，不把笔记存在等同于用户已掌握。'}]}},20),
  event('user/message',{content:[{type:'text',text:'结合我的注意力机制笔记，解释 KV cache 的作用。'}]},30),
  event('request/context',{provider:'deepseek-official',model:'deepseek-flash',contextWindow:1000000},35),
  event('assistant/message',{turn:1,step:1,message:{content:[{type:'text',text:'先查看笔记大纲，确认需要衔接的概念。'}]},usage:{inputTokens:900,outputTokens:80,cacheReadTokens:500}},1400),
  event('tool/call',{turn:1,step:1,callId:'meta-1',name:'obsidian_metadata',arguments:'{"path":"学习笔记/注意力机制.md"}'},1410),
  event('tool/result',{turn:1,step:1,message:{content:[{type:'tool-result',callId:'meta-1',content:[{type:'text',text:'标题：Query、Key、Value；缩放点积注意力；自回归生成。'}]}]}},1630),
  event('step/end',{turn:1,step:1},1640),event('step/start',{turn:1,step:2},1660),
  event('assistant/message',{turn:1,step:2,message:{content:[{type:'text',text:answer}]},usage:{inputTokens:300,outputTokens:200,cacheReadTokens:1400}},4300),
  event('step/end',{turn:1,step:2},4310),event('turn/end',{turn:1,reason:{kind:'completed'}},4320),
];
const chat:Chat={id:'00000000-0000-4000-8000-000000000001',title:'理解 KV cache',systemPrompt:'你是学习笔记助手。根据用户明确背景解释，并使用 [[笔记路径]] 标明来源。',messages:[{role:'user',text:'结合我的注意力机制笔记，解释 KV cache 的作用。',source:{path:'学习笔记/注意力机制.md',selection:'自回归生成',nearby:'已记录 Query、Key、Value 与注意力公式。'}},{role:'assistant',text:answer,model:'deepseek-flash',status:'完成',elapsedMs:4320,reasoning:'先查看已提供的笔记结构，再从前端增量计算的角度解释 KV cache，区分计算复用与显存占用。',trace}]};
const screen=new URLSearchParams(location.search).get('screen') ?? 'chat';
let memoryEntries=[{id:'preview',text:'熟悉前端，首次出现的 agent 术语需要简短解释。',source:'合成预览记录',createdAt:'2026-09-13'}];
let memoryRules='# 整理规则\n仅保存用户明确表达的持久偏好。';
let previewUndoAvailable=true;
const plugin:any={
 memoryDrafts:new Map(),
 previewContext(files:any[]=[]){return {historyMessages:this.chat.messages.length,inheritedMessages:this.chat.fork?.inheritedMessages??0,memoryEnabled:this.state.settings.useMemory&&this.chat.useMemory!==false,items:[...(this.source.path?[{kind:'note',label:this.source.path,chars:this.source.selection.length+this.source.nearby.length,hash:'synthetic-preview',text:JSON.stringify(this.source)}]:[]),...files.map(f=>({id:f.id,kind:f.image?'image':'attachment',label:f.name,chars:f.text?.length,bytes:f.image?3:undefined,hash:'synthetic-preview'}))]};},
 setDraftText(id:string,text:string){const c=this.state.chats.find((c:Chat)=>c.id===id);if(c)(c.draft??={text:''}).text=text;},
 async setChatMemory(id:string,change:any){Object.assign(this.state.chats.find((c:Chat)=>c.id===id),change);},
 async setChatMemoryStart(id:string,mode:'now'|'all'){const current=this.state.chats.find((c:Chat)=>c.id===id);current.memoryStart=mode==='now'?{index:current.messages.length,key:'synthetic-preview'}:undefined;current.memoryPolicyVersion=(current.memoryPolicyVersion??0)+1;},
 memoryContributionPreview(id:string){const current=this.state.chats.find((c:Chat)=>c.id===id);const start=current.memoryStart?.index??0;return {start,sources:current.messages.flatMap((m:any,index:number)=>index>=start && m.role==='user'?[{index,text:m.text,key:`preview-${index}`}]:[]).slice(-20)};},
 openOrganizer(){new OrganizerModal(this).open();},
 async extractMemory(){return {chatId:chat.id,title:chat.title,snapshot:await this.memory().snapshot(),sources:[{key:'demo',index:0,text:'请使用前端例子；技术词首次出现时请解释。'}],proposals:[{kind:'edit',id:'preview',text:'熟悉前端；技术词首次出现时配简短解释和一个前端例子。',reason:'用户明确的解释偏好，建议补充已有条目。',evidence:[{key:'demo',quote:'技术词首次出现时请解释'}]},{kind:'add',text:'解释复杂概念时偏好前端例子。',reason:'合成预览：用于展示多项提案勾选。',evidence:[{key:'demo',quote:'请使用前端例子'}]}]};},
 async applyMemoryProposals(){},
 async discardIdleMemory(){delete this.state.idleMemory.pending;},
 state:{settings:{...defaults,setupComplete:screen!=='setup',background:'熟悉前端，正在了解 Transformer。'},chats:[chat],activeId:chat.id},
 get chat(){return this.state.chats.find((c:Chat)=>c.id===this.state.activeId);},
 models:[{provider:'deepseek-official',model:'deepseek-flash',name:'DeepSeek-V41-Flash',inputModalities:['text','image'],reasoning:{efforts:[{id:'off',name:'关闭'},{id:'high',name:'High'},{id:'max',name:'Max'}]}}],
 busy:false,stopRequested:false,runtimeVersion:TESTED_DSH,status:'DeepSeek-V41-Flash · 按需连接',toolEvents:[],includeContext:true,
 source:{path:'学习笔记/注意力机制.md',selection:'自回归生成',nearby:'已记录 Query、Key、Value 与注意力公式。'},
 async openSource(link:string,source:string){this.lastOpenedSource={link,source};},
 sourceSummary(){return this.view?.sourceSummary()??[];},
 attachSource(name:string,text:string){this.view.attachSource(name,text);},
 async knowledge(name:string,args:any){
   // Synthetic knowledge fixtures exercise the production modal without reading a vault.
   if(name==='obsidian_related')return {source:this.source.path,candidates:[{path:'学习笔记/KV cache.md',reasons:['当前笔记的链接','共同标签：Transformer']},{path:'学习笔记/推理优化.md',reasons:['链接到当前笔记']}]};
   if(name==='obsidian_base')return {path:'_本地管理/文章管理.base',content:'filters:\n  and:\n    - file.inFolder("学习笔记")\nviews:\n  - type: table\n    name: 全部笔记',truncated:false};
   const raw=String(args.link??'').replace(/^\[\[|\]\]$/g,'');
   if(!raw||raw.includes('不存在'))throw Error('未找到笔记或引用目标');
   const path=raw.split('#')[0];
   return {path:path.endsWith('.md')?path:`${path}.md`,content:'## KV cache\n\n保存历史 token 的 Key 与 Value，生成新 token 时复用已有计算。\n\n与前端增量渲染类似：保留旧结果，仅计算新增部分。\n^kv-example',startLine:12,endLine:17,truncated:false};
 },
 app:{workspace:{getActiveViewOfType:()=>null,openLinkText:async()=>{},getLeavesOfType:()=>[]},vault:{getFiles:()=>[],readBinary:async()=>new ArrayBuffer(0)}},
 sidebarActivated(){}, async selectChat(id:string){this.state.activeId=id;},
 attach(view:any){this.view=view;},detach(){},capture(){},persist:async()=>{},
 resolveEnvironment(){return {model:{provider:this.state.settings.provider||'deepseek-official',model:this.state.settings.model||'deepseek-flash'},versions:{dsh:TESTED_DSH}};},
 connect:async()=>{throw Error('组件预览不启动 DSH，请在 Obsidian 中连接。');},disconnect:async()=>{},
 newChat(){this.state.chats.unshift({id:'new',title:'新对话',messages:[]});this.state.activeId='new';this.view.renderMessages();this.view.refreshChats();},
 ask:async()=>{},stopAnswer(){},
 memory(){return {snapshot:async()=>({vaultId:'preview-vault',entries:memoryEntries,rules:memoryRules,revision:'preview'}),history:async()=>({revision:'preview',entries:[{id:'preview-delete',at:'2026-09-19 10:00',kind:'delete',summary:'删除 1 条记忆（合成预览）'}],canUndo:previewUndoAvailable,requiresRestoreConfirmation:previewUndoAvailable}),undo:async(_revision:string,options:any)=>{if(!options.restoreDeleted)throw Error('请确认恢复删除内容');previewUndoAvailable=false;},update:async(_rev:string,c:any)=>{if(c.add)memoryEntries.push({id:String(Date.now()),text:c.add,source:'合成预览记录',createdAt:'2026-09-13'});if(c.remove)memoryEntries=memoryEntries.filter(e=>e.id!==c.remove);if(c.edit)memoryEntries=memoryEntries.map(e=>e.id===c.edit.id?{...e,text:c.edit.text}:e);if(c.rules!==undefined)memoryRules=c.rules;}};},
 openMemory(tab:'entries'|'rules'='entries'){new MemoryModal(this,tab).open();},
 async runCommand(text:string){const c=parseCommand(text);if(c?.name==='memory')this.openMemory();else if(c?.name==='rules')this.openMemory('rules');else if(c?.name==='context')new SourcesModal(this,c.args).open();else if(c?.name==='plan')return {question:c.args};else if(c?.name==='remember')await this.memory().update('preview',{add:c.args});return {};},
};
const view=new LearningView({app:plugin.app,container:document.getElementById('app')} as any,plugin);
await view.onOpen();
if(screen==='history-tests') await checkHistory(document.body.createDiv());
if(screen==='attachment-tests')await checkAttachments(view,plugin,document.body.createDiv());
if(screen==='learning-tests')await checkLearning(plugin,plugin.view);
if(screen==='memory-tests'){await checkMemoryControls(plugin,document.body.createDiv());await checkOrganizerControls(plugin,document.body.createDiv());}
if(screen==='memory-session')new MemoryModal(plugin,'session').open();
if(screen==='memory-maintenance'){const modal:any=new MemoryModal(plugin);modal.maintenanceOpen=true;modal.open();}
if(screen==='trace') Array.from(document.querySelectorAll<HTMLButtonElement>('.ds-tabs button')).find(b=>b.textContent==='轨迹')?.click();
if(screen==='setup') new SetupModal(plugin).open();
if(screen==='organizer')new OrganizerModal(plugin).open();
if(screen==='context'||screen==='context-tests'){
  const modal=new SourcesModal(plugin,'[[学习笔记/KV cache#KV cache]]');modal.open();
  await new Promise(r=>setTimeout(r,0));
  if(screen==='context-tests'){
    const root=modal.contentEl;
    const findButton=(text:string)=>Array.from(root.querySelectorAll('button')).find(b=>b.textContent===text)!;
    if(!root.textContent?.includes('行 12–17'))throw Error('source reference preview missing');
    const input=root.querySelector<HTMLInputElement>('input[aria-label="笔记链接或块引用"]')!;
    input.value='不存在';findButton('定位与预览').click();await new Promise(r=>setTimeout(r,0));
    if(!root.textContent?.includes('未找到笔记'))throw Error('source missing reference error not visible');
    findButton('学习笔记/推理优化.md').click();await new Promise(r=>setTimeout(r,0));
    if(input.value!=='学习笔记/推理优化.md')throw Error('related source did not resolve');
    findButton('附加片段').click();
    if(plugin.sourceSummary().length!==1||!findButton('附加片段').disabled)throw Error('source attach failed');
    const detail=document.querySelector<HTMLDetailsElement>('.ds-attachment details');
    if(!detail)throw Error('composer attachment preview missing');
    detail.querySelector('summary')!.click();
    if(!detail.open||!detail.textContent?.includes('历史 token'))throw Error('composer attachment preview inaccessible');
    findButton('跳转原文').click();await new Promise(r=>setTimeout(r,0));
    if(plugin.lastOpenedSource?.link!=='学习笔记/推理优化.md')throw Error('source navigation failed');
    document.body.createEl('p',{text:'ALL CONTEXT CHECKS PASSED: preview, missing link, related selection, attachment, source navigation'});
    document.body.dataset.contextChecks='passed';
  }
}
if(screen==='idle-organizer'){const pending={id:'synthetic-idle',batch:await plugin.extractMemory()};plugin.state.idleMemory={pending};new OrganizerModal(plugin,pending).open();}
if(screen==='settings'){
  const root=document.getElementById('app')!;root.empty();root.style.cssText='max-width:920px;padding:24px;overflow:auto';
  plugin.idleScheduler={running:false,error:''};plugin.persist=async()=>{};
  plugin.setCompletion=async(patch:object)=>{Object.assign(plugin.state.settings,patch);};
  plugin.setManageMemory=async(value:boolean)=>{plugin.state.settings.manageMemory=value;};plugin.setIdleMemory=async(value:boolean)=>{plugin.state.settings.idleMemory=value;};
  plugin.resolveEnvironment=()=>({versions:{dsh:TESTED_DSH},choices:[{provider:'deepseek-official',model:'deepseek-flash'}]});
  const settings=new DeepsidianSettings(plugin);settings.containerEl=root;settings.display();
  const sections=Array.from(root.querySelectorAll<HTMLDetailsElement>('.ds-settings-section'));
  if(sections.length!==6||sections.map(s=>s.open).join()!=='true,true,true,false,false,false')throw Error('settings grouping/default disclosure failed');
  sections[1]!.querySelector('summary')!.click();await new Promise(r=>setTimeout(r,0));settings.display();
  if(root.querySelectorAll<HTMLDetailsElement>('.ds-settings-section')[1]!.open)throw Error('settings disclosure lost on rerender');
  root.querySelectorAll<HTMLDetailsElement>('.ds-settings-section')[1]!.querySelector('summary')!.click();
  document.body.dataset.settingsChecks='passed';
}
if(screen==='completion-tests')await checkCompletion(document.body.createDiv());
document.body.dataset.ready='true';
