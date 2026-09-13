import { cp, mkdir, access, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
const source = resolve('.');
const destination = resolve(process.argv[2] ?? '../publish/deepsidian');
const within = (base,path) => { const rel=relative(base,path); return !rel || (!rel.startsWith('..') && !isAbsolute(rel)); };
if (within(source,destination) || within(destination,source)) throw Error('Export must be outside the source tree and cannot contain the source tree.');
let exists = false; try { await access(destination); exists=true; } catch {}
if (exists) throw Error(`Export destination already exists: ${destination}. Choose a new empty path; nothing was overwritten.`);
const allow = ['src','scripts','tests','fixtures','docs','.github','.gitignore','.editorconfig','package.json','package-lock.json','tsconfig.json','manifest.json','styles.css','README.md','LICENSE','THIRD-PARTY-NOTICES.txt'];
// Reject symlinks in the allowlisted source tree, including junctions on Windows.
async function check(dir) { for (const entry of await readdir(dir,{withFileTypes:true})) { if(entry.isSymbolicLink()) throw Error(`Symlink is not exportable: ${join(dir,entry.name)}`); if(entry.isDirectory()) await check(join(dir,entry.name)); } }
for (const dir of ['src','scripts','tests','fixtures','docs','.github']) await check(dir);
await mkdir(destination,{recursive:true});
for (const name of allow) await cp(join(source,name),join(destination,name),{recursive:true,errorOnExist:true,force:false});
console.log(`Upload the contents of: ${destination}`);
console.log('Export excludes node_modules, dist, runtime, credentials, personal vaults, local experiments and Git history.');
