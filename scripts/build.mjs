import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/plugin/main.ts'], outfile: 'dist/main.js', bundle: true, platform: 'node', format: 'cjs', target: 'es2022', external: ['obsidian', 'electron'], sourcemap: false });
for (const file of ['manifest.json', 'styles.css', 'THIRD-PARTY-NOTICES.txt']) await copyFile(file, `dist/${file}`);
await copyFile('src/plugin/bridge.mjs', 'dist/bridge.mjs');
console.log('Built dist/: main.js, manifest.json, styles.css, bridge.mjs');
