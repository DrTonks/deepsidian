import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoveryCandidates } from '../src/plugin/discovery.ts';
import { DshClient } from '../src/plugin/dsh.ts';

test('Finder PATH still discovers Apple Silicon and Intel Homebrew layouts', () => {
  const result = discoveryCandidates({ platform: 'darwin', path: '/usr/bin:/bin', home: '/Users/test' });
  assert.ok(result.nodes.includes('/opt/homebrew/bin/node'));
  assert.ok(result.roots.includes('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'));
  assert.ok(result.roots.includes('/usr/local/lib/node_modules/@deepseek-ai/dsh'));
  assert.ok(!result.nodes.some(p => p.includes('Electron')));
});

test('explicit paths take precedence and Unix version manager prefixes are supported', () => {
  const result = discoveryCandidates({ platform: 'darwin', path: '/Users/test/.nvm/versions/node/v24/bin:/usr/bin', home: '/Users/test', nodePath: '/custom prefix/bin/node', packageRoot: '/custom dsh', envRoot: '/env dsh' });
  assert.equal(result.nodes[0], '/custom prefix/bin/node');
  assert.deepEqual(result.roots.slice(0, 2), ['/custom dsh', '/env dsh']);
  assert.ok(result.roots.includes('/custom prefix/lib/node_modules/@deepseek-ai/dsh'));
  assert.ok(result.roots.includes('/Users/test/.nvm/versions/node/v24/lib/node_modules/@deepseek-ai/dsh'));
});

test('Windows roaming npm and Linux custom npm prefixes remain discoverable', () => {
  const windows = discoveryCandidates({ platform: 'win32', path: 'C:\\Program Files\\nodejs;C:\\tools', home: 'C:\\Users\\test', appData: 'C:\\Users\\test\\AppData\\Roaming' });
  assert.ok(windows.nodes.includes('C:\\Program Files\\nodejs\\node.exe'));
  assert.ok(windows.roots.includes('C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh'));
  const linux = discoveryCandidates({ platform: 'linux', path: '/usr/bin', home: '/home/test', npmPrefix: '/home/test/.npm-global' });
  assert.ok(linux.roots.includes('/home/test/.npm-global/lib/node_modules/@deepseek-ai/dsh'));
});

test('cancel works when the host global timer returns a browser timer ID', () => {
  const client = new DshClient({} as any, async () => ({}), () => {});
  const frames: any[] = [];
  (client as any).active = { id: 'synthetic-session' };
  (client as any).send = (frame: any) => frames.push(frame);
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (() => 123) as any;
  try {
    assert.doesNotThrow(() => client.cancel());
    assert.equal(frames[0].method, 'deepsidian/cancel');
    assert.equal(frames[0].params.sessionId, 'synthetic-session');
  } finally {
    globalThis.setTimeout = original;
    (client as any).active = undefined;
  }
});
