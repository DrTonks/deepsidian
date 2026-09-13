import { LearningView } from '../../src/plugin/view';
import { SetupModal } from '../../src/plugin/setup';
import { defaults } from '../../src/plugin/types';
import { traceEntry } from '../../src/plugin/trace';
import { WHALE_ICON } from '../../src/plugin/logo';
import { addIcon } from './obsidian-mock';
import {MemoryModal} from '../../src/plugin/memory/modal';
import {parseCommand} from '../../src/plugin/commands';
import type { Chat } from '../../src/plugin/types';
import { checkHistory } from './history-checks';

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
const plugin:any={
 state:{settings:{...defaults,setupComplete:screen!=='setup',background:'熟悉前端，正在了解 Transformer。'},chats:[chat],activeId:chat.id},
 get chat(){return this.state.chats.find((c:Chat)=>c.id===this.state.activeId);},
 models:[{provider:'deepseek-official',model:'deepseek-flash',name:'DeepSeek-V41-Flash',inputModalities:['text','image'],reasoning:{efforts:[{id:'off',name:'关闭'},{id:'high',name:'High'},{id:'max',name:'Max'}]}}],
 busy:false,stopRequested:false,runtimeVersion:'0.1.5-rc.2',status:'DeepSeek-V41-Flash · 按需连接',toolEvents:[],includeContext:true,
 source:{path:'学习笔记/注意力机制.md',selection:'自回归生成',nearby:'已记录 Query、Key、Value 与注意力公式。'},
 app:{workspace:{getActiveViewOfType:()=>null,openLinkText:async()=>{},getLeavesOfType:()=>[]},vault:{getFiles:()=>[],readBinary:async()=>new ArrayBuffer(0)}},
 attach(view:any){this.view=view;},detach(){},capture(){},persist:async()=>{},
 resolveEnvironment(){return {model:{provider:this.state.settings.provider||'deepseek-official',model:this.state.settings.model||'deepseek-flash'},versions:{dsh:'0.1.5-rc.2'}};},
 connect:async()=>{throw Error('组件预览不启动 DSH，请在 Obsidian 中连接。');},disconnect:async()=>{},
 newChat(){this.state.chats.unshift({id:'new',title:'新对话',messages:[]});this.state.activeId='new';this.view.renderMessages();this.view.refreshChats();},
 ask:async()=>{},stopAnswer(){},
 memory(){return {snapshot:async()=>({entries:memoryEntries,rules:memoryRules,revision:'preview'}),update:async(_rev:string,c:any)=>{if(c.add)memoryEntries.push({id:String(Date.now()),text:c.add,source:'合成预览记录',createdAt:'2026-09-13'});if(c.remove)memoryEntries=memoryEntries.filter(e=>e.id!==c.remove);if(c.edit)memoryEntries=memoryEntries.map(e=>e.id===c.edit.id?{...e,text:c.edit.text}:e);if(c.rules!==undefined)memoryRules=c.rules;}};},
 openMemory(tab:'entries'|'rules'='entries'){new MemoryModal(this,tab).open();},
 async runCommand(text:string){const c=parseCommand(text);if(c?.name==='memory')this.openMemory();else if(c?.name==='rules')this.openMemory('rules');else if(c?.name==='plan')return {question:c.args};else if(c?.name==='remember')await this.memory().update('preview',{add:c.args});return {};},
};
const view=new LearningView({app:plugin.app,container:document.getElementById('app')} as any,plugin);
await view.onOpen();
if(screen==='history-tests') await checkHistory(document.body.createDiv());
if(screen==='trace') Array.from(document.querySelectorAll<HTMLButtonElement>('.ds-tabs button')).find(b=>b.textContent==='轨迹')?.click();
if(screen==='setup') new SetupModal(plugin).open();
document.body.dataset.ready='true';
