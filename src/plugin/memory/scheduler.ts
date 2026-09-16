import { randomUUID } from 'node:crypto';
import type { Chat } from '../types';
import type { MemorySnapshot } from './store';
import { extractionPrompt, parseProposals, sourceKey, type ProposalBatch, type Evidence } from './proposals.ts';

export interface IdleMemoryState {
  version:1; day:string; calls:number; chars:number; retryAt:number;
  cursors:Record<string,{index:number;key:string}>;
  pending?:{id:string;batch:ProposalBatch};
  lastError?:string;
}
export const newIdleMemory=():IdleMemoryState=>({version:1,day:'',calls:0,chars:0,retryAt:0,cursors:{}});
interface Host {
  enabled():boolean; blocked():boolean; chats():Chat[]; state():IdleMemoryState;
  save(change:(state:IdleMemoryState)=>void):Promise<void>;
  snapshot():Promise<MemorySnapshot>; run(prompt:string,signal:AbortSignal):Promise<string>;
}
/** One persisted pending batch. Reservation precedes dispatch; cancellations never refund it. */
export class MemoryScheduler {
  private lastActivity:number;
  private nextCheck=0;
  private controller?:AbortController;
  private task?:Promise<void>;
  private disposed=false;
  error='';
  private host:Host;
  private now:()=>number;
  constructor(host:Host,now:()=>number=Date.now){this.host=host;this.now=now;this.lastActivity=now();}
  get running(){return !!this.task;}
  activity(){this.lastActivity=this.now();this.controller?.abort();}
  dispose(){this.disposed=true;this.activity();}
  async stop(){this.activity();await this.task;}
  tick():Promise<void> {
    if(this.task)return this.task;
    const time=this.now(),state=this.host.state();
    if(this.disposed || !this.host.enabled() || this.host.blocked() || state.pending || time-this.lastActivity<300000 || time<state.retryAt || time<this.nextCheck)return Promise.resolve();
    this.nextCheck=time+60000;
    const controller=new AbortController();this.controller=controller;
    const task=this.execute(controller).catch(()=>{this.error='无法保存闲时整理状态，稍后重试；未确认的提案不会写入记忆。';this.nextCheck=this.now()+600000;}).finally(()=>{this.controller=undefined;this.task=undefined;});
    this.task=task;return task;
  }
  private valid(signal:AbortSignal){signal.throwIfAborted();if(this.disposed || !this.host.enabled() || this.host.blocked())throw Error('闲时整理已暂停');}
  private async execute(controller:AbortController){
    const signal=controller.signal;
    try {
      this.valid(signal);
      const today=new Date(this.now()).toISOString().slice(0,10),state=this.host.state();
      if(state.day>=today && (state.calls>=2 || state.chars>=80000))return;
      const snapshot=await this.host.snapshot();this.valid(signal);
      let chosen:Chat|undefined,sources:Evidence[]=[],prompt='',oversized=false;
      for(const candidate of this.host.chats()) {
        if(candidate.contributeMemory===false)continue;
        const cursor=state.cursors[candidate.id];
        const anchor=cursor && candidate.messages[cursor.index];
        const after=cursor && anchor?.role==='user' && sourceKey(candidate.id,cursor.index,anchor.text)===cursor.key?cursor.index:-1;
        sources=candidate.messages.flatMap((m,index)=>index>after && m.role==='user' && m.text.trim()?[{index,text:m.text,key:sourceKey(candidate.id,index,m.text)}]:[])
          .filter(s=>!snapshot.excludedSources?.includes(s.key)).slice(0,20);
        while(sources.length) {
          try {prompt=extractionPrompt(snapshot,sources);break;}
          catch {if(sources.length===1)oversized=true;sources.pop();}
        }
        if(sources.length){chosen={id:candidate.id,title:candidate.title,messages:[]};break;}
      }
      if(!chosen){
        const message='部分会话的单条消息或记忆/规则超出输入上限，已暂缓；请缩短内容后重试。';
        if(oversized && this.host.state().lastError!==message)await this.host.save(s=>{s.lastError=message;});
        return;
      }
      const chat=chosen,last=sources.at(-1)!;
      // Recheck quota inside the persistence queue so a stale timer cannot overspend.
      await this.host.save(current=>{
        this.valid(signal);
        if(today>current.day){current.day=today;current.calls=0;current.chars=0;}
        if(current.pending || current.calls>=2 || current.chars+prompt.length>80000)throw Error('闲时预算不足');
        current.calls++;current.chars+=prompt.length;current.retryAt=this.now()+600000;current.lastError=undefined;
      });
      this.valid(signal);
      const raw=await this.host.run(prompt,signal);this.valid(signal);
      const proposals=parseProposals(raw,snapshot,sources);
      const batch:ProposalBatch={chatId:chat.id,title:chat.title,snapshot,sources,proposals};
      await this.host.save(current=>{
        this.valid(signal);
        if(current.pending)throw Error('已有待审提案');
        const live=this.host.chats().find(c=>c.id===chat.id);
        if(!live || live.contributeMemory===false || sources.some(s=>sourceKey(live.id,s.index,live.messages[s.index]?.text??'')!==s.key))throw Error('来源已改变');
        current.cursors[chat.id]={index:last.index,key:last.key};
        if(proposals.length)current.pending={id:randomUUID(),batch};
        current.retryAt=0;current.lastError=undefined;
      });
      this.error='';
    } catch {
      if(this.disposed)return;
      await this.host.save(current=>{current.retryAt=this.now()+600000;current.lastError=signal.aborted?'前台操作已取消后台整理；来源进度未推进。':'整理失败或输入/预算超限；稍后在预算内重试，来源进度未推进。';});
    }
  }
}
