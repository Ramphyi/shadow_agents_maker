import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, type Agent, type Provider } from './store.ts';
import { Gateway } from './gateway.ts';
import { Runtime } from './runtime.ts';
import { Scheduler } from './scheduler.ts';
import { ToolRegistry } from './tools/registry.ts';
import { anthropicClient } from './llm/anthropic.ts';
import { openaiClient } from './llm/openai.ts';
import type { LlmClient } from './llm/types.ts';
import { HttpError, newToken } from './util.ts';

export type AgentState = 'idle' | 'working' | 'waiting' | 'error';
export interface CoreOptions {
  home?: string;
  port?: number;
  /** Tests inject a scripted model here instead of calling a real provider. */
  llm?: (provider: Provider | null, model: string) => LlmClient;
}

/** AES-256-GCM vault. Values never leave the server: tools read them, models and API callers cannot. */
class Vault {
  private key: Buffer;
  private cache = new Map<string, string>();
  private store: Store;

  constructor(home: string, store: Store) {
    this.store = store;
    const file = path.join(home, 'vault.key');
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600 });
    this.key = fs.readFileSync(file);
    for (const { name } of store.secretNames()) {
      try { this.cache.set(name, this.decrypt(store.secretRaw(name)!)); } catch { /* unreadable with this key */ }
    }
  }
  private encrypt(plain: string) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
  }
  private decrypt(packed: string) {
    const [iv, tag, data] = packed.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  }
  get(name: string): string | undefined { return this.cache.get(name); }
  has(name: string) { return this.cache.has(name); }
  set(name: string, value: string | null) {
    if (value === null) { this.cache.delete(name); this.store.setSecretRaw(name, null); return; }
    this.cache.set(name, value);
    this.store.setSecretRaw(name, this.encrypt(value));
  }
  /** Replace any secret value that shows up in text, so tool output cannot leak one to a model or the log. */
  redact(text: string): string {
    let out = text;
    for (const [name, value] of this.cache) {
      // Connection settings kept next to credentials (a host, a mailbox address) are not confidential, and
      // hiding the owner's own address would make their mail unreadable to the agent.
      if (/_(HOST|PORT|USER|FROM|TLS|INSECURE|URL)$/.test(name)) continue;
      if (value.length >= 6 && out.includes(value)) out = out.split(value).join(`[secret:${name}]`);
    }
    return out;
  }
}

export class Core {
  home: string;
  port: number;
  store: Store;
  vault: Vault;
  tools: ToolRegistry;
  gateway: Gateway;
  runtime: Runtime;
  scheduler: Scheduler;
  tokens: { admin: string; mcp: string; a2a: string };
  private bus = new EventEmitter();
  private states = new Map<string, AgentState>();
  private llmOverride?: CoreOptions['llm'];

  constructor(opts: CoreOptions = {}) {
    this.home = opts.home ?? process.env.SHADOW_HOME ?? path.join(os.homedir(), '.shadowagent');
    this.port = opts.port ?? Number(process.env.SHADOW_PORT ?? 7777);
    fs.mkdirSync(path.join(this.home, 'workspaces'), { recursive: true });
    this.store = new Store(this.home);
    this.store.failOrphanRuns();
    this.vault = new Vault(this.home, this.store);
    this.tokens = { admin: this.token('admin'), mcp: this.token('mcp'), a2a: this.token('a2a') };
    this.llmOverride = opts.llm;
    this.bus.setMaxListeners(100);
    this.tools = new ToolRegistry(this);
    this.gateway = new Gateway(this);
    this.runtime = new Runtime(this);
    this.scheduler = new Scheduler(this);
  }

  private token(name: 'admin' | 'mcp' | 'a2a', rotate = false): string {
    const file = path.join(this.home, `${name}.token`);
    if (rotate || !fs.existsSync(file)) fs.writeFileSync(file, newToken(`shadow_${name}`), { mode: 0o600 });
    return fs.readFileSync(file, 'utf8').trim();
  }
  rotateToken(name: 'mcp' | 'a2a') { this.tokens[name] = this.token(name, true); return this.tokens[name]; }

  // ── events ────────────────────────────────────────────────────────────
  emit(type: string, data: unknown) { this.bus.emit('event', { type, data, ts: Date.now() }); }
  onEvent(fn: (e: { type: string; data: unknown; ts: number }) => void) {
    this.bus.on('event', fn);
    return () => this.bus.off('event', fn);
  }

  // ── live agent state (what the sprite is doing right now) ─────────────
  state(agentId: string): AgentState { return this.states.get(agentId) ?? 'idle'; }
  setState(agentId: string, state: AgentState) {
    if (this.state(agentId) === state) return;
    this.states.set(agentId, state);
    this.emit('agent.state', { agentId, state });
  }

  // ── model resolution ──────────────────────────────────────────────────
  defaultProvider(): Provider | undefined {
    const id = this.store.setting('defaultProvider');
    return (id && this.store.provider(id)) || this.store.providers()[0];
  }
  llmFor(agent: Pick<Agent, 'providerId' | 'model'> | null): { client: LlmClient; model: string; provider: Provider | null } {
    const provider = (agent?.providerId && this.store.provider(agent.providerId)) || this.defaultProvider() || null;
    const model = (agent?.providerId && agent.model) || provider?.model || 'test-model';
    if (this.llmOverride) return { client: this.llmOverride(provider, model), model, provider };
    if (!provider) throw new HttpError(409, 'No AI provider is configured. Add one in Settings (an API key, or a local model server).');
    return { client: this.clientFor(provider), model, provider };
  }
  clientFor(provider: Provider): LlmClient {
    const key = provider.secret ? this.vault.get(provider.secret) : undefined;
    if (provider.kind === 'anthropic') return anthropicClient(key, provider.baseUrl);
    if (!provider.baseUrl) throw new HttpError(409, `Provider "${provider.name}" has no base URL.`);
    return openaiClient(provider.baseUrl, key);
  }

  close() {
    this.scheduler.stop();
    this.gateway.shutdown();
    this.store.close();
  }
}
