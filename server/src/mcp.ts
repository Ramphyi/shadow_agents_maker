import type { Express } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Core } from './core.ts';
import { COLORS, SPRITES, TEMPLATES, type Ops } from './ops.ts';
import type { Actor } from './store.ts';
import { bearer, sameToken, VERSION } from './api.ts';
import { errMsg } from './util.ts';

const GUIDE = (core: Core) => `# Shadow Agents: guide for the assistant driving this server

Shadow agents ("shadows") are small always-on assistants that run on the user's machine. Each one is shown in the
desktop app as a voxel sprite. You can create, change, test and inspect them with the tools on this server.

## What a shadow is made of
- name, sprite (${SPRITES.join(', ')}), color (hex, e.g. ${COLORS.slice(0, 3).join(', ')})
- role: one sentence on what it is responsible for
- instructions: standing guidance it reads on every run. Write to it as "you": what is worth reporting, what to
  ignore, how its notifications should read.
- functions: the jobs that wake it. One shadow can have several.
    - schedule: fires on a 5-field cron expression in the server's local time ("*/5 * * * *", "0 8 * * 1-5")
    - webhook: fires when an outside system POSTs to its URL
    - manual: fires only when someone runs it
  Each function has a prompt saying what to do on that wake-up.
- tools: what it may use. Give it only what the job needs. Call list_tools for the catalog.

A shadow keeps nothing between runs except its memory (memory_get / memory_set) and workspace files, so a
function that must not repeat itself has to save where it got to.

## Permissions, and what you cannot do
Every tool call a shadow makes goes through a gateway with three modes per tool: allow, ask (the user approves
each call in the app), deny. Tools have a risk level: safe (stays inside the agent), read (reads outside data),
act (changes something outside).
- Grants you make for read and act tools are stored as "ask", whatever you request. Only the user can raise them
  to "allow", in the app or by choosing "always allow" on an approval.
- Tools you create are marked unreviewed: every call to them asks the user until they review the tool in the app.
- You cannot approve requests, read secrets, or read the admin token. Tell the user when something is waiting
  for them in the app's Gateway view.
So after you build a shadow that reads mail or calls an API, tell the user that its first runs will ask for
approval and that "always allow" makes it autonomous.

## A good way to build one
1. list_tools, and list_agents to see what exists.
2. If a tool needs secrets that are missing (see "missing" in list_tools), ask the user to add them in the app
   under Settings → Secrets, or set them with set_secret if the user gives you the values.
3. create_agent with role, instructions, functions and tools in one call.
4. talk_to_agent or run_function to try it, then get_audit_log and list_runs to see exactly what it did.
5. Adjust with update_agent / add_function / grant_tool.

## Creating tools
create_tool makes a new tool agents can be granted.
- kind "http": config { method, url, headers, body, secrets }. Use {{arg_name}} placeholders for inputs and
  {{secret.NAME}} for secrets; list the secret names the tool may read in config.secrets.
- kind "js": config { code, secrets }. code is the body of an async function receiving (args, secrets). It can
  use fetch and console.log, and returns a string or a JSON-serializable value.
Write the description for the agent that will read it: what the tool does, when to use it, what comes back.

## Starting points
${TEMPLATES.map((t) => `- ${t.name}: ${t.tagline}`).join('\n')}

Other agents can reach shadows that have a2a enabled at ${process.env.SHADOW_PUBLIC_URL ?? `http://127.0.0.1:${core.port}`}/a2a/<agent-name>.`;

const fnShape = {
  name: z.string().describe('Short label, e.g. "Check inbox".'),
  kind: z.enum(['schedule', 'webhook', 'manual']),
  cron: z.string().optional().describe('5-field cron expression in the server\'s local time. Required for kind "schedule".'),
  prompt: z.string().describe('What the agent should do each time this function fires.'),
};

