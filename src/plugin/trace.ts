/** A readable projection of DSH events; the full authoritative log stays in DSH. */
export interface TraceUsage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; }
export interface TraceEntry { type: string; at: number; detail: string; turn?: number; step?: number; preview?: string; callId?: string; usage?: TraceUsage; }
export function reasoningText(stream: any[]): string {
  return (stream ?? []).map(r => r.type === 'reasoning-chunks' ? r.texts.join('') : r.type === 'chunk' && r.chunk.type === 'reasoning-delta' ? r.chunk.text : '').join('');
}
export function enrichTraceEntry(entry: TraceEntry): TraceEntry {
  if (entry.preview !== undefined) return entry;
  try {
    const enriched = traceEntry({ type: entry.type, data: JSON.parse(entry.detail) });
    return { ...enriched, at: entry.at, detail: entry.detail, usage: entry.usage ?? enriched.usage };
  }
  catch { return entry; }
}
export function traceEntry(event: any): TraceEntry {
  const data = event.type === 'assistant/message'
    ? { turn: event.data.turn, step: event.data.step, message: event.data.message, usage: event.data.usage, interrupted: event.data.interrupted }
    : event.data;
  const text = JSON.stringify(data, null, 2) ?? '';
  const message = data.message ?? (event.type === 'user/message' ? data : undefined);
  const blockText = (blocks: any[]): string => (blocks ?? []).map(b => b.type === 'text' ? b.text : b.type === 'image' ? `[图片：${b.attachment?.name ?? '附件'}]` : b.type === 'tool-result' ? blockText(b.content) : '').filter(Boolean).join('\n');
  const content = blockText(message?.content);
  // Keep accounting separate from the bounded, potentially truncated display snapshot.
  const usage: TraceUsage | undefined = event.type === 'assistant/message' && data.usage ? { ...data.usage } : undefined;
  return { type: event.type, at: Date.now(), turn: data.turn, step: data.step, usage, preview: (content || (event.type === 'tool/call' ? `${data.name} ${data.arguments}` : '')).slice(0, 500), callId: data.callId ?? message?.content?.[0]?.callId, detail: text.length > 24000 ? text.slice(0,24000) + '\n…界面快照已截断，完整内容见 DSH 会话日志。' : text };
}
export const eventLabels: Record<string, string> = {
  'turn/start': '开始一轮对话', 'turn/end': '结束本轮', 'step/start': '开始模型调用', 'step/end': '完成一步',
  'system/message': '系统提示词', 'user/message': '发送给模型的上下文', 'assistant/message': '模型回答与用量',
  'assistant/attempt': '未提交的模型尝试', 'tool/call': '调用工具', 'tool/result': '工具返回',
  'request/header': '请求配置', 'request/context': '模型能力与上下文',
};
export function eventTitle(entry: TraceEntry): string {
  try {
    const data = JSON.parse(entry.detail);
    if (entry.type === 'tool/call') return `调用 ${data.name} · ${data.arguments}`;
    if (entry.type === 'tool/result') {
      const block = data.message?.content?.[0];
      return `${block?.isError ? '工具失败' : '工具返回'} · ${block?.callId ?? ''}`;
    }
    if (entry.type === 'step/start') return `第 ${data.step} 步 · 调用模型`;
  } catch { /* Truncated snapshots still have a usable event label. */ }
  return eventLabels[entry.type] ?? entry.type;
}
export function usageSummary(entries: TraceEntry[]): string {
  const usage = entries.filter(e => e.type === 'assistant/message').flatMap(e => {
    if (e.usage) return [e.usage];
    // Older saved entries only stored usage inside the display JSON.
    try { const u = JSON.parse(e.detail).usage; return u ? [u] : []; } catch { return []; }
  });
  if (!usage.length) return '用量未报告';
  const input = usage.reduce((n, u) => n + u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0), 0);
  const output = usage.reduce((n, u) => n + u.outputTokens, 0);
  const cache = usage.every(u => typeof u.cacheReadTokens === 'number') && input > 0
    ? ` · 缓存读取 ${Math.round(usage.reduce((n,u) => n + u.cacheReadTokens, 0) / input * 100)}%` : '';
  return `输入 ${input.toLocaleString()} · 输出 ${output.toLocaleString()} tokens${cache}`;
}
