# Shadow Agents

A framework for making **shadow agents**: small AI agents that keep working for you around the clock on your own
machine. One watches your inbox and pings you about mail that matters, another checks a site every 15 minutes,
another writes your morning briefing.

Each shadow is a voxel sprite in a desktop app. A shadow can have one job or several. Everything a shadow does
passes through a **gateway** where you set permissions, approve sensitive calls, and read a full audit log.
The whole thing is also an **MCP server**, so Claude, Grok, ChatGPT or any other assistant can build and manage
shadows for you, and shadows speak **A2A** so agents from other frameworks can talk to them.

```
┌───────────────────────┐   HTTP + WebSocket   ┌──────────────────────────────────────────┐
│  Desktop app          │ ───────────────────► │  Shadow Agent server (Docker or Node)    │
│  Electron + React     │                      │                                          │
│  three.js voxel       │                      │  scheduler ─► runtime ─► GATEWAY ─► tools │
│  sprites, anime.js    │                      │                 │         │   audit log   │
└───────────────────────┘                      │                 ▼         ▼   approvals   │
┌───────────────────────┐        MCP           │        AI provider     secrets vault     │
│  Claude Code, Cursor, │ ───────────────────► │  (Claude, OpenAI, Grok, Ollama, …)       │
│  ChatGPT, Grok …      │                      │                                          │
└───────────────────────┘        A2A           │  SQLite in ~/.shadowagent                │
   other agents  ◄──────────────────────────► └──────────────────────────────────────────┘
```

## Quick start

You need Node 24+ and, for the always-on server, Docker.

```bash
npm install

# 1. Start the server. It restarts with Docker and keeps your shadows running with the app closed.
docker compose up -d

# 2. Open the desktop app.
npm run app
```

Without Docker, run `npm run server` instead of step 1 (or `npm run dev` for server + app with hot reload).

The app finds the server on `http://127.0.0.1:7777` and reads its admin token from `~/.shadowagent/admin.token`,
which the server creates on first start. There is nothing to paste.

### Give it a brain

On first start the server picks up whatever AI it can find:

| You have | What to do |
|---|---|
| Ollama on this machine | Nothing. It is detected and its largest model becomes the default. Use a model that supports tool calling. |
| An Anthropic, OpenAI or xAI key | Put `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `XAI_API_KEY` in `.env` (see `.env.example`) before `docker compose up`, or add it in the app under **Settings**. |
| LM Studio, OpenRouter, vLLM, llama.cpp | **Settings → Add Other**, with the server's OpenAI-compatible base URL. |

Each shadow can use its own provider and model.

## Making a shadow

Four ways, all ending in the same reviewable definition:

1. **Describe it.** In the **Forge**, type what you want ("check my inbox every 10 minutes and ping me when a
   real person needs a reply"). Your AI drafts the role, instructions, jobs and tools; you review and summon.
2. **Template.** Mail Sentinel, News Scout, Site Watcher, Daily Brief, Scribe.
3. **By hand.** Blank shadow, every field yours.
4. **Ask your assistant.** Connect Claude Code (or any MCP client) and say "make me a shadow that…". See below.

A shadow is made of:

- **Role and standing instructions** it reads on every run.
- **Jobs** that wake it: on a schedule (cron), on a webhook, or when you press Run. Several per shadow is fine.
- **Tools** it may use, each set to Off, Ask or Allow.
- **Memory** (key/value) and a private **workspace folder**, the only things that persist between runs.

You can also just talk to any shadow from its panel.

## The gateway

Every tool call from every shadow goes through one place ([server/src/gateway.ts](server/src/gateway.ts)):

- **Permissions.** Per shadow, per tool: **Off**, **Ask** (the run pauses until you approve the exact call) or
  **Allow**. With no grant, a call is denied.
- **Approvals.** Pending calls show the tool and its arguments. Approve once, reject, or "always allow".
  Unanswered requests expire (60 minutes by default) and the call does not run.
- **Audit log.** One entry per tool call with its decision, duration and (redacted) arguments, plus every
  permission and configuration change and who made it. Entries are hash-chained; **Verify log integrity**
  recomputes the chain and reports the first altered entry.
- **Secrets vault.** API keys and passwords are encrypted on disk (AES-256-GCM) and write-only. Tools use them;
  no agent, model or MCP client can read one back, and values that show up in tool output are redacted.

Tools carry a risk level: *stays inside* (memory, files, notify), *reads outside* (web, mail, feeds) or
*acts outside* (send mail, call another agent).

### What a connected assistant cannot do

An MCP client can create agents and tools, so the gateway limits what that is worth:

- Grants it makes for tools that read or act outside are stored as **Ask**, whatever it requests. Only you can
  raise them to Allow.
- Tools it creates are **unreviewed** and treated as *acts outside*: every call asks you, even on Allow, until
  you review the tool in the Armory.
- It has no way to approve requests, read secrets, or obtain the admin token.

## Tools

Built in: `notify`, `memory_get`, `memory_set`, `http_fetch`, `rss_read`, `email_fetch` (IMAP), `email_send`
(SMTP), `file_read`, `file_write`, `agent_message` (shadow to shadow), `a2a_call` (remote agents), `time_now`.

Make your own in the **Armory**:

- **HTTP tool**: method, URL, headers and body with `{{input}}` and `{{secret.NAME}}` placeholders.
- **JavaScript tool**: the body of `async (args, secrets) => …` with `fetch` available. It runs in a separate
  thread with a 20 second limit and no access to the server process.

Every tool has a test runner. A custom tool can only read the secrets you list on it.

For email, store `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS` (and `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` to send) under
**Settings → Secrets**. Most providers need an app password.

## Connect an assistant (MCP)

**Gateway → Connect** shows the endpoint, the token and ready-to-paste snippets.

```bash
# Claude Code
claude mcp add --transport http shadow-agents http://127.0.0.1:7777/mcp \
  --header "Authorization: Bearer $(cat ~/.shadowagent/mcp.token)"
