import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DshClient, discover } from '../src/plugin/dsh.ts';
import { reasoningText } from '../src/plugin/trace.ts';
test('real DSH bridge: tools, text stream, cancel, followup and process resume', { timeout: 60000 }, async () => {
  const env = discover();
  mkdirSync('.runs', {recursive:true});
  const dir = mkdtempSync(resolve('.runs','bridge-test-'));
  const home = join(dir,'config'); mkdirSync(home); writeFileSync(join(home,'settings.yaml'),'{}');
  let hold = false, resumeHistory = false;
  let expectedModel = 'deepseek-chat', expectedTokens = 4096;
  let sawImage = false;
  let onHeld = () => {};
  const server = createServer(async (req,res) => {
    let body = ''; for await(const chunk of req) body += chunk;
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404, {'Content-Type':'application/json'}); res.end('{"error":{"message":"Not supported"}}'); return; }
    const input = JSON.parse(body);
    if (input.messages.some((m:any) => Array.isArray(m.content) && m.content.some((c:any) => c.type === 'image_url' && c.image_url.url.startsWith('data:image/')))) sawImage = true;
    assert.equal(input.model, expectedModel);
    assert.equal(input.max_tokens, expectedTokens);
    assert.deepEqual(input.tools.map((t:any) => t.function.name).sort(), ['memory_read', 'memory_search', 'obsidian_context', 'obsidian_metadata', 'obsidian_read', 'obsidian_search']);
    if (input.messages.some((m:any) => typeof m.content === 'string' && m.content.includes('FIRST-QUESTION'))) resumeHistory = true;
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    const chunk = (delta:object,finish_reason:string|null=null) => res.write(`data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',created:0,model:'deepseek-chat',choices:[{index:0,delta,finish_reason}]})}\n\n`);
    if (hold) { chunk({content:'partial'}); return; }
    if (!input.messages.some((m:any) => m.role === 'tool')) {
      chunk({tool_calls:[{index:0,id:'tool1',type:'function',function:{name:'obsidian_context',arguments:'{}'}}]}); chunk({},'tool_calls');
    } else { chunk({reasoning_content:'I used the supplied test context.'}); chunk({content:'ANSWER'}); chunk({},'stop'); }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const oldUrl = process.env.DEEPSEEK_BASE_URL, oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.DEEPSEEK_API_KEY = 'local-test-key';
  const options = {packageRoot:env.root,nodePath:env.node,dshHome:home,runtimeHome:join(dir,'runtime'),bridgePath:resolve('src/plugin/bridge.mjs'),cwd:resolve('fixtures'),provider:'deepseek-official',model:'deepseek-chat'};
  let text = '', toolCalls = 0, reasoning = '', systemPrompt = false;
  const listener = (method:string,data:any) => {
    if (method === 'session.event' && data.event.type === 'system/message') systemPrompt = true;
    if (method === 'session.event' && data.event.type === 'assistant/message') reasoning += reasoningText(data.event.data.stream);
    if(method === 'deepsidian.stream' && data.frame.chunk?.type === 'text-delta') { text += data.frame.chunk.text; if (data.frame.chunk.text === 'partial') onHeld(); }
  };
  let client = new DshClient(options, async () => {toolCalls++; return {text:'test context'};}, listener);
  const id = randomUUID();
  try {
    const models = await client.models();
    assert.ok(models.some(m => m.model === 'deepseek-flash' && m.inputModalities?.includes('image')));
    assert.ok(models.find(m => m.model === 'deepseek-flash')?.reasoning?.efforts.length);
    await assert.rejects(client.prompt(randomUUID(),'image on text route',[{name:'x.png',mimeType:'image/png',data:'AA=='}]), /图片输入能力/);
    assert.equal((await client.prompt(id,'FIRST-QUESTION')).kind,'completed'); assert.ok(toolCalls > 0); assert.match(text,/ANSWER/);
    assert.match(reasoning,/supplied test context/); assert.ok(systemPrompt);
    hold = true;
    const held = new Promise<void>(resolve => {onHeld = resolve;});
    const running = client.prompt(id,'CANCEL-QUESTION'); await held; client.cancel();
    const reason = await running; assert.equal(reason.kind,'aborted');
    hold = false;
    assert.equal((await client.prompt(id,'AFTER-CANCEL')).kind,'completed');
    await client.stop(); resumeHistory = false;
    expectedModel = 'deepseek-flash'; expectedTokens = 2048;
    client = new DshClient({...options, model: expectedModel, maxTokens: expectedTokens, reasoningEffort: 'high'}, async () => ({text:'test context'}), listener);
    assert.equal((await client.prompt(id,'AFTER-RESTART')).kind,'completed');
    assert.equal(resumeHistory,true,'DSH must reload previous session messages after process restart');
    assert.equal((await client.prompt(id,'Inspect the attached synthetic pixel.', [{name:'pixel.png', mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg=='}])).kind,'completed');
    assert.equal(sawImage, true, 'image must reach the provider request as image content');
    await client.stop(); sawImage = false;
    client = new DshClient({...options, model: expectedModel, maxTokens: expectedTokens}, async () => ({text:'test context'}), listener);
    assert.equal((await client.prompt(id,'Continue after image restart.')).kind,'completed');
    assert.equal(sawImage, true, 'durable image must survive runtime restart');
  } finally {
    await client.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    oldUrl === undefined ? delete process.env.DEEPSEEK_BASE_URL : process.env.DEEPSEEK_BASE_URL = oldUrl;
    oldKey === undefined ? delete process.env.DEEPSEEK_API_KEY : process.env.DEEPSEEK_API_KEY = oldKey;
  }
});

test('cancel preparation immediately, suppress submission and allow the next prompt', { timeout: 15000 }, async () => {
  const env = discover();
  mkdirSync('.runs', { recursive: true });
  const directory = mkdtempSync(resolve('.runs', 'cancel-preparation-'));
  mkdirSync(join(directory, 'lib'));
  // DshClient launches this deterministic service fixture instead of the DSH CLI.
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  // A JS wrapper is passed as the fake DSH CLI; pass fixture inputs through argv.
  writeFileSync(join(directory, 'lib/bin.js'), `process.argv[2] = ${JSON.stringify(env.root)}; process.argv[3] = ${JSON.stringify(resolve('src/plugin/bridge.mjs'))}; await import(${JSON.stringify(new URL('./fixtures/bridge-preparation.mjs', import.meta.url).href)});`);
  let preparing = () => {};
  const submitted: any[] = [];
  const client = new DshClient({ packageRoot: directory, nodePath: env.node, dshHome: directory, runtimeHome: join(directory, 'runtime'), bridgePath: resolve('src/plugin/bridge.mjs'), cwd: resolve('fixtures'), provider: 'mock', model: 'mock' }, async () => ({}), (method, data) => {
    if (method === 'test/preparing') preparing();
    if (method === 'test/submitted') submitted.push(data);
  });
  const control = (method: string, params = {}) => (client as any).request(method, params);
  try {
    await client.start();
    for (const scenario of [
      { stage: 'model' }, { stage: 'images' }, { stage: 'stat' }, { stage: 'create' },
      { stage: 'stat', stored: true }, { stage: 'resume', stored: true },
      { stage: 'model', existing: true }, { stage: 'images', existing: true },
    ]) {
      const sessionId = randomUUID();
      if (scenario.existing) await client.prompt(sessionId, 'Warm up existing session');
      const baseline = submitted.length;
      await control('test/configure', scenario);
      const held = new Promise<void>(resolve => { preparing = resolve; });
      const running = client.prompt(sessionId, 'Must never be submitted');
      await held;
      client.cancel();
      let timer: ReturnType<typeof setTimeout>;
      try {
        const result = await Promise.race([running, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Cancellation blocked in ${scenario.stage}`)), 1000); })]);
        assert.equal((result as any).kind, 'aborted');
      } finally { clearTimeout(timer!); }
      assert.equal(submitted.length, baseline, 'cancel must finish without releasing preparation');
      // Retry immediately while the cancelled preparation is still suspended.
      const next = client.prompt(sessionId, 'Next prompt');
      await control('test/release');
      assert.equal((await next).kind, 'completed');
      assert.equal(submitted.length, baseline + 1, 'only the replacement request may reach followup');
      assert.ok(JSON.stringify(submitted.at(-1)).includes('Next prompt'));
    }
  } finally { await client.stop(); }
});


test('real DSH memory search/read follows corrected and deleted snapshots across sessions', {timeout:60000}, async () => {
  const {MemoryStore}=await import('../src/plugin/memory/store.ts');
  const {prepareRecall,readRecall}=await import('../src/plugin/memory/recall.ts');
  const env=discover();mkdirSync('.runs',{recursive:true});const dir=mkdtempSync(resolve('.runs','memory-runtime-'));
  const home=join(dir,'config');mkdirSync(home);writeFileSync(join(home,'settings.yaml'),'{}');
  const store=new MemoryStore(join(dir,'memory'));let snapshot=await store.snapshot();
  await store.update(snapshot.revision,{add:'MEMORY_ORIGINAL: prefer frontend examples'});snapshot=await store.snapshot();
  const id=snapshot.entries[0]!.id;let recall=prepareRecall(snapshot,'examples'),expected='MEMORY_ORIGINAL';const calls:string[]=[];
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);
    const lastUser=input.messages.findLastIndex((m:any)=>m.role==='user');const tail=input.messages.slice(lastUser+1);const results=tail.filter((m:any)=>m.role==='tool');
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const emit=(delta:any,finish_reason:string|null=null)=>res.write(`data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',created:0,model:'deepseek-chat',choices:[{index:0,delta,finish_reason}]})}\n\n`);
    if(expected && results.length<2){const name=results.length?'memory_read':'memory_search';emit({tool_calls:[{index:0,id:`call-${results.length}`,type:'function',function:{name,arguments:JSON.stringify(results.length?{id}:{query:'examples'})}}]});emit({},'tool_calls');}
    else {if(expected)assert.ok(JSON.stringify(results).includes(expected));else assert.ok(JSON.stringify(input.messages[lastUser]).includes('"total":0') || JSON.stringify(input.messages[lastUser]).includes('\\"total\\":0'));emit({content:expected||'NO_MEMORY'});emit({},'stop');}
    res.end('data: [DONE]\n\n');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const oldUrl=process.env.DEEPSEEK_BASE_URL,oldKey=process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_BASE_URL=`http://127.0.0.1:${(server.address() as any).port}`;process.env.DEEPSEEK_API_KEY='local-test-key';
  const options={packageRoot:env.root,nodePath:env.node,dshHome:home,runtimeHome:join(dir,'runtime'),bridgePath:resolve('src/plugin/bridge.mjs'),cwd:dir,provider:'deepseek-official',model:'deepseek-chat'};
  let client=new DshClient(options,async(name,args)=>{calls.push(name);return readRecall(recall,name,args);},()=>{});
  try {
    await client.prompt(randomUUID(),`Explain examples\n${recall.prompt}`);
    snapshot=await store.snapshot();await store.update(snapshot.revision,{edit:{id,text:'MEMORY_CORRECTED: prefer Python examples'}});
    recall=prepareRecall(await store.snapshot(),'examples');expected='MEMORY_CORRECTED';const session=randomUUID();
    await client.prompt(session,`Explain examples\n${recall.prompt}`);
    await client.stop();client=new DshClient(options,async(name,args)=>readRecall(recall,name,args),()=>{});
    snapshot=await store.snapshot();await store.update(snapshot.revision,{remove:id});recall=prepareRecall(await store.snapshot(),'examples');expected='';
    await client.prompt(session,`Continue\n${recall.prompt}`);
    assert.deepEqual(calls,['memory_search','memory_read','memory_search','memory_read']);
  } finally {await client.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));oldUrl===undefined?delete process.env.DEEPSEEK_BASE_URL:process.env.DEEPSEEK_BASE_URL=oldUrl;oldKey===undefined?delete process.env.DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY=oldKey;}
});
