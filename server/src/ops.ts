import type { Core } from './core.ts';
import type { Actor, Agent, Fn, Mode, Risk } from './store.ts';
import { Scheduler } from './scheduler.ts';
import { textOf } from './llm/types.ts';
import { HttpError, now, slug, TOOL_NAME_RE } from './util.ts';

export const SPRITES = ['wisp', 'fox', 'owl', 'bot', 'slime', 'cat', 'mage', 'crow'] as const;
export const COLORS = ['#8b7bff', '#39d0ff', '#34e3a0', '#ffb347', '#ff6b9d', '#f5e663', '#ff7a59', '#b0bcff'];

export interface FnSpec { name?: string; kind?: Fn['kind']; cron?: string | null; prompt?: string; enabled?: boolean }
export interface AgentSpec {
  name?: string; sprite?: string; color?: string; role?: string; instructions?: string;
  providerId?: string | null; model?: string | null; a2a?: boolean; status?: Agent['status'];
  functions?: FnSpec[];
  tools?: (string | { name: string; mode?: Mode })[];
}
export interface ToolInput {
  name: string; kind: 'http' | 'js'; description: string; inputSchema?: Record<string, unknown>;
  config?: Record<string, unknown>; risk?: Risk; reviewed?: boolean;
}

export const TEMPLATES: (AgentSpec & { id: string; tagline: string })[] = [
  {
    id: 'mail-sentinel', tagline: 'Watches your inbox and pings you about mail that matters.',
    name: 'Mail Sentinel', sprite: 'owl', color: '#39d0ff',
    role: 'Watches the inbox and tells the owner about mail that needs their attention.',
    instructions: 'Important mail: anything from a real person that asks for a reply or a decision, anything about money, deadlines, security or travel. Not important: newsletters, promotions, automated receipts.\nWhen several important messages arrive together, send one notification that lists them, most urgent first, with sender and a one-line summary each.',
    functions: [{
      name: 'Check inbox', kind: 'schedule', cron: '*/5 * * * *',
      prompt: 'Check the inbox for mail that arrived since your last check. Your memory key last_uid holds the highest uid you have already handled; if it is missing, look at the 5 newest messages. Notify your owner about the important ones. Then save the highest uid you saw as last_uid.',
    }],
    tools: ['email_fetch', 'notify', 'memory_get', 'memory_set'],
  },
  {
    id: 'news-scout', tagline: 'Reads the feeds you care about and sends a morning digest.',
    name: 'News Scout', sprite: 'fox', color: '#ffb347',
    role: 'Reads news feeds and sends the owner a short digest of what is new.',
    instructions: 'Feeds to follow (edit this list):\n- https://hnrss.org/frontpage\n\nPick at most 5 items that are worth the owner\'s time. For each give the title, one sentence on why it matters, and the link.',
    functions: [{
      name: 'Morning digest', kind: 'schedule', cron: '0 8 * * *',
      prompt: 'Read each feed in your instructions. Skip items whose links are already in your memory key seen_links. Send one notification with the digest, then add the links you reported to seen_links (keep only the latest 100).',
    }],
    tools: ['rss_read', 'notify', 'memory_get', 'memory_set'],
  },
  {
    id: 'site-watcher', tagline: 'Checks a page on a schedule and tells you when it changes or goes down.',
    name: 'Site Watcher', sprite: 'bot', color: '#34e3a0',
    role: 'Watches web pages and reports when they change or stop responding.',
    instructions: 'Pages to watch (edit this list):\n- https://example.com\n\nIgnore changes that are only timestamps, counters or ads.',
    functions: [{
      name: 'Check pages', kind: 'schedule', cron: '*/30 * * * *',
      prompt: 'Fetch each page in your instructions. Compare what you get with the short summary you saved in memory under page:<url>. If a page is down or its meaningful content changed, notify your owner with what changed. Save the new summary.',
    }],
    tools: ['http_fetch', 'notify', 'memory_get', 'memory_set'],
  },
  {
    id: 'daily-brief', tagline: 'Asks your other shadows what happened and writes one briefing.',
    name: 'Daily Brief', sprite: 'mage', color: '#8b7bff',
    role: 'Collects updates from the other shadows and writes the owner a daily briefing.',
    instructions: 'Keep the briefing under 200 words. Lead with anything that needs a decision today.',
    functions: [{
      name: 'Morning briefing', kind: 'schedule', cron: '0 7 * * 1-5',
      prompt: 'Ask each other active shadow for a two-line status of what it saw since yesterday. Combine the answers into one briefing and send it as a notification.',
    }],
    tools: ['agent_message', 'notify', 'time_now'],
  },
  {
    id: 'scribe', tagline: 'Keeps notes and lists for you. Talk to it whenever.',
    name: 'Scribe', sprite: 'slime', color: '#ff6b9d',
    role: 'Keeps the owner\'s notes, lists and reminders in its workspace files.',
    instructions: 'Store notes as markdown files in your workspace, one file per topic. When asked what you know, read the files rather than guessing.',
    functions: [],
    tools: ['file_read', 'file_write', 'memory_get', 'memory_set', 'notify'],
  },
];

