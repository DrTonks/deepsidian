/** Real view lifecycle with a deferred synthetic model, no provider calls. */
export async function checkAttachments(view:any,plugin:any,root:HTMLElement) {
  const report=root.createEl('pre');const check=(value:boolean,label:string)=>{if(!value)throw Error(label);report.append(`PASS ${label}\n`);};
  const oldAsk=plugin.ask;const initial=plugin.chat.messages.slice();
  try {
    for(const count of [2,4]) {
      const files=Array.from({length:count},(_,i)=>({id:`sent-${i}`,name:`sent-${i}.txt`,text:'synthetic'}));
      view.attachments=files;view.input.value='test';let finish!:()=>void,prepared!:()=>void;
      plugin.ask=async(_question:string,_files:any[],accepted:()=>void)=>{plugin.busy=true;await new Promise<void>(r=>prepared=r);accepted();await new Promise<void>(r=>finish=r);plugin.chat.messages.push({role:'assistant',text:'failed',status:'失败'});plugin.busy=false;};
      const sending=view.send();
      const additions=Array.from({length:4},(_,i)=>({name:`new-${i}.txt`,size:1,arrayBuffer:async()=>new TextEncoder().encode('x').buffer}));
      await view.addFiles(additions);
      const remove=Array.from(view.attachmentEl.querySelectorAll('button')) as HTMLButtonElement[];
      remove.forEach(button=>button.click());
      check(remove.every(button=>button.disabled) && view.attachments.length===count,'preparation locks captured attachments against additions/removals');
      prepared();await Promise.resolve();
      await view.addFiles(Array.from({length:4},(_,i)=>({name:`new-${i}.txt`,size:1,arrayBuffer:async()=>new TextEncoder().encode('x').buffer})));
      check(view.attachments.length===4-count,`${count} in-flight attachments reserve recovery capacity`);
      finish();await sending;
      check(view.attachments.length===4 && files.every(file=>view.attachments.includes(file)),`failed ${count}-file request restores all files without overflow`);
      check(view.submittedAttachments===0,'completed request releases reservation');
    }
  } finally {plugin.ask=oldAsk;plugin.busy=false;plugin.chat.messages=initial;view.attachments=[];view.renderAttachments();}
}
