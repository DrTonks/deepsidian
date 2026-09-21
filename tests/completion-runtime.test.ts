import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DshClient, discover } from '../src/plugin/dsh.ts';
import { completionBridge } from '../src/plugin/completion/bridge.mjs';

const input = { prefix: '缓存可以', suffix: '。', title: '合成测试' };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function released(client: DshClient) {
  for (let i = 0; i < 100 && client.completionActive; i++) await pause(10);
  assert.equal(client.completionActive, false, 'slot is released only after bridge finishes cleanup');
}

test('unacknowledged completion cancellation exposes recovery state without releasing its slot or stopping chat', async () => {
  const frames: any[] = [];
  let stops = 0;
  const client = new DshClient({} as any, async () => ({}), () => {});
  const internals = client as any;
  internals.child = { exitCode: null };
  internals.start = async () => {};
  internals.send = (frame: unknown) => frames.push(frame);
  internals.stop = async () => { stops++; };
  internals.active = { id: 'unrelated-chat' };
  const controller = new AbortController();
  const pending = client.complete(input, controller.signal);
  const rejected = assert.rejects(pending, /取消/);
  await Promise.resolve();
  controller.abort(); await rejected;
  assert.equal(frames.at(-1).method, 'deepsidian/completion-cancel');
  assert.equal(client.completionActive, true);
  assert.equal(client.completionStalled, false);
  internals.completion.cancelledAt = Date.now() - 15001;
  assert.equal(client.completionStalled, true);
  await assert.rejects(client.complete(input, new AbortController().signal), /补全取消未完成，请在当前回答结束后重新连接/);
  assert.equal(client.completionActive, true);
  assert.equal(stops, 0);
  assert.equal(internals.active.id, 'unrelated-chat');
  // A late acknowledgement safely clears the recovery state; it does not resolve the cancelled caller.
  internals.receive({ id: internals.completion.id, error: { message: 'cancelled' } });
  assert.equal(client.completionActive, false);
  assert.equal(client.completionStalled, false);
});

test('completion bridge rejects non-success terminals and keeps slot during cancellation cleanup', async () => {
  let release!: () => void;
  let mode = 'stop';
  const replies: any[] = [];
  const ctx = { llm: {
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    prepareCall: async (config: object) => ({ config, async *stream(options: any) {
      if (mode === 'hold') {
        await new Promise<void>(resolve => { release = resolve; });
        options.signal.throwIfAborted();
      }
      yield { type: 'reasoning-delta', text: 'DO NOT DISPLAY' };
      yield { type: 'text-delta', text: mode === 'empty' ? ' ' : mode === 'marker' ? '  <NO_COMPLETION>  ' : '候选' };
      if (mode !== 'missing') yield { type: 'finish', reason: { kind: ['empty', 'marker'].includes(mode) ? 'stop' : mode } };
    } }),
  } };
  const bridge = completionBridge(ctx, (value: unknown) => value, (id: string, value: unknown) => replies.push({ id, value }));
  for (const scenario of ['stop', 'error', 'aborted', 'max-tokens', 'missing', 'empty', 'marker']) {
    mode = scenario;
    bridge.handle({ method: 'deepsidian/completion', params: { requestId: scenario, input } });
    await pause(0);
    const response = replies.at(-1).value;
    if (scenario === 'stop') assert.equal(response.result.text, '候选');
    else if (scenario === 'empty' || scenario === 'marker') assert.equal(response.result.text, '');
    else assert.ok(response.error, scenario);
  }
  mode = 'hold';
  bridge.handle({ method: 'deepsidian/completion', params: { requestId: 'held', input } });
  await pause(0);
  bridge.handle({ method: 'deepsidian/completion-cancel', params: { requestId: 'held' } });
  bridge.handle({ method: 'deepsidian/completion', params: { requestId: 'replacement', input } });
  assert.ok(replies.at(-1).value.error);
  assert.equal(replies.some(r => r.id === 'held'), false);
  release(); await pause(0);
  assert.ok(replies.find(r => r.id === 'held').value.error);
  await bridge.dispose();
});

