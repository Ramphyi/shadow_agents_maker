import { create } from 'zustand';
import type { AuditEntry, ChatMessage, Note, Snapshot } from './types';

export type View = 'realm' | 'forge' | 'tools' | 'gateway' | 'inbox' | 'settings';
export type Status = 'connecting' | 'online' | 'offline' | 'unauthorized';
interface Toast { id: number; text: string; tone: 'ok' | 'bad' }

interface State {
  status: Status;
  conn: { url: string; token: string; home: string };
  data: Snapshot | null;
  feed: AuditEntry[];
  view: View;
  gatewayTab: 'approvals' | 'permissions' | 'audit' | 'connect';
  selected: string | null;
  chat: Record<string, ChatMessage[]>;
  toasts: Toast[];
  set: (patch: Partial<State>) => void;
  go: (view: View, extra?: Partial<State>) => void;
  toast: (text: string, tone?: Toast['tone']) => void;
}

let toastId = 0;
export const useStore = create<State>((set) => ({
  status: 'connecting',
  conn: { url: 'http://127.0.0.1:7777', token: '', home: '~/.shadowagent' },
  data: null, feed: [], view: 'realm', gatewayTab: 'approvals', selected: null, chat: {}, toasts: [],
  set: (patch) => set(patch),
  go: (view, extra) => set({ view, selected: null, ...extra }),
  toast: (text, tone = 'ok') => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'bad' ? 6000 : 3200);
  },
}));

export const agentName = (id: string | null) => useStore.getState().data?.agents.find((a) => a.id === id)?.name ?? 'System';
export type { Note };