export class Ops {
  private core: Core;
  constructor(core: Core) { this.core = core; }

  // ── views ─────────────────────────────────────────────────────────────
  fnView = (f: Fn) => ({ ...f, nextRun: this.core.scheduler.nextRun(f.id), hookUrl: f.kind === 'webhook' ? `/hooks/${f.id}?key=${f.hookKey}` : null });
  agentView = (a: Agent) => {
    const lastRun = this.core.store.runs(a.id, 1)[0] ?? null;
    return {
      ...a, slug: slug(a.name), state: this.core.state(a.id),
      functions: this.core.store.functions(a.id).map(this.fnView),
      grants: this.core.store.grants(a.id),
      lastRun,
    };
  };
  providerView = (p: ReturnType<Core['store']['providers']>[number]) => ({ ...p, hasKey: !!p.secret && this.core.vault.has(p.secret) });

  snapshot() {
    const { store, tools } = this.core;
    return {
      agents: store.agents().map(this.agentView),
      tools: tools.list().map((t) => tools.describe(t)),
      approvals: store.approvals('pending'),
      notifications: store.notifications(80),
      providers: store.providers().map(this.providerView),
      defaultProvider: this.core.defaultProvider()?.id ?? null,
      secrets: store.secretNames(),
      settings: { notifyUrl: store.setting('notifyUrl') ?? '', approvalMinutes: Number(store.setting('approvalMinutes') ?? 60) },
      sprites: SPRITES, colors: COLORS, templates: TEMPLATES,
    };
  }

  // ── permissions ───────────────────────────────────────────────────────
  /**
   * The rule that keeps a harness from quietly giving its own agents real-world reach: anything that reads or
   * acts outside the agent can be granted over MCP only as "ask". A person raises it to "allow" in the app.
   */
  private capMode(actor: Actor, risk: Risk, mode: Mode): Mode {
    return actor.type !== 'user' && risk !== 'safe' && mode === 'allow' ? 'ask' : mode;
  }
  private defaultMode(risk: Risk): Mode { return risk === 'act' ? 'ask' : 'allow'; }

  setGrant(agentId: string, tool: string, mode: Mode | null, actor: Actor): Mode | null {
    const agent = this.need(agentId);
    const spec = this.core.tools.get(tool);
    if (!spec) throw new HttpError(404, `There is no tool named "${tool}".`);
    if (mode !== null && !['allow', 'ask', 'deny'].includes(mode)) throw new HttpError(400, 'mode must be allow, ask or deny.');
    const final = mode === null ? null : this.capMode(actor, spec.risk, mode);
    this.core.store.setGrant(agent.id, tool, final, `${actor.type}:${actor.id}`);
    this.core.gateway.log(actor, 'permission.set', tool, final ?? 'removed', mode !== final ? { requested: mode } : {}, { agentId: agent.id });
    this.core.emit('grants', { agentId: agent.id });
    return final;
  }

  // ── agents ────────────────────────────────────────────────────────────
  need(idOrName: string): Agent {
    const a = this.core.store.agent(idOrName);
    if (!a) throw new HttpError(404, `There is no agent "${idOrName}".`);
    return a;
  }

