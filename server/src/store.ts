import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import { newId, now, safeJson } from './util.ts';

export type Mode = 'allow' | 'ask' | 'deny';
/** safe: no effect outside the agent. read: reads outside data. act: changes something outside. */
export type Risk = 'safe' | 'read' | 'act';
export type ActorType = 'user' | 'mcp' | 'agent' | 'a2a' | 'system';
export interface Actor { type: ActorType; id: string }

export interface Agent {
  id: string; name: string; sprite: string; color: string; role: string; instructions: string;
  providerId: string | null; model: string | null; status: 'active' | 'paused'; a2a: boolean;
  createdAt: number; createdBy: string;
}
export interface Fn {
  id: string; agentId: string; name: string; kind: 'schedule' | 'webhook' | 'manual';
  cron: string | null; prompt: string; enabled: boolean; hookKey: string | null; lastRun: number | null;
}
export interface CustomTool {
  name: string; kind: 'http' | 'js'; description: string; inputSchema: Record<string, unknown>;
  config: Record<string, unknown>; risk: Risk; reviewed: boolean; createdAt: number; createdBy: string;
}
export interface Grant { agentId: string; tool: string; mode: Mode; updatedAt: number; updatedBy: string }
export interface Run {
  id: string; agentId: string; functionId: string | null; trigger: string; input: string;
  status: 'running' | 'completed' | 'failed'; output: string | null; error: string | null;
  startedAt: number; endedAt: number | null; steps: number; tokensIn: number; tokensOut: number;
}
export interface AuditEntry {
  id: number; ts: number; actorType: ActorType; actorId: string; action: string; target: string;
  decision: string; detail: Record<string, unknown>; runId: string | null; agentId: string | null;
  ms: number | null; hash: string;
}
export interface Approval {
  id: string; agentId: string | null; runId: string | null; actor: string; tool: string;
  args: Record<string, unknown>; status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: number; resolvedAt: number | null; resolvedBy: string | null;
}
export interface Notification {
  id: string; agentId: string | null; title: string; body: string; level: 'info' | 'success' | 'warning' | 'urgent';
  read: boolean; ts: number;
}
export interface ChatMessage { id: number; agentId: string; role: 'user' | 'assistant'; content: string; ts: number; runId: string | null }
export interface Provider {
  id: string; name: string; kind: 'anthropic' | 'openai'; baseUrl: string | null;
  secret: string | null; model: string; createdAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, sprite TEXT, color TEXT, role TEXT,
  instructions TEXT, providerId TEXT, model TEXT, status TEXT, a2a INTEGER, createdAt INTEGER, createdBy TEXT);
CREATE TABLE IF NOT EXISTS functions(id TEXT PRIMARY KEY, agentId TEXT NOT NULL, name TEXT, kind TEXT, cron TEXT,
  prompt TEXT, enabled INTEGER, hookKey TEXT, lastRun INTEGER);
CREATE TABLE IF NOT EXISTS tools(name TEXT PRIMARY KEY, kind TEXT, description TEXT, inputSchema TEXT, config TEXT,
  risk TEXT, reviewed INTEGER, createdAt INTEGER, createdBy TEXT);
CREATE TABLE IF NOT EXISTS grants(agentId TEXT, tool TEXT, mode TEXT, updatedAt INTEGER, updatedBy TEXT,
  PRIMARY KEY(agentId, tool));
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, agentId TEXT, functionId TEXT, trigger TEXT, input TEXT,
  status TEXT, output TEXT, error TEXT, startedAt INTEGER, endedAt INTEGER, steps INTEGER, tokensIn INTEGER, tokensOut INTEGER);
CREATE INDEX IF NOT EXISTS runs_agent ON runs(agentId, startedAt);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, actorType TEXT, actorId TEXT,
  action TEXT, target TEXT, decision TEXT, detail TEXT, runId TEXT, agentId TEXT, ms INTEGER, hash TEXT);
CREATE INDEX IF NOT EXISTS audit_agent ON audit(agentId, id);
CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, agentId TEXT, runId TEXT, actor TEXT, tool TEXT, args TEXT,
  status TEXT, createdAt INTEGER, resolvedAt INTEGER, resolvedBy TEXT);
CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, agentId TEXT, title TEXT, body TEXT, level TEXT,
  read INTEGER, ts INTEGER);
