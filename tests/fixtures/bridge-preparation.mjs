// Deterministic DSH service fixture: the production bridge and client run unchanged.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
process.env.DEEPSIDIAN_DSH_PACKAGE = process.argv[2];
const { apply } = await import(pathToFileURL(process.argv[3]).href);
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
let stage, stored = false, release;
const agents = new Map();
const wait = async name => {
  if (stage !== name) return;
  stage = undefined;
  await new Promise(resolve => { release = resolve; send({ method: 'test/preparing', params: { stage: name } }); });
};
const handle = async (sessionId, operation) => {
  await wait(operation);
  const agent = {
    followup(message) {
      send({ method: 'test/submitted', params: { sessionId, message } });
      setImmediate(() => send({ method: 'session.event', params: { sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } }));
    },
    cancel() { throw Error('An idle agent must not be cancelled during prompt preparation'); },
  };
  agents.set(sessionId, agent);
  return { agent, async dispose() {} };
};
createInterface({ input: process.stdin }).on('line', async line => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') send({ id: frame.id, result: {} });
  if (frame.method === 'test/configure') {
    ({ stage, stored = false } = frame.params);
    send({ id: frame.id, result: {} });
  }
  if (frame.method === 'test/release') {
    release?.(); release = undefined;
    // Drain the released preparation chain before acknowledging the barrier.
    setImmediate(() => send({ id: frame.id, result: {} }));
  }
});
apply({
  tools: { register() {} },
  llm: { async resolveModelInfo() { await wait('model'); return { inputModalities: ['image'] }; } },
  attachments: { async saveImages() { await wait('images'); return []; } },
  sessionPersistence: { async stat() { await wait('stat'); return stored ? {} : undefined; } },
  agents: { get: id => agents.get(id), create: ({ sessionId }) => handle(sessionId, 'create'), resume: ({ resumeSessionId }) => handle(resumeSessionId, 'resume') },
  on() {},
});
