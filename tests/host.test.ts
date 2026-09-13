import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
await mkdir('.runs',{recursive:true});const dir=await mkdtemp(resolve('.runs/host-test-'));
const outfile=join(dir,'host.mjs');
await build({entryPoints:['src/plugin/main.ts'],outfile,bundle:true,platform:'node',format:'esm',alias:{obsidian:resolve('tests/host-obsidian.ts')}});
const Deepsidian=(await import(pathToFileURL(outfile).href)).default;
test('auto connection waits for layout, honors opt-out, and ignores late layout after unload',async()=>{
  const old=(globalThis as any).window;(globalThis as any).window={setInterval:()=>0};
  try {
    for(const [enabled,unload,expected] of [[true,false,1],[false,false,0],[true,true,0]] as const){
      const p=new Deepsidian();p.saved={settings:{autoConnect:enabled},chats:[{id:'test',title:'test',messages:[]}],activeId:'test'};
      let calls=0;p.connect=async()=>{calls++;};await p.onload();assert.equal(calls,0);
      if(unload)p.onunload();p.ready();await Promise.resolve();assert.equal(calls,expected);
    }
  }finally{(globalThis as any).window=old;}
});
test('concurrent connection requests share one start and wait for an in-progress stop',async()=>{
  const p=new Deepsidian();let starts=0;let release!:()=>void;
  p.connectRuntime=async()=>{starts++;await new Promise<void>(r=>release=r);return {connected:true};};
  const first=p.connect(),second=p.connect();await Promise.resolve();assert.equal(starts,1);release();assert.equal(await first,await second);
  let finishStop!:()=>void;p.client={connected:true,stop:()=>new Promise<void>(r=>finishStop=r)};
  const stopping=p.disconnect();await Promise.resolve();const third=p.connect();await Promise.resolve();assert.equal(starts,1);
  finishStop();await stopping;await Promise.resolve();assert.equal(starts,2);release();await third;
});
test('host commands keep management out of model calls and persist a bounded session goal',async()=>{
  const p=new Deepsidian();p.state.chats=[{id:'a',title:'a',messages:[]}];p.state.activeId='a';let saved=0,opened=0;
  p.persist=async()=>{saved++;};p.openMemory=()=>{opened++;};
  await p.runCommand('/memory');assert.equal(opened,1);
  await p.runCommand('/goal 理解注意力');assert.equal(p.chat.goal,'理解注意力');assert.equal(saved,1);
  await p.runCommand('/goal clear');assert.equal(p.chat.goal,undefined);
  assert.match((await p.runCommand('/plan KV cache')).question,/本轮仅研究和规划/);
  await assert.rejects(()=>p.runCommand('/unknown'),/未知/);
  await assert.rejects(()=>p.runCommand('/memory discard'),/不接受/);
  p.busy=true;await assert.rejects(()=>p.runCommand('/goal new'),/结束/);
});
