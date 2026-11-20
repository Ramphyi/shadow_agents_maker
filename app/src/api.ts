import { useStore } from './store';
import type { AuditEntry, ChatMessage, LiveState, Note, Snapshot } from './types';

/** All calls go to the local Shadow Agent server with the admin token the server wrote to disk. */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const { conn } = useStore.getState();
  let res: Response;
  try {
    res = await fetch(`${conn.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${conn.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('The Shadow Agent server is not reachable.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Run an action and surface a failure as a toast instead of an unhandled rejection. */
export async function act<T>(fn: () => Promise<T>, done?: string): Promise<T | undefined> {
  try {
    const out = await fn();
    if (done) useStore.getState().toast(done);
    return out;
  } catch (e) {
    useStore.getState().toast(e instanceof Error ? e.message : String(e), 'bad');
    return undefined;
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
export function refresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try {
      useStore.getState().set({ data: await api<Snapshot>('GET', '/api/state'), status: 'online' });
    } catch { /* the socket's close handler reports the outage */ }
  }, 60);
}

function desktopNotify(note: Note) {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission !== 'denied') {
      new Notification(note.title, { body: note.body, silent: note.level === 'info' });
    }
  } catch { /* notifications are a convenience */ }
}

let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;

export async function connect() {
  const store = useStore.getState();
  if (retry) { clearTimeout(retry); retry = null; }
  socket?.close();
  if (window.shadow) {
    const fresh = await window.shadow.connection();
    // Re-read each time: the token file appears when the server starts for the first time.
    store.set({ conn: { ...fresh, token: fresh.token || store.conn.token } });
  } else {
    const saved = localStorage.getItem('shadow-conn');
    if (saved && !store.conn.token) store.set({ conn: JSON.parse(saved) });
  }
  const { conn } = useStore.getState();
  const again = () => { retry = setTimeout(connect, 2500); };
  try {
    const res = await fetch(`${conn.url}/api/state`, { headers: { authorization: `Bearer ${conn.token}` } });
    if (res.status === 401) { store.set({ status: 'unauthorized' }); again(); return; }
    store.set({ data: (await res.json()) as Snapshot, status: 'online' });
    const audit = await api<AuditEntry[]>('GET', '/api/audit?limit=40');
    store.set({ feed: audit });
  } catch {
    store.set({ status: 'offline' });
    again();
    return;
  }

  const ws = new WebSocket(`${conn.url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(conn.token)}`);
  socket = ws;
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data as string) as { type: string; data: unknown };
    const s = useStore.getState();
    switch (e.type) {
      case 'agent.state': {
        const { agentId, state } = e.data as { agentId: string; state: LiveState };
        if (s.data) s.set({ data: { ...s.data, agents: s.data.agents.map((a) => (a.id === agentId ? { ...a, state } : a)) } });
        break;
      }
      case 'audit':
        s.set({ feed: [e.data as AuditEntry, ...s.feed].slice(0, 120) });
        break;
      case 'message': {
        const msg = e.data as ChatMessage;
        const list = s.chat[msg.agentId];
        if (list && !list.some((x) => x.id === msg.id)) s.set({ chat: { ...s.chat, [msg.agentId]: [...list, msg] } });
        break;
      }
      case 'notification':
        desktopNotify(e.data as Note);
        refresh();
        break;
      default:
        refresh();
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    useStore.getState().set({ status: 'offline' });
    again();
  };
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function until(ts: number | null | undefined): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

const CRON_WORDS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^\* \* \* \* \*$/, () => 'Every minute'],
  [/^\*\/(\d+) \* \* \* \*$/, (m) => `Every ${m[1]} minutes`],
  [/^0 \* \* \* \*$/, () => 'Every hour'],
  [/^0 \*\/(\d+) \* \* \*$/, (m) => `Every ${m[1]} hours`],
  [/^(\d+) (\d+) \* \* \*$/, (m) => `Daily at ${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`],
  [/^(\d+) (\d+) \* \* 1-5$/, (m) => `Weekdays at ${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`],
  [/^(\d+) (\d+) \* \* 1$/, (m) => `Mondays at ${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`],
];
export function cronWords(expr: string | null): string {
  if (!expr) return '';
  for (const [re, say] of CRON_WORDS) { const m = expr.match(re); if (m) return say(m); }
  return expr;
}