  private checkModel(spec: AgentSpec) {
    if (spec.providerId && !this.core.store.provider(spec.providerId)) throw new HttpError(400, 'Unknown provider.');
  }

  createAgent(spec: AgentSpec, actor: Actor) {
    const name = (spec.name ?? '').trim();
    if (!name) throw new HttpError(400, 'An agent needs a name.');
    if (name.length > 40) throw new HttpError(400, 'Keep the name under 40 characters.');
    if (this.core.store.agent(name)) throw new HttpError(409, `An agent named "${name}" already exists.`);
    this.checkModel(spec);
    const count = this.core.store.agents().length;
    const agent = this.core.store.insertAgent({
      name,
      sprite: SPRITES.includes(spec.sprite as (typeof SPRITES)[number]) ? spec.sprite! : SPRITES[count % SPRITES.length],
      color: /^#[0-9a-f]{6}$/i.test(spec.color ?? '') ? spec.color! : COLORS[count % COLORS.length],
      role: (spec.role ?? '').trim(), instructions: (spec.instructions ?? '').trim(),
      providerId: spec.providerId ?? null, model: spec.providerId ? spec.model ?? null : null,
      status: spec.status === 'paused' ? 'paused' : 'active', a2a: !!spec.a2a,
      createdBy: `${actor.type}:${actor.id}`,
    });
    this.core.gateway.log(actor, 'agent.create', agent.name, 'ok', { sprite: agent.sprite }, { agentId: agent.id });
    for (const f of spec.functions ?? []) this.addFunction(agent.id, f, actor);
    for (const t of spec.tools ?? []) {
      const entry = typeof t === 'string' ? { name: t } : t;
      const tool = this.core.tools.get(entry.name);
      if (!tool) continue; // a drafted spec may name a tool that does not exist; skip rather than fail the whole agent
      this.setGrant(agent.id, tool.name, entry.mode ?? this.defaultMode(tool.risk), actor);
    }
    this.changed();
    return this.agentView(agent);
  }

