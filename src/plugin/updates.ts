import { get } from 'node:https';
export interface UpdateInfo { checkedAt: number; attemptedAt: number; newest?: string; latest?: string; next?: string; error?: string; }
import { compareVersions } from './versions.ts';
export { compareVersions } from './versions.ts';
export async function checkUpdates(previous?: UpdateInfo, force = false): Promise<UpdateInfo> {
  const now = Date.now();
  if (!force && previous && now - previous.attemptedAt < (previous.error ? 15 * 60000 : 24 * 3600000)) return previous;
  try {
    const tags = await new Promise<Record<string,string>>((resolve, reject) => {
      const req = get('https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags', { headers: { Accept: 'application/json' } }, response => {
        if (response.statusCode !== 200) { response.resume(); reject(Error(`HTTP ${response.statusCode}`)); return; }
        let text = ''; response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; if (text.length > 100000) req.destroy(Error('版本响应过大')); });
        response.on('error', reject);
        response.on('end', () => { try { resolve(JSON.parse(text)); } catch { reject(Error('版本响应无法解析')); } });
      });
      req.setTimeout(8000, () => req.destroy(Error('网络超时'))); req.on('error', reject);
    });
    const candidates = Object.values(tags).filter(v => typeof v === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v));
    if (!candidates.length) throw Error('没有有效发布标签');
    const newest = candidates.sort(compareVersions).at(-1)!;
    return { checkedAt: now, attemptedAt: now, newest, latest: tags.latest, next: tags.next };
  } catch (error) { return { ...previous, checkedAt: previous?.checkedAt ?? 0, attemptedAt: now, error: String(error) }; }
}
