import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { discover } from '../src/plugin/dsh.ts';
import { messagesResponse } from './fixtures/messages.ts';

test('community three-file installation runs chat, restart and isolated organizer with its embedded bridge', { timeout: 90000 }, async () => {
  const env = discover();
  await promisify(execFile)(process.execPath, ['scripts/build.mjs']);
  await mkdir('.runs', { recursive: true });
  const vault = await mkdtemp(resolve('.runs/community-package-'));
  const pluginDir = join(vault, '.obsidian/plugins/deepsidian');
  await mkdir(pluginDir, { recursive: true });
  for (const file of ['main.js', 'manifest.json', 'styles.css']) {
    await copyFile(join('dist', file), join(pluginDir, file));
  }
  assert.deepEqual((await readdir(pluginDir)).sort(), ['main.js', 'manifest.json', 'styles.css']);
  const source = await readFile(join(pluginDir, 'main.js'), 'utf8');
  assert.match(source, /Copyright \(c\) 2026 DeepSeek/);
  assert.match(source, /Permission is hereby granted, free of charge/);
  // Load the actual shipped bundle, replacing only Obsidian's unavailable Node host.
  const mock = await build({ entryPoints: ['tests/host-obsidian.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
  const require = createRequire(resolve('package.json'));
  const load = (code: string, resolver: (id: string) => unknown) => {
    const module = { exports: {} as any };
    new Function('require', 'module', 'exports', code)(resolver, module, module.exports);
    return module.exports;
  };
  const obsidian = load(mock.outputFiles[0]!.text, require);
  const Plugin = load(source, id => id === 'obsidian' ? obsidian : require(id)).default;
  const plugin = new Plugin();
  plugin.app.vault = { configDir: '.obsidian', adapter: Object.assign(new obsidian.FileSystemAdapter(), { getBasePath: () => vault }) };
  plugin.manifest = JSON.parse(await readFile(join(pluginDir, 'manifest.json'), 'utf8'));
  Object.assign(plugin.state.settings, { checkUpdates: false, webSearch: false, webFetch: false, manageMemory: false });
  const home = join(vault, 'synthetic-dsh-home');
  await mkdir(home);
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    messagesResponse(res, { text: 'THREE-FILE-PACKAGE-OK' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await writeFile(join(home, 'settings.yaml'), JSON.stringify({
    'llm-deepseek': { baseURL: `http://127.0.0.1:${(server.address() as any).port}` },
  }));
  const oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'synthetic-package-test-key';
  plugin.resolveEnvironment = () => ({ ...env, home, model: { provider: 'deepseek-official', model: 'deepseek-flash' } });
  try {
    let client = await plugin.connect();
    assert.equal((await client.prompt(randomUUID(), 'THREE-FILE-FIRST')).kind, 'completed');
    const bridgePath = client.options.bridgePath;
    assert.match(bridgePath, /[\\/]\.runtime[\\/]bridge-[a-f0-9]{64}\.mjs$/);
    const bridge = await readFile(bridgePath, 'utf8');
    assert.match(bridge, /deepsidian\/completion/);
    await plugin.disconnect();
    // A damaged generated file must be repaired from the installed bundle on reconnect.
    await writeFile(bridgePath, 'corrupted local runtime artifact');
    client = await plugin.connect();
    assert.equal(await readFile(bridgePath, 'utf8'), bridge);
    assert.equal((await client.prompt(randomUUID(), 'THREE-FILE-RESTART')).kind, 'completed');
    await plugin.disconnect();
    assert.equal(await plugin.runMemoryModel('THREE-FILE-ORGANIZER', new AbortController().signal), 'THREE-FILE-PACKAGE-OK');
    assert.equal(requests.length, 3);
    assert.ok(requests[0].tools.length > 0, 'foreground bridge exposes host tools');
    assert.equal(requests[2].tools?.length ?? 0, 0, 'organizer stays isolated without host tools');
    assert.equal((await readdir(pluginDir)).includes('bridge.mjs'), false);
  } finally {
    await plugin.disconnect();
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldKey;
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});
