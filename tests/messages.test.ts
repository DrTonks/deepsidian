import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DshClient, discover } from '../src/plugin/dsh.ts';
import { reasoningText } from '../src/plugin/trace.ts';

function respond(res: ServerResponse, tool: boolean) {
  res.writeHead(200, {'Content-Type':'text/event-stream'});
  const event=(value:object)=>res.write(`data: ${JSON.stringify(value)}\n\n`);
  event({type:'message_start',message:{id:'msg-test',type:'message',role:'assistant',content:[],model:'deepseek-flash',usage:{input_tokens:20,output_tokens:0}}});
  if(tool) {
    event({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'context-call',name:'obsidian_context',input:{}}});
    event({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{}'}});
    event({type:'content_block_stop',index:0});
  } else {
    event({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}});
    event({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Synthetic reasoning from Messages.'}});
    event({type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'synthetic-signature'}});
    event({type:'content_block_stop',index:0});
    event({type:'content_block_start',index:1,content_block:{type:'text',text:''}});
    event({type:'content_block_delta',index:1,delta:{type:'text_delta',text:'MESSAGES-ANSWER'}});
    event({type:'content_block_stop',index:1});
  }
  event({type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:12}});
  event({type:'message_stop'});res.end();
}

test('default Messages protocol: native tool results, reasoning and durable process resume', {timeout:60000}, async t=>{
  const env=discover();
  if(!env.versions.dsh?.startsWith('0.1.6')) {t.skip('Requires DSH 0.1.6 default Messages adapter');return;}
  mkdirSync('.runs',{recursive:true});const dir=mkdtempSync(resolve('.runs/messages-test-'));
  const home=join(dir,'config');mkdirSync(home);writeFileSync(join(home,'settings.yaml'),'{}');
  const requests:any[]=[];const errors:unknown[]=[];
  const server=createServer(async(req,res)=>{
    try {
      let raw='';for await(const chunk of req)raw+=chunk;
      assert.equal(req.url,'/v1/messages');
      const input=JSON.parse(raw);requests.push(input);
      assert.equal(input.model,'deepseek-flash');assert.equal(input.max_tokens,2048);
      assert.deepEqual(input.tools.map((x:any)=>x.name).sort(),['memory_read','memory_search','obsidian_context','obsidian_metadata','obsidian_read','obsidian_search']);
      const hasResult=input.messages.some((m:any)=>Array.isArray(m.content)&&m.content.some((b:any)=>b.type==='tool_result'));
      respond(res,!hasResult);
    } catch(e) {errors.push(e);res.writeHead(500);res.end('synthetic fixture assertion failed');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const oldUrl=process.env.DEEPSEEK_BASE_URL,oldKey=process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_BASE_URL=`http://127.0.0.1:${(server.address() as any).port}`;process.env.DEEPSEEK_API_KEY='synthetic-local-key';
  const options={packageRoot:env.root,nodePath:env.node,dshHome:home,runtimeHome:join(dir,'runtime'),bridgePath:resolve('src/plugin/bridge.mjs'),cwd:resolve('fixtures'),provider:'deepseek-official',model:'deepseek-flash',maxTokens:2048,reasoningEffort:'high'};
  let text='',reasoning='',calls=0,turnEnds=0;
  const listen=(method:string,data:any)=>{
    if(method==='deepsidian.stream'&&data.frame.chunk?.type==='text-delta')text+=data.frame.chunk.text;
    if(method==='session.event'&&data.event.type==='assistant/message')reasoning+=reasoningText(data.event.data.stream);
    if(method==='session.event'&&data.event.type==='turn/end')turnEnds++;
  };
  const tool=async(name:string)=>{assert.equal(name,'obsidian_context');calls++;return {path:'synthetic.md',selection:'SYNTHETIC-TOOL-RESULT'};};
  let client=new DshClient(options,tool,listen);const id=randomUUID();
  try {
    assert.equal((await client.prompt(id,'MESSAGES-FIRST')).kind,'completed');
    assert.deepEqual(errors,[]);assert.equal(calls,1);assert.match(text,/MESSAGES-ANSWER/);assert.match(reasoning,/Synthetic reasoning/);
    assert.ok(JSON.stringify(requests.at(-1)).includes('SYNTHETIC-TOOL-RESULT'));
    await client.stop();const before=requests.length;
    client=new DshClient(options,tool,listen);
    assert.equal((await client.prompt(id,'MESSAGES-AFTER-RESTART')).kind,'completed');
    assert.equal(turnEnds,2);assert.ok(requests.length>before);
    const replay=JSON.stringify(requests[before]);assert.match(replay,/MESSAGES-FIRST/);assert.match(replay,/MESSAGES-ANSWER/);assert.match(replay,/synthetic-signature/);
    assert.deepEqual(errors,[]);
  } finally {
    await client.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    oldUrl===undefined?delete process.env.DEEPSEEK_BASE_URL:process.env.DEEPSEEK_BASE_URL=oldUrl;
    oldKey===undefined?delete process.env.DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY=oldKey;
  }
});

test('rc.2 Chat Completions session resumes in 0.1.6 Messages without losing history', {timeout:60000}, async t=>{
  const env=discover();
  const legacyRoot=process.env.DSH_LEGACY_PACKAGE_ROOT ?? (process.platform==='win32'&&process.env.APPDATA ? join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh') : '');
  if(!env.versions.dsh?.startsWith('0.1.6') || !legacyRoot || !existsSync(join(legacyRoot,'package.json'))) {t.skip('Needs new runtime and DSH_LEGACY_PACKAGE_ROOT pointing to 0.1.5-rc.2');return;}
  const legacy=discover(legacyRoot);
  if(legacy.versions.dsh!=='0.1.5-rc.2') {t.skip('Legacy fixture runtime must be 0.1.5-rc.2');return;}
  mkdirSync('.runs',{recursive:true});const dir=mkdtempSync(resolve('.runs/messages-migration-'));
  const home=join(dir,'config');mkdirSync(home);writeFileSync(join(home,'settings.yaml'),'{}');
  let oldCalls=0,newCalls=0;const errors:unknown[]=[];
  const server=createServer(async(req,res)=>{
    try {
      let raw='';for await(const chunk of req)raw+=chunk;
      const input=JSON.parse(raw);
      if(req.url==='/chat/completions') {
        oldCalls++;assert.match(JSON.stringify(input.messages),/LEGACY-QUESTION/);
        res.writeHead(200,{'Content-Type':'text/event-stream'});
        for(const [delta,finish_reason] of [[{content:'LEGACY-ANSWER'},null],[{},'stop']])res.write(`data: ${JSON.stringify({id:'legacy-test',object:'chat.completion.chunk',model:'deepseek-flash',choices:[{index:0,delta,finish_reason}]})}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        assert.equal(req.url,'/v1/messages');newCalls++;
        const history=JSON.stringify(input.messages);assert.match(history,/LEGACY-QUESTION/);assert.match(history,/LEGACY-ANSWER/);assert.match(history,/NEW-PROTOCOL-QUESTION/);
        respond(res,false);
      }
    } catch(e) {errors.push(e);res.writeHead(500);res.end('synthetic migration assertion failed');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const oldUrl=process.env.DEEPSEEK_BASE_URL,oldKey=process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_BASE_URL=`http://127.0.0.1:${(server.address() as any).port}`;process.env.DEEPSEEK_API_KEY='synthetic-local-key';
  const options={packageRoot:legacy.root,nodePath:env.node,dshHome:home,runtimeHome:join(dir,'runtime'),bridgePath:resolve('src/plugin/bridge.mjs'),cwd:resolve('fixtures'),provider:'deepseek-official',model:'deepseek-flash',maxTokens:2048};
  let client=new DshClient(options,async()=>{throw Error('No tools expected');},()=>{});const id=randomUUID();
  try {
    assert.equal((await client.prompt(id,'LEGACY-QUESTION')).kind,'completed');await client.stop();
    client=new DshClient({...options,packageRoot:env.root},async()=>{throw Error('No tools expected');},()=>{});
    assert.equal((await client.prompt(id,'NEW-PROTOCOL-QUESTION')).kind,'completed');
    assert.deepEqual(errors,[]);assert.equal(oldCalls,1);assert.equal(newCalls,1);
  } finally {
    await client.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    oldUrl===undefined?delete process.env.DEEPSEEK_BASE_URL:process.env.DEEPSEEK_BASE_URL=oldUrl;
    oldKey===undefined?delete process.env.DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY=oldKey;
  }
});
