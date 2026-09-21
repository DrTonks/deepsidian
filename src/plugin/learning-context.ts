import {createHash} from 'node:crypto';
import type {Attachment} from './attachments';
import type {NoteContext} from './context';
import type {Chat, ContextManifest} from './types';
export const contentHash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function contextManifest(chat:Chat,source:NoteContext,files:Attachment[],memoryEnabled:boolean,promptChars:number):ContextManifest {
  const items:ContextManifest['items']=[];
  if(source.path)items.push({kind:'note',label:source.path,chars:source.selection.length+source.nearby.length,hash:contentHash(JSON.stringify(source)),text:JSON.stringify(source,null,2)});
  for(const file of files){
    if(file.text!==undefined)items.push({id:file.id,kind:'attachment',label:file.name,chars:file.text.length,hash:contentHash(file.text)});
    if(file.image)items.push({id:file.id,kind:'image',label:file.name,bytes:Buffer.from(file.image.data,'base64').length,hash:contentHash(file.image.data)});
  }
  return {version:1,createdAt:Date.now(),items,memoryEnabled,historyMessages:chat.messages.length,inheritedMessages:chat.fork?.inheritedMessages??0,promptChars};
}