export function buildMcpServer(core: Core, ops: Ops, actor: Actor): McpServer {
  const server = new McpServer({ name: 'shadow-agents', version: VERSION }, {
    instructions: 'Create and manage always-on "shadow agents" on the user\'s machine. Call shadow_guide first: it explains the model, the permission rules and a good build sequence.',
  });

  const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
  /** Tool errors go back as readable results, so the calling model can correct itself. */
  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (args: z.infer<z.ZodObject<S>>) => unknown) => {
    server.registerTool(name, { description, inputSchema: shape }, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return reply(await fn(args));
      } catch (e) {
        return { ...reply(`Error: ${errMsg(e)}`), isError: true };
      }
    }) as never);
  };

  const brief = (a: ReturnType<Ops['agentView']>) => ({
    id: a.id, name: a.name, sprite: a.sprite, role: a.role, status: a.status, state: a.state, a2a: a.a2a,
    functions: a.functions.map((f) => ({ id: f.id, name: f.name, kind: f.kind, cron: f.cron, enabled: f.enabled, nextRun: f.nextRun && new Date(f.nextRun).toISOString(), hookUrl: f.hookUrl })),
    tools: a.grants.map((g) => `${g.tool}:${g.mode}`),
    lastRun: a.lastRun && { status: a.lastRun.status, trigger: a.lastRun.trigger, at: new Date(a.lastRun.startedAt).toISOString() },
  });

  tool('shadow_guide', 'How shadow agents work, the permission rules that apply to you, and a recommended sequence for building one. Read this before creating or changing agents.', {}, () => GUIDE(core));

  tool('list_agents', 'List every shadow agent with its role, functions, tool grants, and what it is doing right now.', {},
    () => core.store.agents().map((a) => brief(ops.agentView(a))));

  tool('get_agent', 'Full detail for one agent: instructions, functions, grants, memory, and its latest runs.',
    { agent: z.string().describe('Agent name or id.') }, ({ agent }) => {
      const a = ops.need(agent);
      return { ...ops.agentView(a), memory: core.store.memory(a.id), recentRuns: core.store.runs(a.id, 8) };
    });

  tool('create_agent', 'Create a shadow agent. It starts running its scheduled functions immediately. Grants for tools that read or act outside the agent are stored as "ask": the user approves those calls in the app until they choose to always allow them.', {
    name: z.string().describe('Short display name, unique. Two words at most reads best.'),
    role: z.string().describe('One sentence: what this agent is responsible for.'),
    instructions: z.string().describe('Standing guidance the agent reads on every run, addressed to it as "you".'),
    sprite: z.enum(SPRITES).optional(),
    color: z.string().optional().describe('Hex color such as #39d0ff.'),
    functions: z.array(z.object(fnShape)).optional().describe('Jobs that wake the agent. Leave empty for an agent the user only talks to.'),
    tools: z.array(z.string()).optional().describe('Names of tools to grant. See list_tools.'),
    a2a: z.boolean().optional().describe('Expose this agent to other agents over the A2A protocol.'),
  }, (args) => brief(ops.createAgent(args, actor)));

  tool('update_agent', 'Change an agent\'s name, role, instructions, look, status or A2A exposure. Only the fields you pass change.', {
    agent: z.string().describe('Agent name or id.'),
    name: z.string().optional(), role: z.string().optional(), instructions: z.string().optional(),
    sprite: z.enum(SPRITES).optional(), color: z.string().optional(),
    status: z.enum(['active', 'paused']).optional().describe('A paused agent skips its schedules and webhooks but can still be talked to.'),
    a2a: z.boolean().optional(),
  }, ({ agent, ...patch }) => brief(ops.updateAgent(agent, patch, actor)));

  tool('delete_agent', 'Permanently delete an agent with its functions, grants, memory and chat history. Confirm with the user first.',
    { agent: z.string() }, ({ agent }) => { ops.deleteAgent(agent, actor); return 'Deleted.'; });

  tool('add_function', 'Give an agent another job: a schedule, a webhook, or a manual function.',
    { agent: z.string(), ...fnShape }, ({ agent, ...f }) => ops.addFunction(agent, f, actor));

  tool('update_function', 'Change a function\'s name, schedule, prompt, or switch it on or off.', {
    function_id: z.string(), name: z.string().optional(), cron: z.string().optional(), prompt: z.string().optional(), enabled: z.boolean().optional(),
  }, ({ function_id, ...patch }) => ops.updateFunction(function_id, patch, actor));

  tool('remove_function', 'Delete a function from an agent.', { function_id: z.string() },
    ({ function_id }) => { ops.removeFunction(function_id, actor); return 'Removed.'; });

  tool('run_function', 'Run one of an agent\'s functions now and wait for the result. If the run needs a tool the user must approve, this waits until they answer in the app.',
    { function_id: z.string() }, async ({ function_id }) => {
      const run = await ops.runFunction(function_id, actor);
      return { status: run.status, output: run.output, error: run.error, steps: run.steps };
    });

  tool('talk_to_agent', 'Send a message to an agent and get its reply. Good for testing behavior or asking what it knows.',
    { agent: z.string(), message: z.string() }, async ({ agent, message }) => {
      const a = ops.need(agent);
      core.gateway.log(actor, 'agent.chat', a.name, 'ok', { chars: message.length }, { agentId: a.id });
      const run = await core.runtime.run(a.id, { trigger: 'chat', input: message });
      return run.status === 'completed' ? run.output : `The agent failed: ${run.error}`;
    });

  tool('list_tools', 'The catalog of tools agents can be granted: built-in and custom, with risk level, input schema, and any secrets still missing.', {},
    () => core.tools.list().map((t) => { const d = core.tools.describe(t); return { name: d.name, kind: d.kind, risk: d.risk, reviewed: d.reviewed, description: d.description, inputSchema: d.inputSchema, missingSecrets: d.missing }; }));

  tool('create_tool', 'Create or replace a custom tool. It is saved as unreviewed with risk "act": each call asks the user until they review it in the app.', {
    name: z.string().describe('snake_case, e.g. weather_lookup.'),
    kind: z.enum(['http', 'js']),
    description: z.string().describe('Written for the agent that will use it: what it does, when to use it, what it returns.'),
    input_schema: z.record(z.string(), z.unknown()).describe('JSON Schema object describing the arguments.'),
    config: z.record(z.string(), z.unknown()).describe('http: { method, url, headers, body, secrets }. js: { code, secrets }.'),
  }, (a) => ops.saveTool({ name: a.name, kind: a.kind, description: a.description, inputSchema: a.input_schema, config: a.config }, actor));

  tool('test_tool', 'Run a tool once with the given arguments and return its output. Tools that are not "safe" wait for the user to approve the call in the app.',
    { name: z.string(), args: z.record(z.string(), z.unknown()).optional() }, ({ name, args }) => ops.testTool(name, args ?? {}, actor));

  tool('delete_tool', 'Delete a custom tool and every grant of it.', { name: z.string() }, ({ name }) => { ops.deleteTool(name, actor); return 'Deleted.'; });

  tool('grant_tool', 'Set what an agent may do with a tool: allow, ask (user approves each call), deny, or remove the grant. "allow" on read and act tools is stored as "ask"; the result shows the mode actually set.', {
    agent: z.string(), tool: z.string(), mode: z.enum(['allow', 'ask', 'deny', 'remove']),
  }, ({ agent, tool: name, mode }) => ({ mode: ops.setGrant(ops.need(agent).id, name, mode === 'remove' ? null : mode, actor) ?? 'removed' }));

  tool('list_approvals', 'Tool calls currently waiting for the user\'s approval in the app. You cannot approve them; tell the user they are waiting.', {},
    () => core.store.approvals('pending').map((a) => ({ id: a.id, agent: a.agentId && core.store.agent(a.agentId)?.name, tool: a.tool, args: a.args, since: new Date(a.createdAt).toISOString() })));

  tool('get_audit_log', 'The gateway\'s audit log, newest first: every tool call with its decision, plus permission and configuration changes.', {
    agent: z.string().optional().describe('Only entries for this agent.'), limit: z.number().int().min(1).max(200).optional(),
  }, ({ agent, limit }) => core.store.audit({ agentId: agent ? ops.need(agent).id : undefined, limit: limit ?? 40 })
    .map((e) => ({ at: new Date(e.ts).toISOString(), actor: `${e.actorType}:${e.actorId}`, action: e.action, target: e.target, decision: e.decision, ms: e.ms, detail: e.detail })));

  tool('list_runs', 'Recent runs with trigger, status, output and token use.', { agent: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
    ({ agent, limit }) => core.store.runs(agent ? ops.need(agent).id : undefined, limit ?? 15)
      .map((r) => ({ id: r.id, agent: core.store.agent(r.agentId)?.name, trigger: r.trigger, status: r.status, at: new Date(r.startedAt).toISOString(), output: r.output, error: r.error, steps: r.steps, tokens: r.tokensIn + r.tokensOut })));

  tool('list_notifications', 'What the agents have told the user recently.', { limit: z.number().int().min(1).max(100).optional() },
    ({ limit }) => core.store.notifications(limit ?? 20).map((n) => ({ at: new Date(n.ts).toISOString(), agent: n.agentId && core.store.agent(n.agentId)?.name, level: n.level, title: n.title, body: n.body })));

  tool('set_secret', 'Store a secret (an API key, a mailbox password) in the encrypted vault for tools to use. Secrets are write-only: nothing can read one back. Only use values the user gave you for this purpose.', {
    name: z.string().describe('CAPITAL_SNAKE_CASE, e.g. IMAP_PASS.'), value: z.string(),
  }, ({ name, value }) => {
    const n = name.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(n) || n.startsWith('PROVIDER_')) throw new Error('Secret names use capital letters, digits and underscores, and may not start with PROVIDER_.');
    core.vault.set(n, value);
    core.gateway.log(actor, 'secret.set', n, 'ok');
    core.emit('settings', {});
    return `Stored ${n}.`;
  });

  return server;
}

export function mountMcp(app: Express, core: Core, ops: Ops) {
  const clientNames = new Map<string, string>();
  // Stateless Streamable HTTP: a fresh server per request, so nothing is shared between clients.
  app.post('/mcp', async (req, res) => {
    const given = bearer(req);
    if (!sameToken(given, core.tokens.mcp)) {
      res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: send the MCP token as a Bearer token.' } });
      return;
    }
    // The transport is stateless, so the client's name (sent once, in "initialize") is remembered per caller.
    // It is only a label for the audit log; the token is what grants access.
    const callerKey = `${req.ip}|${req.headers['user-agent'] ?? ''}`;
    const announced = req.body?.params?.clientInfo?.name;
    if (typeof announced === 'string') { if (clientNames.size > 200) clientNames.clear(); clientNames.set(callerKey, announced); }
    const client = String(clientNames.get(callerKey) ?? req.headers['user-agent'] ?? 'harness').slice(0, 60);
    const server = buildMcpServer(core, ops, { type: 'mcp', id: client });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const notAllowed = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'This server is stateless: use POST.' } });
  };
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
