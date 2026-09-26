import type {CompletionBudget} from './completion/budget';
import type { NoteContext } from './context';
import type { TraceEntry } from './trace';
import type { UpdateInfo } from './updates';
import type { IdleMemoryState } from './memory/scheduler';

export const VIEW = 'deepsidian-learning';
export interface Settings { completionEnabled:boolean; completionExcluded:string; packageRoot: string; nodePath: string; dshHome: string; provider: string; model: string; background: string; checkUpdates: boolean; reasoningEffort: string; maxTokens: number; webSearch: boolean; webFetch: boolean; setupComplete: boolean; autoConnect: boolean; useMemory: boolean; idleMemory:boolean; manageMemory:boolean; }
export interface ContextManifest { version:1; createdAt:number; items:{id?:string;kind:'note'|'attachment'|'image';label:string;chars?:number;bytes?:number;hash:string;text?:string}[]; memoryEnabled:boolean; historyMessages:number; inheritedMessages:number; promptChars:number; }
export interface ChatDraft { text:string; context?:NoteContext; }
export interface Message { manifest?:ContextManifest; role: 'user' | 'assistant'; text: string; source?: NoteContext; status?: string; attachments?: string[]; model?: string; reasoning?: string; trace?: TraceEntry[]; startedAt?: number; elapsedMs?: number; forkSeq?: number; }
export interface Chat { draft?:ChatDraft; id: string; title: string; messages: Message[]; systemPrompt?: string; goal?: string; useMemory?: boolean; contributeMemory?: boolean; memoryStart?: { index:number; key:string }; memoryPolicyVersion?:number; fork?: { parentId:string; parentTitle:string; messageIndex:number; atSeq:number; inheritedMessages:number; inheritedKey:string }; }
export interface Saved { completionBudget?:CompletionBudget; settings: Settings; chats: Chat[]; activeId: string; updates?: UpdateInfo; idleMemory?:IdleMemoryState; }
export const defaults: Settings = { completionEnabled:false, completionExcluded:'', packageRoot: '', nodePath: '', dshHome: '', provider: '', model: '', background: '', checkUpdates: true, reasoningEffort: '', maxTokens: 4096, webSearch: true, webFetch: true, setupComplete: false, autoConnect: true, useMemory: true, idleMemory:false, manageMemory:true };
