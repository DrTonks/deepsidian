import type { NoteContext } from './context';
import type { TraceEntry } from './trace';
import type { UpdateInfo } from './updates';

export const VIEW = 'deepsidian-learning';
export interface Settings { packageRoot: string; nodePath: string; dshHome: string; provider: string; model: string; background: string; checkUpdates: boolean; reasoningEffort: string; maxTokens: number; webSearch: boolean; webFetch: boolean; setupComplete: boolean; autoConnect: boolean; }
export interface Message { role: 'user' | 'assistant'; text: string; source?: NoteContext; status?: string; attachments?: string[]; model?: string; reasoning?: string; trace?: TraceEntry[]; startedAt?: number; elapsedMs?: number; }
export interface Chat { id: string; title: string; messages: Message[]; systemPrompt?: string; goal?: string; }
export interface Saved { settings: Settings; chats: Chat[]; activeId: string; updates?: UpdateInfo; }
export const defaults: Settings = { packageRoot: '', nodePath: '', dshHome: '', provider: '', model: '', background: '', checkUpdates: true, reasoningEffort: '', maxTokens: 4096, webSearch: true, webFetch: true, setupComplete: false, autoConnect: true };

