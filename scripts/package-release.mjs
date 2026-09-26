/** Stage exactly the files the Obsidian community installer downloads. */
import {mkdir,readFile,copyFile} from 'node:fs/promises';
const manifest=JSON.parse(await readFile('dist/manifest.json','utf8'));
const source=JSON.parse(await readFile('manifest.json','utf8'));
const pkg=JSON.parse(await readFile('package.json','utf8'));
if(!/^\d+\.\d+\.\d+$/.test(manifest.version)||manifest.version!==pkg.version||JSON.stringify(manifest)!==JSON.stringify(source))throw Error('Release manifest/version does not match source and package.json');
const target=`dist/release/${manifest.version}`;
await mkdir(target,{recursive:true});
for(const file of ['main.js','manifest.json','styles.css'])await copyFile(`dist/${file}`,`${target}/${file}`);
console.log(`Community release assets: ${target} (3 files; upload individually, not only as a ZIP)`);