  updateAgent(id: string, patch: AgentSpec, actor: Actor) {
    const cur = this.need(id);
    this.checkModel(patch);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new HttpError(400, 'An agent needs a name.');
      const clash = this.core.store.agent(name);
      if (clash && clash.id !== cur.id) throw new HttpError(409, `An agent named "${name}" already exists.`);
      patch.name = name;
    }
    const clean: Partial<Agent> = {};
    for (const k of ['name', 'sprite', 'color', 'role', 'instructions', 'providerId', 'model', 'status', 'a2a'] as const) {
      if (patch[k] !== undefined) (clean as Record<string, unknown>)[k] = patch[k];
    }
    if (clean.sprite && !SPRITES.includes(clean.sprite as (typeof SPRITES)[number])) delete clean.sprite;
    if (clean.status && !['active', 'paused'].includes(clean.status)) delete clean.status;
    if (clean.providerId === null) clean.model = null;
    const agent = this.core.store.updateAgent(cur.id, clean);
    this.core.gateway.log(actor, 'agent.update', agent.name, 'ok', { fields: Object.keys(clean) }, { agentId: agent.id });
    this.changed();
    return this.agentView(agent);
  }

  deleteAgent(id: string, actor: Actor) {
    const agent = this.need(id);
    this.core.store.deleteAgent(agent.id);
    this.core.gateway.log(actor, 'agent.delete', agent.name, 'ok', {}, { agentId: agent.id });
    this.changed();
  }

  // ── functions ─────────────────────────────────────────────────────────
  private checkFn(f: FnSpec) {
    const kind = f.kind ?? 'schedule';
    if (!['schedule', 'webhook', 'manual'].includes(kind)) throw new HttpError(400, 'kind must be schedule, webhook or manual.');
    if (kind === 'schedule') {
      if (!f.cron) throw new HttpError(400, 'A scheduled function needs a cron expression, for example "*/15 * * * *".');
      const bad = Scheduler.validate(f.cron);
      if (bad) throw new HttpError(400, `Invalid cron expression "${f.cron}": ${bad}`);
    }
    if (!(f.prompt ?? '').trim()) throw new HttpError(400, 'A function needs a prompt that says what to do when it fires.');
  }
  addFunction(agentId: string, f: FnSpec, actor: Actor) {
    const agent = this.need(agentId);
    this.checkFn(f);
    const kind = f.kind ?? 'schedule';
    const fn = this.core.store.insertFn({
      agentId: agent.id, name: (f.name ?? '').trim() || 'Untitled function', kind,
      cron: kind === 'schedule' ? f.cron! : null, prompt: f.prompt!.trim(), enabled: f.enabled !== false,
    });
    this.core.gateway.log(actor, 'function.add', fn.name, 'ok', { kind, cron: fn.cron }, { agentId: agent.id });
    this.changed();
    return this.fnView(fn);
  }
  updateFunction(fnId: string, patch: FnSpec, actor: Actor) {
    const cur = this.core.store.fn(fnId);
    if (!cur) throw new HttpError(404, 'Function not found.');
    const merged = { ...cur, ...patch };
    this.checkFn(merged);
    const fn = this.core.store.updateFn(fnId, {
      name: merged.name, kind: merged.kind, cron: merged.kind === 'schedule' ? merged.cron : null,
      prompt: merged.prompt, enabled: merged.enabled,
    });
    this.core.gateway.log(actor, 'function.update', fn.name, 'ok', {}, { agentId: fn.agentId });
    this.changed();
    return this.fnView(fn);
  }
  removeFunction(fnId: string, actor: Actor) {
    const fn = this.core.store.fn(fnId);
    if (!fn) throw new HttpError(404, 'Function not found.');
    this.core.store.deleteFn(fnId);
    this.core.gateway.log(actor, 'function.remove', fn.name, 'ok', {}, { agentId: fn.agentId });
    this.changed();
  }
  runFunction(fnId: string, actor: Actor) {
    const fn = this.core.store.fn(fnId);
    if (!fn) throw new HttpError(404, 'Function not found.');
    this.core.gateway.log(actor, 'function.run', fn.name, 'ok', {}, { agentId: fn.agentId });
    return this.core.runtime.run(fn.agentId, { trigger: 'manual', input: fn.prompt, functionId: fn.id });
  }

  // ── custom tools ──────────────────────────────────────────────────────
  saveTool(input: ToolInput, actor: Actor) {
    const { store, tools } = this.core;
    if (!TOOL_NAME_RE.test(input.name ?? '')) throw new HttpError(400, 'Tool names use lowercase letters, digits and underscores, start with a letter, and are 2 to 48 characters long.');
    if (tools.isBuiltin(input.name)) throw new HttpError(409, `"${input.name}" is a built-in tool.`);
    if (!['http', 'js'].includes(input.kind)) throw new HttpError(400, 'kind must be http or js.');
    if (!(input.description ?? '').trim()) throw new HttpError(400, 'Describe what the tool does: the description is what an agent reads to decide when to use it.');
    const config = input.config ?? {};
    if (input.kind === 'http' && typeof config.url !== 'string') throw new HttpError(400, 'An HTTP tool needs config.url.');
    if (input.kind === 'js' && typeof config.code !== 'string') throw new HttpError(400, 'A JavaScript tool needs config.code.');
    const existing = store.customTool(input.name);
    const byUser = actor.type === 'user';
    // A harness cannot vouch for its own tool. Whatever it writes is treated as able to act until a person reviews it.
    const tool = {
      name: input.name, kind: input.kind, description: input.description.trim(),
      inputSchema: input.inputSchema?.type === 'object' ? input.inputSchema : { type: 'object', properties: {} },
      config,
      risk: byUser ? (['safe', 'read', 'act'].includes(input.risk ?? '') ? input.risk! : 'act') : ('act' as Risk),
      reviewed: byUser ? input.reviewed !== false : false,
      createdAt: existing?.createdAt ?? now(), createdBy: existing?.createdBy ?? `${actor.type}:${actor.id}`,
    };
    store.upsertTool(tool);
    this.core.gateway.log(actor, existing ? 'tool.update' : 'tool.create', tool.name, 'ok', { kind: tool.kind, risk: tool.risk, reviewed: tool.reviewed });
    this.core.emit('tools', {});
    return tools.describe(tools.get(tool.name)!);
  }
  deleteTool(name: string, actor: Actor) {
    if (this.core.tools.isBuiltin(name)) throw new HttpError(409, 'Built-in tools cannot be deleted.');
    if (!this.core.store.customTool(name)) throw new HttpError(404, 'Tool not found.');
    this.core.store.deleteTool(name);
    this.core.gateway.log(actor, 'tool.delete', name, 'ok');
    this.core.emit('tools', {});
  }
  /** Run a tool once, outside any agent. A harness needs a person's approval for anything that is not "safe". */
  testTool(name: string, args: Record<string, unknown>, actor: Actor) {
    const spec = this.core.tools.get(name);
    if (!spec) throw new HttpError(404, `There is no tool named "${name}".`);
    const mode: Mode = actor.type === 'user' ? 'allow' : spec.risk === 'safe' ? 'allow' : 'ask';
    return this.core.gateway.call({ actor, agent: null, runId: null, tool: name, args: args ?? {}, mode });
  }

  // ── drafting an agent from a plain description ────────────────────────
  async draftAgent(description: string): Promise<AgentSpec> {
    if (!description.trim()) throw new HttpError(400, 'Describe what the agent should do.');
    const { client, model } = this.core.llmFor(null);
    const toolList = this.core.tools.list().map((t) => `- ${t.name} (${t.risk}): ${t.description.split('. ')[0]}.`).join('\n');
    const system = `You design "shadow agents": small assistants that run in the background for one person. Turn the person's description into one agent definition.

Reply with a single JSON object and nothing else, in this shape:
{"name": string, "sprite": one of ${JSON.stringify(SPRITES)}, "color": one of ${JSON.stringify(COLORS)}, "role": string, "instructions": string, "functions": [{"name": string, "kind": "schedule" | "webhook" | "manual", "cron": string or null, "prompt": string}], "tools": [tool names]}

What each field is for:
- name: two words at most, like a character name for a helper.
- role: one sentence saying what the agent is responsible for.
- instructions: the standing guidance the agent reads on every run. Write it to the agent as "you". Cover what counts as worth reporting, what to ignore, and the tone of its notifications. Leave clearly marked placeholders for details the person did not give, such as URLs.
- functions: the jobs that wake the agent. A "schedule" function needs a 5-field cron expression in the server's local time. Each prompt says what to do on that wake-up, including what to remember for next time. Leave the list empty for an agent the person only talks to.
- tools: only the tools the job needs. An agent that reports to its owner needs notify. An agent that must not repeat itself between runs needs memory_get and memory_set.

Available tools:
${toolList}`;
    const res = await client.complete({ model, system, tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: description }] }] });
    const text = textOf(res.content);
    const start = text.indexOf('{'); const end = text.lastIndexOf('}');
    let spec: AgentSpec;
    try {
      spec = JSON.parse(text.slice(start, end + 1)) as AgentSpec;
    } catch {
      throw new HttpError(502, 'The model did not return a usable agent definition. Try again, or describe the agent in more detail.');
    }
    return {
      name: String(spec.name ?? 'New Shadow').slice(0, 40),
      sprite: SPRITES.includes(spec.sprite as (typeof SPRITES)[number]) ? spec.sprite : 'wisp',
      color: COLORS.includes(spec.color ?? '') ? spec.color : COLORS[0],
      role: String(spec.role ?? ''), instructions: String(spec.instructions ?? ''),
      functions: (Array.isArray(spec.functions) ? spec.functions : []).filter((f) => f && f.prompt).map((f) => ({
        name: String(f.name ?? 'Function'), kind: ['schedule', 'webhook', 'manual'].includes(f.kind ?? '') ? f.kind : 'manual',
        cron: f.cron && !Scheduler.validate(f.cron) ? f.cron : f.kind === 'schedule' ? '0 * * * *' : null, prompt: String(f.prompt),
      })),
      tools: (Array.isArray(spec.tools) ? spec.tools : []).map((t) => (typeof t === 'string' ? t : t?.name)).filter((t): t is string => !!t && !!this.core.tools.get(t)),
    };
  }

  private changed() {
    this.core.scheduler.sync();
    this.core.emit('agents', {});
  }
}
