/** Per-vault persisted reservations; not a currency budget or an account-wide cap. */
export interface CompletionBudget {
  day:string; calls:number; recent:number[];
  shown:number; accepted:number;
}
export const DAILY_COMPLETIONS=200;
export function reserveCompletion(previous:CompletionBudget|undefined, now=Date.now()):CompletionBudget {
  const day=new Date(now).toISOString().slice(0,10);
  const same=previous?.day===day;
  const calls=same?Math.max(0,previous.calls||0):0;
  const recent=(previous?.recent??[]).filter(t=>Number.isFinite(t)&&t>now-60000);
  if(calls>=DAILY_COMPLETIONS)throw Error('今日补全调用额度已用完（本库每天 200 次，UTC 日期）');
  if(recent.length>=10 || recent.some(t=>now-t<2000))throw Error('补全请求过于频繁，请稍后再试');
  return {day,calls:calls+1,recent:[...recent,now],shown:same?previous.shown||0:0,accepted:same?previous.accepted||0:0};
}
export function completionExcluded(path:string, exclusions:string):boolean {
  const normalized=path.replaceAll('\\','/');
  return exclusions.split(/\r?\n/).map(p=>p.trim().replaceAll('\\','/').replace(/^\/+|\/+$/g,'')).filter(Boolean)
    .some(p=>normalized===p || normalized.startsWith(p+'/'));
}
