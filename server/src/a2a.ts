import type { Express, Request } from 'express';
import type { Core } from './core.ts';
import type { Agent, Run } from './store.ts';
import { bearer, publicUrl, sameToken, VERSION } from './api.ts';
import { slug } from './util.ts';

/**
 * A2A (Agent2Agent protocol, JSON-RPC binding). Each shadow with "a2a" switched on gets its own endpoint and
 * agent card, so agents on other machines and frameworks can discover it and send it messages.
 */

const find = (core: Core, key: string): Agent | undefined =>
  core.store.agents().find((a) => a.a2a && (a.id === key || slug(a.name) === key.toLowerCase()));

function card(core: Core, agent: Agent) {
  const url = `${publicUrl(core)}/a2a/${slug(agent.name)}`;
  return {
    protocolVersion: '0.3.0',
    name: agent.name,
    description: agent.role || 'A shadow agent.',
    url,
    preferredTransport: 'JSONRPC',
    version: VERSION,
    provider: { organization: 'Shadow Agents', url: publicUrl(core) },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    security: [{ bearer: [] }],
    skills: [
      { id: 'converse', name: 'Talk to this agent', description: agent.role || 'General requests.', tags: ['chat'] },
      ...core.store.functions(agent.id).map((f) => ({ id: f.id, name: f.name, description: f.prompt.slice(0, 200), tags: [f.kind] })),
    ],
  };
}

function task(run: Run) {
  const state = run.status === 'completed' ? 'completed' : run.status === 'failed' ? 'failed' : 'working';
  const text = run.status === 'failed' ? `The agent could not complete this: ${run.error}` : run.output ?? '';
  const message = { kind: 'message', role: 'agent', messageId: `${run.id}-reply`, taskId: run.id, contextId: run.id, parts: [{ kind: 'text', text }] };
  return {
    kind: 'task', id: run.id, contextId: run.id,
    status: { state, timestamp: new Date(run.endedAt ?? run.startedAt).toISOString(), ...(state !== 'working' ? { message } : {}) },
    artifacts: run.status === 'completed' ? [{ artifactId: `${run.id}-answer`, name: 'answer', parts: [{ kind: 'text', text }] }] : [],
  };
}

export function mountA2a(app: Express, core: Core) {
  // Cards are public by design (discovery); they describe the agent but give no access.
  app.get(['/a2a/:agent/.well-known/agent-card.json', '/a2a/:agent/.well-known/agent.json'], (req, res) => {
    const agent = find(core, String(req.params.agent));
    if (!agent) { res.status(404).json({ error: 'No such agent, or it is not exposed over A2A.' }); return; }
    res.json(card(core, agent));
  });

  app.post('/a2a/:agent', async (req: Request, res) => {
    const id = req.body?.id ?? null;
    const fail = (code: number, message: string, status = 200) => { res.status(status).json({ jsonrpc: '2.0', id, error: { code, message } }); };
    if (!sameToken(bearer(req), core.tokens.a2a)) return fail(-32001, 'Unauthorized: send the A2A bearer token.', 401);
    const agent = find(core, String(req.params.agent));
    if (!agent) return fail(-32001, 'No such agent, or it is not exposed over A2A.', 404);
    if (req.body?.jsonrpc !== '2.0' || typeof req.body.method !== 'string') return fail(-32600, 'Invalid JSON-RPC request.');
    const params = req.body.params ?? {};
    const caller = { type: 'a2a' as const, id: String(req.headers['user-agent'] ?? 'remote').slice(0, 60) };

    switch (req.body.method) {
      case 'message/send': {
        const parts = Array.isArray(params.message?.parts) ? (params.message.parts as { kind?: string; text?: string }[]) : [];
        const text = parts.filter((p) => p.kind === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n').trim();
        if (!text) return fail(-32602, 'The message needs at least one text part.');
        if (agent.status !== 'active') return fail(-32603, `${agent.name} is paused.`);
        core.gateway.log(caller, 'a2a.message', agent.name, 'ok', { chars: text.length }, { agentId: agent.id });
        const run = await core.runtime.run(agent.id, { trigger: 'a2a', input: text });
        res.json({ jsonrpc: '2.0', id, result: task(run) });
        return;
      }
      case 'tasks/get': {
        const run = typeof params.id === 'string' ? core.store.getRun(params.id) : undefined;
        if (!run || run.agentId !== agent.id || run.trigger !== 'a2a') return fail(-32001, 'Task not found.');
        res.json({ jsonrpc: '2.0', id, result: task(run) });
        return;
      }
      case 'tasks/cancel':
        return fail(-32002, 'Tasks on this agent cannot be canceled.');
      default:
        return fail(-32601, `Method "${req.body.method}" is not supported. Supported: message/send, tasks/get.`);
    }
  });
}
