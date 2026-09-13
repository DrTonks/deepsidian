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
    assert.deepEqual(input.tools.map((t:any) => t.function.name).sort(), ['obsidian_context', 'obsidian_metadata', 'obsidian_read', 'obsidian_search']);
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
