import type { Chat } from './types';
import { enrichTraceEntry, eventLabels, type TraceEntry } from './trace.ts';

type Lane = 'input' | 'model' | 'tool';
export interface Span { lane: Lane; start: number; end: number; label: string; open?: boolean; }
export function timeline(entries: TraceEntry[], now: number): Span[] {
  const spans: Span[] = [], calls = new Map<string, TraceEntry>();
  let model: TraceEntry | undefined;
  for (const event of entries) {
    if (['system/message', 'user/message', 'request/context'].includes(event.type)) spans.push({lane:'input', start:event.at, end:event.at, label:eventLabels[event.type] ?? event.type});
    if (event.type === 'step/start') model = event;
    if (['assistant/message','assistant/attempt','step/end','turn/end'].includes(event.type) && model) {
      spans.push({lane:'model', start:model.at, end:Math.max(model.at,event.at), label:'模型阶段（含运行时准备）'}); model = undefined;
    }
    if (event.type === 'tool/call') calls.set(event.callId ?? String(event.at), event);
    if (event.type === 'tool/result') {
      const start = calls.get(event.callId ?? '');
      if (start) { spans.push({lane:'tool', start:start.at, end:Math.max(start.at,event.at), label:start.preview ?? '工具执行'}); calls.delete(event.callId!); }
    }
  }
  if (model) spans.push({lane:'model', start:model.at, end:Math.max(model.at,now), label:'模型阶段 · 未收到结束事件', open:true});
  for (const event of calls.values()) spans.push({lane:'tool', start:event.at, end:Math.max(event.at,now), label:'工具 · 未收到结束事件', open:true});
  return spans;
}
function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls: string, text?: string) {
  const element = document.createElement(tag); element.className = cls; if (text) element.textContent = text; parent.append(element); return element;
}
function role(event: TraceEntry) {
  if (event.type === 'system/message') return ['system','系统'];
  if (event.type === 'user/message') return ['user','用户'];
  if (event.type.startsWith('assistant/')) return ['assistant','助手'];
  if (event.type.startsWith('tool/') || event.type.startsWith('web/')) return ['tool','工具'];
  if (event.type.startsWith('request/')) return ['context','上下文'];
  return ['event','事件'];
}
interface State { chat?: Chat; busy: boolean; mode: string; query: string; graph: HTMLElement; rows: HTMLElement; footer: HTMLElement; }
const states = new WeakMap<HTMLElement, State>();
export function renderTraceView(root: HTMLElement, chat: Chat | undefined, busy: boolean) {
  let state = states.get(root);
  if (!state || !root.contains(state.rows)) {
    root.replaceChildren();
    const shell = el(root,'div','ds-trace');
    const toolbar = el(shell,'div','ds-trace-toolbar');
    const modes = el(toolbar,'div','ds-trace-modes');
    const search = el(toolbar,'input','ds-trace-search'); search.type = 'search'; search.placeholder = '搜索轨迹'; search.setAttribute('aria-label','搜索轨迹');
    state = {chat,busy,mode:'duration',query:'',graph:el(shell,'div','ds-timeline'),rows:el(shell,'div','ds-trace-rows'),footer:el(shell,'div','ds-trace-footer')};
    const current = state;
    for (const [id,label] of [['duration','时长'],['round','轮次'],['calls','调用']]) {
      const button = el(modes,'button','',label); button.setAttribute('aria-pressed',String(id === current.mode));
      button.onclick = () => { current.mode = id; for (const b of Array.from(modes.children)) b.setAttribute('aria-pressed',String(b === button)); draw(current); };
    }
    search.oninput = () => { current.query = search.value; draw(current); };
    states.set(root,state);
  }
  state.chat = chat; state.busy = busy; draw(state);
}
function draw(state: State) {
  const entries = (state.chat?.messages ?? []).flatMap((m, round) => (m.trace ?? []).map((event, index) => ({event:enrichTraceEntry(event), round:Math.floor(round/2)+1, key:`${round}-${index}`})));
  const open = new Set(Array.from(state.rows.querySelectorAll('details[open]')).map(e => e.getAttribute('data-key')));
  state.rows.replaceChildren(); state.graph.replaceChildren();
  if (!entries.length) { el(state.rows,'p','ds-muted','此会话没有已保存的轨迹。新对话运行后会显示真实事件。'); state.footer.textContent = ''; return; }
  const first = Math.min(...entries.map(e => e.event.at)), last = Math.max(...entries.map(e => e.event.at));
  const end = state.busy ? Math.max(Date.now(),last) : last;
  for (const [lane,label] of [['input','输入'],['model','模型'],['tool','工具']] as const) {
    const row = el(state.graph,'div','ds-timeline-lane'); el(row,'span','ds-lane-label',label); const track = el(row,'div','ds-lane-track');
    for (const span of timeline(entries.map(e => e.event),end).filter(s => s.lane === lane)) {
      const bar = el(track,'span',`ds-span ds-span-${lane}${span.open ? ' ds-span-open' : ''}`);
      bar.style.left = `${(span.start-first)/Math.max(1,end-first)*100}%`;
      bar.style.width = `${Math.max(.3,(span.end-span.start)/Math.max(1,end-first)*100)}%`;
      bar.title = `${span.label} · ${((span.end-span.start)/1000).toFixed(2)} 秒`;
    }
  }
  const visible = entries.filter(({event}) => state.mode === 'calls' ? event.type.startsWith('tool/') || event.type.startsWith('web/') : !['turn/start','turn/end','step/start','step/end'].includes(event.type));
  let previousRound = -1;
  for (const {event,round,key} of visible) {
    if (state.query && !`${event.type} ${event.preview ?? ''} ${event.detail}`.toLocaleLowerCase().includes(state.query.toLocaleLowerCase())) continue;
    if (state.mode === 'round' && round !== previousRound) { el(state.rows,'div','ds-round-heading',`第 ${round} 轮`); previousRound = round; }
    const detail = el(state.rows,'details','ds-trace-row'); detail.dataset.key = key; detail.open = open.has(key);
    const summary = el(detail,'summary','ds-trace-row-summary');
    el(summary,'span','ds-trace-time',state.mode === 'duration' ? `+${((event.at-first)/1000).toFixed(1)}s` : `第 ${round} 轮`);
    const [kind,label] = role(event); el(summary,'span',`ds-role ds-role-${kind}`,label);
    el(summary,'span','ds-trace-preview',event.preview || eventLabels[event.type] || event.type);
    el(detail,'pre','ds-trace-detail',event.detail);
  }
  state.footer.textContent = `${entries.length} 个事件 · ${((end-first)/1000).toFixed(1)} 秒 · 按宿主接收时间排列；短线为输入事件，模型阶段含运行时准备。`;
}
