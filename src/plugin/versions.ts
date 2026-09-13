export function compareVersions(a: string, b: string) {
  const parse = (v: string) => { const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v); if (!match) throw Error('无效版本号'); return { core: match.slice(1,4).map(Number), pre: match[4]?.split('.') }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const l = x.pre[i], r = y.pre[i]; if (l === r) continue;
    if (l === undefined) return -1; if (r === undefined) return 1;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    return ln && rn ? Number(l) - Number(r) : ln ? -1 : rn ? 1 : l < r ? -1 : 1;
  }
  return 0;
}