```

Clients that launch a command (Claude Desktop, Cursor) use the stdio bridge, which reads the token itself:

```json
{ "mcpServers": { "shadow-agents": { "command": "node", "args": ["/path/to/shadow_agents_maker/server/src/mcp-stdio.ts"] } } }
```

Hosted assistants (ChatGPT, Grok) connect from the internet, so they need a public HTTPS address: put a tunnel in
front of port 7777 and add `<tunnel>/mcp` as a remote MCP server with the token as a Bearer token.

Then ask for what you want. The server exposes `shadow_guide` (read first by the assistant), `create_agent`,
`update_agent`, `add_function`, `run_function`, `talk_to_agent`, `create_tool`, `test_tool`, `grant_tool`,
`get_audit_log`, `list_runs`, `list_approvals`, `set_secret` and friends.

## Agent to agent (A2A)

Switch on **A2A** in a shadow's Setup tab and it gets:

- an agent card at `/a2a/<name>/.well-known/agent-card.json` (public, for discovery)
- a JSON-RPC endpoint at `/a2a/<name>` supporting `message/send` and `tasks/get`, protected by the A2A token

Shadows on the same machine message each other with `agent_message` (loops are refused), and reach remote A2A
agents with `a2a_call`.

## Security notes

- The server binds to `127.0.0.1` only. Three separate tokens: admin (the app), MCP (assistants), A2A (agents).
- Text returned by tools (emails, web pages, other agents) is untrusted. Agents are told to treat it as data,
  but a model can still be talked into things: keep tools that act outside on **Ask** unless you are sure.
- The JavaScript tool sandbox limits accidents, not a determined attacker. Running the server in Docker makes
  the container the boundary; that is the recommended setup.
- The vault key lives next to the database in `~/.shadowagent`. It protects against a leaked database file,
  not against someone with access to your user account.

## Development

```
server/   Node 24, TypeScript run directly (no build step), SQLite via node:sqlite
  src/gateway.ts     permission check → approval → execute → audit
  src/runtime.ts     the agent loop, one run at a time per agent
  src/scheduler.ts   cron jobs for scheduled functions
  src/tools/         built-in tools, custom HTTP/JS tool runner, sandbox worker
  src/llm/           provider adapters: Anthropic SDK, OpenAI-compatible
  src/mcp.ts         MCP server (Streamable HTTP); mcp-stdio.ts is the stdio bridge
  src/a2a.ts         A2A agent cards and JSON-RPC
  src/ops.ts         operations shared by the REST API and MCP, including the limits on MCP callers
app/      Electron + React + Vite
  src/sprites/       pixel maps → voxel meshes, shared portrait renderer, the realm stage
  src/views/         Realm, Forge, Armory, Gateway, Inbox, Settings, agent panel
```

```bash
npm test          # 26 backend tests: gateway, runtime, tools, REST, WebSocket, A2A, MCP
npm run typecheck
npm run dev       # server with --watch + app with hot reload
```

To add a sprite, draw a 12×12 map in [app/src/sprites/models.ts](app/src/sprites/models.ts) and add its id to
`SPRITES` in [server/src/ops.ts](server/src/ops.ts).

Environment: `SHADOW_HOME` (data folder, default `~/.shadowagent`), `SHADOW_PORT` (7777), `SHADOW_HOST`,
`SHADOW_PUBLIC_URL` (what A2A cards and snippets advertise), `SHADOW_OLLAMA_URL`, `SHADOW_OLLAMA_MODEL`.

## Not there yet

- Streaming replies in chat; a shadow answers when its run finishes.
- Packaged installers for the desktop app (it runs from the repo with `npm run app`).
- OAuth for mail and other services; today email is IMAP/SMTP with an app password.
- A2A streaming and push notifications.

MIT licensed.