CREATE TABLE IF NOT EXISTS memory(agentId TEXT, key TEXT, value TEXT, updatedAt INTEGER, PRIMARY KEY(agentId, key));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, agentId TEXT, role TEXT, content TEXT,
  ts INTEGER, runId TEXT);
CREATE TABLE IF NOT EXISTS secrets(name TEXT PRIMARY KEY, value TEXT, updatedAt INTEGER);
CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY, name TEXT, kind TEXT, baseUrl TEXT, secret TEXT, model TEXT,
  createdAt INTEGER);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
`;

type Row = Record<string, unknown>;
type Param = string | number | bigint | null | Uint8Array;
const p = (v: unknown): Param => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as Param));

export class Store {
  db: DatabaseSync;

  constructor(home: string) {
    this.db = new DatabaseSync(home === ':memory:' ? ':memory:' : path.join(home, 'shadow.db'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close() { this.db.close(); }
  private all<T = Row>(sql: string, ...args: unknown[]): T[] { return this.db.prepare(sql).all(...args.map(p)) as T[]; }
  private get<T = Row>(sql: string, ...args: unknown[]): T | undefined { return this.db.prepare(sql).get(...args.map(p)) as T | undefined; }
  private run(sql: string, ...args: unknown[]) { return this.db.prepare(sql).run(...args.map(p)); }

  // ── agents ────────────────────────────────────────────────────────────
  private toAgent = (r: Row): Agent => ({ ...(r as unknown as Agent), a2a: !!r.a2a });
  agents(): Agent[] { return this.all('SELECT * FROM agents ORDER BY createdAt').map(this.toAgent); }
  agent(id: string): Agent | undefined {
    const r = this.get('SELECT * FROM agents WHERE id = ? OR lower(name) = lower(?)', id, id);
    return r && this.toAgent(r);
  }
  insertAgent(a: Omit<Agent, 'id' | 'createdAt'>): Agent {
    const agent: Agent = { ...a, id: newId('ag'), createdAt: now() };
    this.run('INSERT INTO agents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', agent.id, agent.name, agent.sprite, agent.color,
      agent.role, agent.instructions, agent.providerId, agent.model, agent.status, agent.a2a, agent.createdAt, agent.createdBy);
    return agent;
  }
  updateAgent(id: string, patch: Partial<Agent>): Agent {
    const cur = this.agent(id);
    if (!cur) throw new Error('agent not found');
    const a = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt, createdBy: cur.createdBy };
    this.run('UPDATE agents SET name=?, sprite=?, color=?, role=?, instructions=?, providerId=?, model=?, status=?, a2a=? WHERE id=?',
      a.name, a.sprite, a.color, a.role, a.instructions, a.providerId, a.model, a.status, a.a2a, a.id);
    return a;
  }
  deleteAgent(id: string) {
    for (const t of ['functions', 'grants', 'memory', 'messages']) this.run(`DELETE FROM ${t} WHERE agentId = ?`, id);
    this.run(`UPDATE approvals SET status='expired', resolvedAt=? WHERE agentId = ? AND status='pending'`, now(), id);
    this.run('DELETE FROM agents WHERE id = ?', id);
  }

  // ── functions ─────────────────────────────────────────────────────────
  private toFn = (r: Row): Fn => ({ ...(r as unknown as Fn), enabled: !!r.enabled });
  functions(agentId?: string): Fn[] {
    const rows = agentId ? this.all('SELECT * FROM functions WHERE agentId = ?', agentId) : this.all('SELECT * FROM functions');
    return rows.map(this.toFn);
  }
  fn(id: string): Fn | undefined { const r = this.get('SELECT * FROM functions WHERE id = ?', id); return r && this.toFn(r); }
  insertFn(f: Omit<Fn, 'id' | 'lastRun' | 'hookKey'>): Fn {
    const fn: Fn = { ...f, id: newId('fn'), lastRun: null, hookKey: f.kind === 'webhook' ? crypto.randomBytes(18).toString('base64url') : null };
    this.run('INSERT INTO functions VALUES(?,?,?,?,?,?,?,?,?)', fn.id, fn.agentId, fn.name, fn.kind, fn.cron, fn.prompt, fn.enabled, fn.hookKey, fn.lastRun);
    return fn;
  }
  updateFn(id: string, patch: Partial<Fn>): Fn {
    const cur = this.fn(id);
    if (!cur) throw new Error('function not found');
    const f = { ...cur, ...patch, id: cur.id, agentId: cur.agentId };
    if (f.kind === 'webhook' && !f.hookKey) f.hookKey = crypto.randomBytes(18).toString('base64url');
    this.run('UPDATE functions SET name=?, kind=?, cron=?, prompt=?, enabled=?, hookKey=?, lastRun=? WHERE id=?',
      f.name, f.kind, f.cron, f.prompt, f.enabled, f.hookKey, f.lastRun, f.id);
    return f;
  }
  deleteFn(id: string) { this.run('DELETE FROM functions WHERE id = ?', id); }

  // ── custom tools ──────────────────────────────────────────────────────
  private toTool = (r: Row): CustomTool => ({
    ...(r as unknown as CustomTool), reviewed: !!r.reviewed,
    inputSchema: safeJson(r.inputSchema as string, {}), config: safeJson(r.config as string, {}),
  });
  customTools(): CustomTool[] { return this.all('SELECT * FROM tools ORDER BY createdAt').map(this.toTool); }
  customTool(name: string): CustomTool | undefined { const r = this.get('SELECT * FROM tools WHERE name = ?', name); return r && this.toTool(r); }
  upsertTool(t: CustomTool) {
    this.run(`INSERT INTO tools VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET kind=excluded.kind,
      description=excluded.description, inputSchema=excluded.inputSchema, config=excluded.config, risk=excluded.risk, reviewed=excluded.reviewed`,
      t.name, t.kind, t.description, JSON.stringify(t.inputSchema), JSON.stringify(t.config), t.risk, t.reviewed, t.createdAt, t.createdBy);
  }
  deleteTool(name: string) { this.run('DELETE FROM tools WHERE name = ?', name); this.run('DELETE FROM grants WHERE tool = ?', name); }

  // ── grants ────────────────────────────────────────────────────────────
  grants(agentId?: string): Grant[] {
    return agentId ? this.all<Grant>('SELECT * FROM grants WHERE agentId = ?', agentId) : this.all<Grant>('SELECT * FROM grants');
  }
  grant(agentId: string, tool: string): Grant | undefined { return this.get<Grant>('SELECT * FROM grants WHERE agentId = ? AND tool = ?', agentId, tool); }
  setGrant(agentId: string, tool: string, mode: Mode | null, by: string) {
    if (mode === null) this.run('DELETE FROM grants WHERE agentId = ? AND tool = ?', agentId, tool);
    else this.run(`INSERT INTO grants VALUES(?,?,?,?,?) ON CONFLICT(agentId, tool) DO UPDATE SET mode=excluded.mode,
      updatedAt=excluded.updatedAt, updatedBy=excluded.updatedBy`, agentId, tool, mode, now(), by);
  }

  // ── runs ──────────────────────────────────────────────────────────────
  insertRun(r: Pick<Run, 'agentId' | 'functionId' | 'trigger' | 'input'>): Run {
    const run: Run = { ...r, id: newId('run'), status: 'running', output: null, error: null, startedAt: now(), endedAt: null, steps: 0, tokensIn: 0, tokensOut: 0 };
    this.run('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', run.id, run.agentId, run.functionId, run.trigger, run.input,
      run.status, run.output, run.error, run.startedAt, run.endedAt, run.steps, run.tokensIn, run.tokensOut);
    return run;
  }
  finishRun(run: Run) {
    this.run('UPDATE runs SET status=?, output=?, error=?, endedAt=?, steps=?, tokensIn=?, tokensOut=? WHERE id=?',
      run.status, run.output, run.error, run.endedAt, run.steps, run.tokensIn, run.tokensOut, run.id);
  }
  getRun(id: string): Run | undefined { return this.get<Run>('SELECT * FROM runs WHERE id = ?', id); }
  runs(agentId?: string, limit = 50): Run[] {
    return agentId ? this.all<Run>('SELECT * FROM runs WHERE agentId = ? ORDER BY startedAt DESC LIMIT ?', agentId, limit)
      : this.all<Run>('SELECT * FROM runs ORDER BY startedAt DESC LIMIT ?', limit);
  }
  /** Runs left "running" by a crash or restart can never finish; close them. */
  failOrphanRuns() {
    this.run(`UPDATE runs SET status='failed', error='interrupted by a server restart', endedAt=? WHERE status='running'`, now());
    this.run(`UPDATE approvals SET status='expired', resolvedAt=? WHERE status='pending'`, now());
  }

  // ── audit (hash-chained, append-only) ─────────────────────────────────
  private toAudit = (r: Row): AuditEntry => ({ ...(r as unknown as AuditEntry), detail: safeJson(r.detail as string, {}) });
  private static auditHash(prev: string, e: Omit<AuditEntry, 'id' | 'hash'>) {
    const body = JSON.stringify([e.ts, e.actorType, e.actorId, e.action, e.target, e.decision, e.detail, e.runId, e.agentId, e.ms]);
    return crypto.createHash('sha256').update(prev).update(body).digest('hex');
  }
  addAudit(e: Omit<AuditEntry, 'id' | 'hash' | 'ts'>): AuditEntry {
    const entry = { ...e, ts: now() };
    const prev = this.get<{ hash: string }>('SELECT hash FROM audit ORDER BY id DESC LIMIT 1')?.hash ?? '';
    const hash = Store.auditHash(prev, entry);
    const res = this.run('INSERT INTO audit(ts, actorType, actorId, action, target, decision, detail, runId, agentId, ms, hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      entry.ts, entry.actorType, entry.actorId, entry.action, entry.target, entry.decision, JSON.stringify(entry.detail), entry.runId, entry.agentId, entry.ms, hash);
    return { ...entry, id: Number(res.lastInsertRowid), hash };
  }
  audit(filter: { agentId?: string; action?: string; decision?: string; limit?: number; before?: number } = {}): AuditEntry[] {
    const where: string[] = []; const args: unknown[] = [];
    if (filter.agentId) { where.push('agentId = ?'); args.push(filter.agentId); }
    if (filter.action) { where.push('action = ?'); args.push(filter.action); }
    if (filter.decision) { where.push('decision = ?'); args.push(filter.decision); }
    if (filter.before) { where.push('id < ?'); args.push(filter.before); }
    const sql = `SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return this.all(sql, ...args, Math.min(filter.limit ?? 100, 500)).map(this.toAudit);
  }
  /** Recompute the hash chain. Returns the id of the first entry that does not match, or null if intact. */
  verifyAudit(): { entries: number; brokenAt: number | null } {
    let prev = ''; let n = 0;
    for (const e of this.all('SELECT * FROM audit ORDER BY id').map(this.toAudit)) {
      n++;
      if (Store.auditHash(prev, e) !== e.hash) return { entries: n, brokenAt: e.id };
      prev = e.hash;
    }
    return { entries: n, brokenAt: null };
  }

  // ── approvals ─────────────────────────────────────────────────────────
  private toApproval = (r: Row): Approval => ({ ...(r as unknown as Approval), args: safeJson(r.args as string, {}) });
  insertApproval(a: Pick<Approval, 'agentId' | 'runId' | 'actor' | 'tool' | 'args'>): Approval {
    const ap: Approval = { ...a, id: newId('ap'), status: 'pending', createdAt: now(), resolvedAt: null, resolvedBy: null };
    this.run('INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,?,?)', ap.id, ap.agentId, ap.runId, ap.actor, ap.tool, JSON.stringify(ap.args), ap.status, ap.createdAt, null, null);
    return ap;
  }
  approval(id: string): Approval | undefined { const r = this.get('SELECT * FROM approvals WHERE id = ?', id); return r && this.toApproval(r); }
  approvals(status?: string, limit = 100): Approval[] {
    const rows = status ? this.all('SELECT * FROM approvals WHERE status = ? ORDER BY createdAt DESC LIMIT ?', status, limit)
      : this.all('SELECT * FROM approvals ORDER BY createdAt DESC LIMIT ?', limit);
    return rows.map(this.toApproval);
  }
  resolveApproval(id: string, status: Approval['status'], by: string) {
    this.run('UPDATE approvals SET status=?, resolvedAt=?, resolvedBy=? WHERE id=?', status, now(), by, id);
  }

  // ── notifications ─────────────────────────────────────────────────────
  private toNote = (r: Row): Notification => ({ ...(r as unknown as Notification), read: !!r.read });
  insertNotification(n: Omit<Notification, 'id' | 'ts' | 'read'>): Notification {
    const note: Notification = { ...n, id: newId('nt'), ts: now(), read: false };
    this.run('INSERT INTO notifications VALUES(?,?,?,?,?,?,?)', note.id, note.agentId, note.title, note.body, note.level, 0, note.ts);
    return note;
  }
  notifications(limit = 100): Notification[] { return this.all('SELECT * FROM notifications ORDER BY ts DESC LIMIT ?', limit).map(this.toNote); }
  markRead(id: string | 'all') {
    if (id === 'all') this.run('UPDATE notifications SET read = 1');
    else this.run('UPDATE notifications SET read = 1 WHERE id = ?', id);
  }
  clearNotifications() { this.run('DELETE FROM notifications'); }

  // ── memory ────────────────────────────────────────────────────────────
  memory(agentId: string): { key: string; value: string; updatedAt: number }[] { return this.all('SELECT key, value, updatedAt FROM memory WHERE agentId = ? ORDER BY key', agentId); }
  memoryGet(agentId: string, key: string): string | undefined { return this.get<{ value: string }>('SELECT value FROM memory WHERE agentId = ? AND key = ?', agentId, key)?.value; }
  memorySet(agentId: string, key: string, value: string | null) {
    if (value === null) this.run('DELETE FROM memory WHERE agentId = ? AND key = ?', agentId, key);
    else this.run(`INSERT INTO memory VALUES(?,?,?,?) ON CONFLICT(agentId, key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt`, agentId, key, value, now());
  }

  // ── chat messages ─────────────────────────────────────────────────────
  addMessage(agentId: string, role: 'user' | 'assistant', content: string, runId: string | null): ChatMessage {
    const ts = now();
    const res = this.run('INSERT INTO messages(agentId, role, content, ts, runId) VALUES(?,?,?,?,?)', agentId, role, content, ts, runId);
    return { id: Number(res.lastInsertRowid), agentId, role, content, ts, runId };
  }
  messages(agentId: string, limit = 60): ChatMessage[] {
    return this.all<ChatMessage>('SELECT * FROM (SELECT * FROM messages WHERE agentId = ? ORDER BY id DESC LIMIT ?) ORDER BY id', agentId, limit);
  }
  clearMessages(agentId: string) { this.run('DELETE FROM messages WHERE agentId = ?', agentId); }

  // ── secrets (values are encrypted by the vault before they get here) ──
  secretNames(): { name: string; updatedAt: number }[] { return this.all('SELECT name, updatedAt FROM secrets ORDER BY name'); }
  secretRaw(name: string): string | undefined { return this.get<{ value: string }>('SELECT value FROM secrets WHERE name = ?', name)?.value; }
  setSecretRaw(name: string, value: string | null) {
    if (value === null) this.run('DELETE FROM secrets WHERE name = ?', name);
    else this.run(`INSERT INTO secrets VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt`, name, value, now());
  }

  // ── providers & settings ──────────────────────────────────────────────
  providers(): Provider[] { return this.all<Provider>('SELECT * FROM providers ORDER BY createdAt'); }
  provider(id: string): Provider | undefined { return this.get<Provider>('SELECT * FROM providers WHERE id = ?', id); }
  upsertProvider(pr: Omit<Provider, 'id' | 'createdAt'> & { id?: string }): Provider {
    const existing = pr.id ? this.provider(pr.id) : undefined;
    const full: Provider = { ...pr, id: pr.id ?? newId('pr'), createdAt: existing?.createdAt ?? now() };
    this.run(`INSERT INTO providers VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind,
      baseUrl=excluded.baseUrl, secret=excluded.secret, model=excluded.model`, full.id, full.name, full.kind, full.baseUrl, full.secret, full.model, full.createdAt);
    return full;
  }
  deleteProvider(id: string) { this.run('DELETE FROM providers WHERE id = ?', id); this.run('UPDATE agents SET providerId = NULL, model = NULL WHERE providerId = ?', id); }
  setting(key: string): string | undefined { return this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value; }
  setSetting(key: string, value: string | null) {
    if (value === null) this.run('DELETE FROM settings WHERE key = ?', key);
    else this.run(`INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value);
  }
}
