import { SessionHistory, searchChats } from '../../src/plugin/history';
import type { Chat } from '../../src/plugin/types';

/** Browser regression checks against the actual component, using synthetic state. */
export async function checkHistory(root: HTMLElement) {
  const report = root.createEl('pre');
  const check = (condition: boolean, name: string) => {
    if (!condition) throw new Error(name);
    report.append(`PASS ${name}\n`);
  };
  const host = root.createDiv();
  const trigger = host.createEl('button', { text: 'Test history' });
  const chats: Chat[] = [
    { id: 'a', title: 'KV cache', messages: [{ role: 'user', text: '增量计算' }] },
    { id: 'b', title: 'Agent', messages: [{ role: 'assistant', text: '工具调用' }] },
  ];
  let busy = false, release = () => {}, selected = '';
  const history = new SessionHistory(host, trigger, () => ({ chats, activeId: 'a', busy }), async id => {
    selected = id; await new Promise<void>(resolve => { release = resolve; });
  });
  const panel = host.querySelector<HTMLElement>('[role=dialog]')!;
  const input = panel.querySelector('input')!;
  const rows = () => Array.from(panel.querySelectorAll<HTMLButtonElement>('.ds-history-item'));
  try {
    check(searchChats(chats, ' CACHE 增量 ').map(c => c.id).join() === 'a' && searchChats(chats, 'missing').length === 0, 'title/body search, case, whitespace and no result');
    trigger.click(); check(document.activeElement === input && !panel.hidden, 'open focuses search');
    rows()[1]!.focus(); history.refresh();
    check(document.activeElement === rows()[1], 'refresh preserves focused conversation');
    busy = true; history.refresh();
    check(document.activeElement === input && rows().every(row => row.disabled), 'busy refresh falls back to search and disables selection');
    busy = false; history.refresh();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    check(document.activeElement === rows()[0], 'arrow key selects first result');
    rows()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check(panel.hidden && document.activeElement === trigger, 'Escape closes and restores trigger focus');
    trigger.click(); rows()[1]!.click();
    history.close(false); trigger.click(); input.value = 'cache'; input.dispatchEvent(new Event('input'));
    release(); await Promise.resolve(); await Promise.resolve();
    check(selected === 'b' && !panel.hidden && document.activeElement === input, 'old async selection cannot close reopened search');
    const outside = root.createEl('button', { text: 'Outside' }); outside.focus();
    check(panel.hidden && document.activeElement === outside, 'outside focus closes without stealing focus');
    trigger.click(); history.dispose(); outside.focus();
    check(panel.hidden, 'dispose closes popup');
    report.append('ALL 9 HISTORY CHECKS PASSED');
  } catch (error) { report.append(`FAIL ${String(error)}`); throw error; }
  finally { history.dispose(); host.remove(); }
}
