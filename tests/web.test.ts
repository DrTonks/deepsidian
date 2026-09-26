import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DshClient, discover } from '../src/plugin/dsh.ts';
import {messagesResponse,toolResults} from './fixtures/messages.ts';

test('native DSH web search returns citations; fetch blocks private destinations', {timeout:60000}, async () => {
  const env = discover(); mkdirSync('.runs',{recursive:true});
  const dir = mkdtempSync(resolve('.runs/web-test-')); const home = join(dir,'config'); mkdirSync(home);
  let searches = 0, calls = 0, fetchedPrivate = false;
  const server = createServer(async (req,res) => {
    let body = ''; for await(const chunk of req) body += chunk;
    if (req.url === '/messages') {
      searches++; const input = JSON.parse(body); assert.ok(input.tools.some((t:any)=>t.type.startsWith('web_search')));
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({content:[{type:'web_search_tool_result',content:[{type:'web_search_result',url:'https://example.com/reference',title:'Synthetic reference'}]}]})); return;
    }
    if (req.url !== '/v1/messages') { fetchedPrivate = true; res.end('must not be fetched'); return; }
    const input = JSON.parse(body); calls++;
    const names = input.tools.map((t:any)=>t.name);
    assert.ok(names.includes('web_search') && names.includes('web_fetch'));
    const results = toolResults(input.messages);
    if (results.length >= 1) assert.match(results[0].content,/https:\/\/example.com\/reference/);
    if (results.length >= 2) assert.match(results[1].content,/blocked|public|private|loopback/i);
    if(results.length===0)messagesResponse(res,{tool:{id:'search',name:'web_search',input:{queries:['synthetic test query']}}});
    else if(results.length===1)messagesResponse(res,{tool:{id:'fetch',name:'web_fetch',input:{url:'http://127.0.0.1/private'}}});
    else messagesResponse(res,{text:'Complete'});
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  writeFileSync(join(home,'settings.yaml'),JSON.stringify({'llm-deepseek':{baseURL:endpoint},'web-search-deepseek':{baseURL:endpoint}}));
  const oldKey = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY='synthetic-test-key';
  const client = new DshClient({packageRoot:env.root,nodePath:env.node,dshHome:home,runtimeHome:join(dir,'runtime'),bridgePath:resolve('src/plugin/bridge.mjs'),cwd:resolve('fixtures'),provider:'deepseek-official',model:'deepseek-chat',webSearch:true,webFetch:true}, async()=>({}),()=>{});
  try { assert.equal((await client.prompt(randomUUID(),'Test native web tools.')).kind,'completed'); assert.equal(searches,1); assert.equal(calls,3); assert.equal(fetchedPrivate,false); }
  finally { await client.stop(); server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); oldKey === undefined ? delete process.env.DEEPSEEK_API_KEY : process.env.DEEPSEEK_API_KEY=oldKey; }
});
