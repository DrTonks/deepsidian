import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reserveCompletion,completionExcluded} from '../src/plugin/completion/budget.ts';
test('completion reservations survive reload, enforce minute/day caps, reset by UTC day',()=>{
  const now=Date.UTC(2026,8,22,10);
  let budget=reserveCompletion(undefined,now);
  assert.throws(()=>reserveCompletion(JSON.parse(JSON.stringify(budget)),now+1999),/频繁/);
  for(let i=1;i<10;i++)budget=reserveCompletion(budget,now+i*2100);
  assert.throws(()=>reserveCompletion(budget,now+30000),/频繁/);
  budget=reserveCompletion(budget,now+60001);assert.equal(budget.calls,11);
  budget.calls=200;assert.throws(()=>reserveCompletion(budget,now+120000),/额度/);
  const tomorrow=reserveCompletion(budget,now+86400000);assert.equal(tomorrow.calls,1);assert.equal(tomorrow.shown,0);
});
test('completion exclusions match whole files/folders including Windows separators',()=>{
  assert.equal(completionExcluded('私人/笔记.md','私人\n日记/草稿.md'),true);
  assert.equal(completionExcluded('私人副本/笔记.md','私人'),false);
  assert.equal(completionExcluded('日记\\草稿.md','日记/草稿.md'),true);
  assert.equal(completionExcluded('日记/其他.md','日记/草稿.md'),false);
  assert.equal(completionExcluded('笔记.md',''),false);
});
