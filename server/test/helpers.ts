import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core } from '../src/core.ts';
import { createServer } from '../src/api.ts';
import { Ops } from '../src/ops.ts';
import type { Block, LlmRequest, LlmResponse } from '../src/llm/types.ts';

export type Step = Block[] | string | ((req: LlmRequest) => Block[] | string);

/** A scripted model: each call to the provider consumes the next step. */
export class Script {
  steps: Step[] = [];
  requests: LlmRequest[] = [];
  push(...steps: Step[]) { this.steps.push(...steps); return this; }
  complete = async (req: LlmRequest): Promise<LlmResponse> => {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (step === undefined) throw new Error('script ran out of steps');
    const out = typeof step === 'function' ? step(req) : step;
    const content: Block[] = typeof out === 'string' ? [{ type: 'text', text: out }] : out;
    return { content, stop: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end', usage: { in: 10, out: 5 } };
  };
}

let n = 0;
export const call = (name: string, input: Record<string, unknown> = {}): Block => ({ type: 'tool_use', id: `call_${++n}`, name, input });

export function makeCore() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-test-'));
  const script = new Script();
  const core = new Core({ home, port: 0, llm: () => script });
  const ops = new Ops(core);
  const cleanup = () => { core.close(); fs.rmSync(home, { recursive: true, force: true }); };
  return { core, ops, script, home, cleanup };
}

export async function makeServer() {
  const ctx = makeCore();
  const server = createServer(ctx.core);
  await server.listen('127.0.0.1');
  const base = `http://127.0.0.1:${ctx.core.port}`;
  const api = async (method: string, url: string, body?: unknown, token = ctx.core.tokens.admin) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const cleanup = async () => { await server.close(); ctx.cleanup(); };
  return { ...ctx, ops: server.ops, server, base, api, cleanup };
}

export const USER = { type: 'user' as const, id: 'owner' };
export const MCP = { type: 'mcp' as const, id: 'test-harness' };

export async function until<T>(fn: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}
