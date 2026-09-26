import type {ServerResponse} from 'node:http';

/** Local provider fixture: actual Messages SSE and tool-result blocks. */
export function messagesResponse(res:ServerResponse, response:{text?:string;thinking?:string;tool?:{id:string;name:string;input:unknown};hold?:boolean}) {
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const emit=(data:unknown)=>res.write(`data: ${JSON.stringify(data)}\n\n`);
  emit({type:'message_start',message:{id:'synthetic',type:'message',role:'assistant',content:[],model:'deepseek-flash',usage:{input_tokens:20,output_tokens:0}}});
  let index=0;
  if(response.thinking){
    emit({type:'content_block_start',index,content_block:{type:'thinking',thinking:''}});
    emit({type:'content_block_delta',index,delta:{type:'thinking_delta',thinking:response.thinking}});
    emit({type:'content_block_delta',index,delta:{type:'signature_delta',signature:'synthetic-signature'}});
    emit({type:'content_block_stop',index:index++});
  }
  if(response.tool){
    const {id,name,input}=response.tool;
    emit({type:'content_block_start',index,content_block:{type:'tool_use',id,name,input:{}}});
    emit({type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(input)}});
  }else{
    emit({type:'content_block_start',index,content_block:{type:'text',text:''}});
    emit({type:'content_block_delta',index,delta:{type:'text_delta',text:response.text??''}});
  }
  if(response.hold)return;
  emit({type:'content_block_stop',index});
  emit({type:'message_delta',delta:{stop_reason:response.tool?'tool_use':'end_turn'},usage:{output_tokens:12}});
  emit({type:'message_stop'});res.end();
}

export function toolResults(messages:any[]):{content:string}[] {
  return messages.flatMap(message=>Array.isArray(message.content)?message.content:[])
    .filter(block=>block.type==='tool_result')
    .map(block=>({content:typeof block.content==='string'?block.content:JSON.stringify(block.content)}));
}

export function currentToolResults(messages:any[]) {
  const lastQuestion=messages.findLastIndex(message=>message.role==='user' &&
    (typeof message.content==='string'||message.content.some((block:any)=>block.type==='text')));
  return toolResults(messages.slice(lastQuestion));
}
