import type { Chat } from './types';

/** Local search: no model request or vault read. */
export function searchChats(chats: Chat[], query: string): Chat[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return chats.filter(chat => {
    const text = `${chat.title}\n${chat.messages.map(message => message.text).join('\n')}`.toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}

export class SessionHistory {
  private panel: HTMLElement;
  private search: HTMLInputElement;
  private list: HTMLElement;
  private generation = 0;
  private outside = (event: Event) => {
    const path = event.composedPath();
    if (!path.includes(this.panel) && !path.includes(this.button)) this.close(false);
  };
  constructor(
    private host: HTMLElement,
    private button: HTMLButtonElement,
    private state: () => { chats: Chat[]; activeId: string; busy: boolean },
    private choose: (id: string) => Promise<void>,
  ) {
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    this.panel = host.createDiv({ cls: 'ds-history-popover', attr: { role: 'dialog', 'aria-label': '会话历史' } });
    this.panel.hidden = true;
    this.search = this.panel.createEl('input', { attr: { type: 'search', placeholder: '搜索会话标题或内容…', 'aria-label': '搜索会话标题或内容' } });
    this.list = this.panel.createDiv('ds-history-list');
    this.search.oninput = () => this.refresh();
    this.panel.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); return; }
      const rows = Array.from(this.list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = rows.indexOf(this.host.ownerDocument.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        rows[next]?.focus();
      } else if (event.key === 'Enter' && event.target === this.search) {
        event.preventDefault(); rows[0]?.click();
      }
    });
    button.onclick = () => this.panel.hidden ? this.open() : this.close();
    host.ownerDocument.addEventListener('pointerdown', this.outside, true);
    host.ownerDocument.addEventListener('focusin', this.outside);
  }
  private open() {
    this.generation++;
    this.search.value = '';
    this.panel.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.refresh(); this.search.focus();
  }
  close(restoreFocus = true) {
    this.generation++;
    const wasOpen = !this.panel.hidden;
    this.panel.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    if (wasOpen && restoreFocus) this.button.focus();
  }
  refresh() {
    if (this.panel.hidden) return;
    const state = this.state();
    const chats = searchChats(state.chats, this.search.value);
    const active = this.host.ownerDocument.activeElement as HTMLElement | null;
    const focusedId = active && this.list.contains(active) ? active.dataset.chatId : undefined;
    this.list.empty();
    if (state.busy) this.list.createDiv({ cls: 'ds-muted', text: '当前操作结束后可切换会话' });
    if (!chats.length) this.list.createDiv({ cls: 'ds-history-empty', text: state.chats.length ? '没有匹配的会话' : '暂无会话' });
    for (const chat of chats) {
      const row = this.list.createEl('button', { cls: 'ds-history-item', attr: { type: 'button', 'aria-current': String(chat.id === state.activeId) } });
      row.disabled = state.busy;
      row.dataset.chatId = chat.id;
      row.createSpan({ cls: 'ds-history-title', text: chat.title || '新对话' });
      row.createEl('small', { text: `${chat.messages.length} 条消息${chat.id === state.activeId ? ' · 当前' : ''}` });
      row.onclick = async () => {
        if (this.state().busy) return;
        const generation = this.generation;
        try { await this.choose(chat.id); if (this.generation === generation) this.close(); }
        catch { if (this.generation === generation) this.refresh(); } // The view reports persistence errors.
      };
    }
    if (focusedId) {
      const row = Array.from(this.list.querySelectorAll<HTMLButtonElement>('button')).find(item => item.dataset.chatId === focusedId && !item.disabled);
      (row ?? this.search).focus();
    }
  }
  dispose() {
    this.close(false);
    this.host.ownerDocument.removeEventListener('pointerdown', this.outside, true);
    this.host.ownerDocument.removeEventListener('focusin', this.outside);
  }
}
