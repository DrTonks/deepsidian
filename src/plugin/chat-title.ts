import type { Chat } from './types';

export function nextForkTitle(parent: Chat, chats: readonly Chat[]): string {
  // Only strip generated suffixes from branches; a root may legitimately end in a number.
  const base = parent.fork
    ? parent.title.replace(/(?: · 分支)+$|（[1-9]\d*）$/u, '')
    : parent.title;
  const titles = new Set(chats.map(chat => chat.title));
  let number = 1;
  while (titles.has(`${base}（${number}）`)) number++;
  return `${base}（${number}）`;
}
