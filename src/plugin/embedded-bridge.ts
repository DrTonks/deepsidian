import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Replaced with the statically bundled bridge by scripts/build.mjs. No code is downloaded.
declare const __DEEPSIDIAN_BRIDGE_SOURCE__: string;

/** Community installs contain only main.js, manifest.json and styles.css. */
export async function embeddedBridgePath(runtimeHome: string): Promise<string> {
  if (typeof __DEEPSIDIAN_BRIDGE_SOURCE__ !== 'string' || !__DEEPSIDIAN_BRIDGE_SOURCE__) {
    throw Error('插件构建缺少内置 DSH 桥接，请重新安装完整发行版');
  }
  const source = __DEEPSIDIAN_BRIDGE_SOURCE__;
  const hash = createHash('sha256').update(source).digest('hex');
  const destination = join(runtimeHome, `bridge-${hash}.mjs`);
  await mkdir(runtimeHome, { recursive: true });
  try {
    if (await readFile(destination, 'utf8') === source) return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Atomic replacement avoids loading partial output during concurrent starts.
  const temporary = join(runtimeHome, `.bridge-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, source, { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  return destination;
}
