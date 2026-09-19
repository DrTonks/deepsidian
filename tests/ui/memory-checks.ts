import {OrganizerModal} from '../../src/plugin/memory/organizer-modal';
import {MemoryModal} from '../../src/plugin/memory/modal';

/** Actual modal controls, synthetic persistence; backend contracts have host/store tests. */
export async function checkMemoryControls(plugin:any,root:HTMLElement){
  const report=root.createEl('pre');
  const check=(condition:boolean,label:string)=>{if(!condition)throw Error(label);report.append(`PASS ${label}\n`);};
  const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
  const originalMemory=plugin.memory,originalRange=plugin.setChatMemoryStart,originalStart=plugin.chat.memoryStart;
  let undoCalls=0,rangeCalls=0,restored=false;
  plugin.memory=()=>({snapshot:async()=>({revision:'r',entries:[],rules:''}),history:async()=>({revision:'r',entries:[{id:'x',at:'2026-09-19',kind:'delete',summary:'删除 1 条记忆'}],canUndo:!restored,requiresRestoreConfirmation:!restored}),undo:async(revision:string,options:any)=>{check(revision==='r' && options.restoreDeleted===true,'undo uses reviewed revision and explicit restore permission');undoCalls++;restored=true;}});
  plugin.setChatMemoryStart=async(id:string,mode:'now'|'all')=>{rangeCalls++;await originalRange.call(plugin,id,mode);};
  let modal:any;
  try{
    modal=new MemoryModal(plugin);modal.maintenanceOpen=true;modal.open();await settle();
    const button=(label:string)=>Array.from(modal.contentEl.querySelectorAll('button') as NodeListOf<HTMLButtonElement>).find(b=>b.textContent===label)!;
    check(modal.contentEl.textContent.includes('删除 1 条记忆'),'journal summaries appear in maintenance');
    button('撤销最近一次变更').click();check(undoCalls===0 && !!button('确认恢复已删除记忆'),'deleted memory requires a second confirmation');
    button('取消恢复').click();check(undoCalls===0 && !button('确认恢复已删除记忆'),'cancel restores undo review without writes');
    button('撤销最近一次变更').click();button('确认恢复已删除记忆').click();await settle();
    check(undoCalls===1 && modal.contentEl.textContent.includes('当前没有可撤销'),'successful undo refreshes available actions');
    button('本会话').click();button('仅从现在起贡献').click();await settle();
    check(rangeCalls===1 && plugin.chat.memoryStart.index===plugin.chat.messages.length,'now-only captures the current message boundary');
    button('恢复全部来源…').click();check(rangeCalls===1 && !!button('确认恢复全部来源'),'restoring old sources requires confirmation');
    button('取消恢复来源').click();check(rangeCalls===1 && plugin.chat.memoryStart!==undefined,'cancel retains excluded history');
    button('恢复全部来源…').click();button('确认恢复全部来源').click();await settle();
    check(rangeCalls===2 && plugin.chat.memoryStart===undefined,'confirmed restore permits all non-forgotten sources');
    report.append('ALL 9 MEMORY CONTROL CHECKS PASSED');
  }finally{modal?.close();plugin.memory=originalMemory;plugin.setChatMemoryStart=originalRange;plugin.chat.memoryStart=originalStart;}
}

/** Preserve the keyboard user's position across asynchronous organizer redraws. */
export async function checkOrganizerControls(plugin:any,root:HTMLElement){
  const report=root.createEl('pre');
  const modal=new OrganizerModal(plugin);modal.open();
  const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
  try{
    const sources=modal.contentEl.querySelector('details')!;sources.open=true;
    const generate=modal.contentEl.querySelector<HTMLButtonElement>('[data-organizer-focus="generate"]')!;
    generate.focus();generate.click();await settle();
    if(modal.contentEl.ownerDocument.activeElement?.getAttribute('data-organizer-focus')!=='generate')throw Error('organizer generation lost keyboard focus');
    if(!modal.contentEl.querySelector('details')?.open)throw Error('organizer generation collapsed reviewed sources');
    report.append('PASS organizer preserves keyboard focus and expanded sources after generation');
  }finally{modal.close();}
}
