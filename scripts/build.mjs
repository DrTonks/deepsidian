import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
const bridge = await build({entryPoints:['src/plugin/bridge.mjs'],bundle:true,platform:'node',format:'esm',target:'es2022',write:false});
const bridgeSource = bridge.outputFiles[0].text;
const notices = await readFile('THIRD-PARTY-NOTICES.txt', 'utf8');
await build({ entryPoints: ['src/plugin/main.ts'], outfile: 'dist/main.js', bundle: true, platform: 'node', format: 'cjs', target: 'es2022', external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'], sourcemap: false,
  define: { __DEEPSIDIAN_BRIDGE_SOURCE__: JSON.stringify(bridgeSource) },
  banner: { js: `/*!\n${notices.replaceAll('*/', '* /')}\n*/` },
});
for (const file of ['manifest.json', 'styles.css', 'THIRD-PARTY-NOTICES.txt']) await copyFile(file, `dist/${file}`);
// Kept for source/developer tooling; community installations use the embedded copy.
await writeFile('dist/bridge.mjs', bridgeSource);
console.log('Built dist/: main.js, manifest.json, styles.css, bridge.mjs');
