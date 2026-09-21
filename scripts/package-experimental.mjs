/** Build is run by npm script before this command. Creates an installable folder, no user data. */
import {mkdir,copyFile,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {TESTED_DSH} from '../src/plugin/versions.ts';
const commit=execFileSync('git',['rev-parse','--short=12','HEAD'],{encoding:'utf8'}).trim();
const dirty=!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim();
const manifest=JSON.parse(await readFile('dist/manifest.json','utf8'));
const tag=`tab-preview-${commit}${dirty?'-working':''}-${Date.now()}`;
const directory=join('dist',tag,'deepsidian');await mkdir(directory,{recursive:true});
for(const file of ['main.js','manifest.json','styles.css','bridge.mjs','THIRD-PARTY-NOTICES.txt'])await copyFile(join('dist',file),join(directory,file));
await copyFile('docs/TAB-COMPLETION-EXPERIMENT.md',join(directory,'EXPERIMENT-GUIDE.md'));
await writeFile(join(directory,'EXPERIMENT.txt'),`Deepsidian manual Tab completion preview\nBase version: ${manifest.version}\nBase commit: ${commit}\nUncommitted modifications included: ${dirty}\nChannel: experimental; not a stable release\nVerified DSH baseline: ${TESTED_DSH}\nInstall into a separate test vault at .obsidian/plugins/deepsidian with the plugin disabled, then reload.\nEnable manual completion in plugin settings. Nothing triggers automatically.\nRollback: disable plugin, replace build files with the verified stable build, reload. Preserve data.json and runtime/memory folders.\nSee EXPERIMENT-GUIDE.md for scope and validation.\n`);
console.log(`Installable experimental folder: ${directory}`);