for (const protocol of ['chat-completions', 'messages']) test(`real DSH ${protocol}: one-shot completion, outcomes, cancellation and chat isolation`, { timeout: 45000 }, async () => {
  const env = discover();
  mkdirSync('.runs', { recursive: true });
  const dir = mkdtempSync(resolve('.runs', 'completion-runtime-'));
  const home = join(dir, 'config'); mkdirSync(home);
  writeFileSync(join(home, 'settings.yaml'), JSON.stringify({ 'llm-deepseek': { protocol } }));
  let mode = 'stop'; let requests = 0; let chatEnds = 0; let chatHeld = false;
  let held!: () => void;
  let releaseChat!: () => void;
  const errors: unknown[] = [];
  const emit = (res: ServerResponse, content: string, outcome: string, close = true) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (value: object) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    if (protocol === 'chat-completions') {
      event({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
      if (close) {
        if (outcome !== 'missing') { event({ choices: [{ index: 0, delta: {}, finish_reason: outcome === 'max-tokens' ? 'length' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } }); res.write('data: [DONE]\n\n'); }
        res.end();
      }
    } else {
      event({ type: 'message_start', message: { id: 'synthetic', role: 'assistant', content: [], model: 'deepseek-flash', usage: { input_tokens: 20, output_tokens: 0 } } });
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } });
      if (close) {
        if (outcome !== 'missing') { event({ type: 'content_block_stop', index: 0 }); event({ type: 'message_delta', delta: { stop_reason: outcome === 'max-tokens' ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: 3 } }); event({ type: 'message_stop' }); }
        res.end();
      }
    }
  };
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      if (data.tools?.length) {
        if (chatHeld) { releaseChat = () => emit(res, 'CHAT-ANSWER', 'stop'); held(); return; }
        emit(res, 'CHAT-ANSWER', 'stop'); return;
      }
      requests++;
      assert.equal(req.headers['x-deepseek-harness-session-id'], undefined);
      assert.equal(data.model, 'deepseek-flash'); assert.equal(data.max_tokens, 128);
      assert.deepEqual(data.thinking, { type: 'disabled' });
      assert.equal((data.tools ?? []).length, 0);
      assert.match(JSON.stringify(data.messages), /缓存可以/);
      assert.doesNotMatch(JSON.stringify(data), /CHAT-QUESTION/);
      if (mode === 'error') { res.writeHead(429); res.end('{"error":{"message":"synthetic rate limit"}}'); return; }
      emit(res, mode === 'marker' ? '<NO_COMPLETION>' : '减少重复计算', mode, mode !== 'hold');
      if (mode === 'hold') held();
    } catch (error) { errors.push(error); res.writeHead(500); res.end('fixture failed'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const oldUrl = process.env.DEEPSEEK_BASE_URL, oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.DEEPSEEK_API_KEY = 'synthetic-local-only';
  const client = new DshClient({ packageRoot: env.root, nodePath: env.node, dshHome: home, runtimeHome: join(dir, 'runtime'), bridgePath: resolve('src/plugin/bridge.mjs'), cwd: dir, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }, async () => { throw Error('No tool allowed'); }, (method, data) => { if (method === 'session.event' && data.event.type === 'turn/end') chatEnds++; });
  try {
    const early = new AbortController(); early.abort(); await assert.rejects(client.complete(input, early.signal));
    assert.equal(requests, 0);
    const bootAbort = new AbortController();
    const booting = client.complete(input, bootAbort.signal); const bootRejected = assert.rejects(booting);
    bootAbort.abort(); await bootRejected; await released(client);
    assert.equal(requests, 0, 'cancellation during runtime startup prevents provider dispatch');
    const result = await client.complete(input, new AbortController().signal);
    assert.equal(result.text, '减少重复计算'); assert.ok(result.usage); assert.ok(result.elapsedMs >= 0);
    assert.equal(chatEnds, 0);
    const files = readdirSync(join(dir, 'runtime'), { recursive: true }).map(String);
    assert.equal(files.some(file => file.endsWith('.jsonl')), false, 'completion creates no durable chat session');
    mode = 'marker';
    assert.equal((await client.complete(input, new AbortController().signal)).text, '', 'abstention marker must never reach the editor');
    for (const scenario of ['max-tokens', 'missing', 'error']) {
      mode = scenario; const before = requests;
      await assert.rejects(client.complete(input, new AbortController().signal));
      assert.equal(requests, before + 1, 'failed completion never retries');
    }
    mode = 'hold'; const reached = new Promise<void>(resolve => { held = resolve; });
    const cancel = new AbortController(); const pending = client.complete(input, cancel.signal); const rejected = assert.rejects(pending);
    await reached;
    await assert.rejects(client.complete(input, new AbortController().signal), /清理/);
    cancel.abort(); await rejected; await released(client); assert.ok(client.connected);
    // A separate chat stays alive when a completion is cancelled.
    chatHeld = true; const chatReached = new Promise<void>(resolve => { held = resolve; });
    const chat = client.prompt(randomUUID(), 'CHAT-QUESTION'); await chatReached;
    const completionReached = new Promise<void>(resolve => { held = resolve; });
    const controller = new AbortController(); const concurrent = client.complete(input, controller.signal); const cancelled = assert.rejects(concurrent);
    await completionReached; controller.abort(); await cancelled; await released(client);
    assert.ok(client.connected); releaseChat(); assert.equal((await chat).kind, 'completed'); chatHeld = false;
    mode = 'stop'; assert.equal((await client.complete(input, new AbortController().signal)).text, '减少重复计算');
    if (protocol === 'chat-completions') {
      mode = 'hold'; const before = requests; const started = Date.now();
      await assert.rejects(client.complete(input, new AbortController().signal), /8 秒|超时/);
      assert.ok(Date.now() - started >= 7900); await released(client);
      assert.equal(requests, before + 1); assert.ok(client.connected, 'completion timeout must not stop the shared process');
    }
    mode = 'hold'; const closingReached = new Promise<void>(resolve => { held = resolve; });
    const closing = client.complete(input, new AbortController().signal); const disconnected = assert.rejects(closing);
    await closingReached; await client.stop(); await disconnected; assert.equal(client.completionActive, false);
    assert.deepEqual(errors, []);
  } finally {
    await client.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    oldUrl === undefined ? delete process.env.DEEPSEEK_BASE_URL : process.env.DEEPSEEK_BASE_URL = oldUrl;
    oldKey === undefined ? delete process.env.DEEPSEEK_API_KEY : process.env.DEEPSEEK_API_KEY = oldKey;
  }
});
