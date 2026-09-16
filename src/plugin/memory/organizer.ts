import { randomUUID } from 'node:crypto';
import { DshClient, assistantText, type RuntimeOptions } from '../dsh.ts';

/** Separate process and session; no foreground chat history or tool access. */
export async function runOrganizer(options:RuntimeOptions,prompt:string,signal:AbortSignal) {
  signal.throwIfAborted();
  const sessionId=randomUUID();let output='';let overflow=false;
  const client=new DshClient({...options,memoryOrganizer:true,webSearch:false,webFetch:false,maxTokens:4096},
    async()=>{throw Error('记忆整理器不能调用工具');},
    (method,data)=>{
      if(method==='session.event' && data.sessionId===sessionId && data.event.type==='assistant/message') {
        const text=assistantText(data.event.data.stream);
        if(output.length+text.length>32000){overflow=true;void client.stop();}else output+=text;
      }
    });
  const abort=()=>{void client.stop();};signal.addEventListener('abort',abort,{once:true});
  try {
    // Split startup from prompt so abort during initialization cannot send later.
    await client.start();signal.throwIfAborted();
    const result=await client.prompt(sessionId,prompt);signal.throwIfAborted();
    if(overflow)throw Error('模型提案超过输出限制');
    if(result.kind!=='completed')throw Error('整理未完成，未保存任何记忆');
    return output;
  } finally {signal.removeEventListener('abort',abort);await client.stop();}
}
