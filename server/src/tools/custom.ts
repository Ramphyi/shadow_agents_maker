import { Worker } from 'node:worker_threads';
import type { CustomTool } from '../store.ts';
import type { ToolCtx } from './registry.ts';

const JS_TIMEOUT_MS = 20_000;

/** Fill {{arg}} and {{secret.NAME}} placeholders. Missing values become empty strings. */
export function render(template: string, args: Record<string, unknown>, secret: (name: string) => string | undefined, encode = false): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const raw = key.startsWith('secret.') ? secret(key.slice(7)) : args[key];
    if (raw === undefined || raw === null) return '';
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return encode && !key.startsWith('secret.') ? encodeURIComponent(text) : text;
  });
}

interface HttpConfig { method?: string; url?: string; headers?: Record<string, string>; body?: string; secrets?: string[] }

async function runHttp(tool: CustomTool, args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const cfg = tool.config as HttpConfig;
  if (!cfg.url) throw new Error('This tool has no URL configured.');
  const allowed = new Set(cfg.secrets ?? []);
  const secret = (name: string) => (allowed.has(name) ? ctx.core.vault.get(name) : undefined);
  const method = (cfg.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = render(v, args, secret);
  const body = cfg.body && method !== 'GET' ? render(cfg.body, args, secret) : undefined;
  if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  const res = await fetch(render(cfg.url, args, secret, true), { method, headers, body, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  return `HTTP ${res.status}\n${text}`;
}

function runJs(tool: CustomTool, args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const cfg = tool.config as { code?: string; secrets?: string[] };
  const secrets: Record<string, string> = {};
  for (const name of cfg.secrets ?? []) {
    const v = ctx.core.vault.get(name);
    if (v !== undefined) secrets[name] = v;
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sandbox-worker.js', import.meta.url), {
      workerData: { code: cfg.code ?? '', args, secrets },
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 96 },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`The tool ran longer than ${JS_TIMEOUT_MS / 1000}s and was stopped.`));
    }, JS_TIMEOUT_MS);
    worker.once('message', (m: { ok: boolean; result?: unknown; error?: string; logs: string[] }) => {
      clearTimeout(timer);
      void worker.terminate();
      const logs = m.logs.length ? `\n\n[console]\n${m.logs.join('\n')}` : '';
      if (!m.ok) return reject(new Error(`${m.error}${logs}`));
      const out = m.result === undefined ? 'done' : typeof m.result === 'string' ? m.result : JSON.stringify(m.result, null, 2);
      resolve(`${out}${logs}`);
    });
    worker.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

export function runCustomTool(tool: CustomTool, args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  return tool.kind === 'http' ? runHttp(tool, args, ctx) : runJs(tool, args, ctx);
}
