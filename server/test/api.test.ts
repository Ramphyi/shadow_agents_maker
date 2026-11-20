import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';
import { call, makeServer, until } from './helpers.ts';
import { extractA2aText } from '../src/tools/builtin.ts';

test('REST: auth, agent lifecycle, chat, state', async () => {
  const s = await makeServer();
  try {
    assert.equal((await s.api('GET', '/health', undefined, '')).body.ok, true);
    assert.equal((await s.api('GET', '/api/state', undefined, '')).status, 401);
    assert.equal((await s.api('GET', '/api/state', undefined, s.core.tokens.mcp)).status, 401, 'the MCP token is not an admin token');

    const made = await s.api('POST', '/api/agents', { name: 'Owl', sprite: 'owl', role: 'Watches', tools: ['notify'], functions: [{ name: 'Hook', kind: 'webhook', prompt: 'Handle it' }] });
    assert.equal(made.status, 200);
    assert.equal((await s.api('POST', '/api/agents', { name: 'owl' })).status, 409);

    s.script.push('Hoot.');
    const chat = await s.api('POST', `/api/agents/${made.body.id}/chat`, { message: 'hello' });
    assert.equal(chat.body.run.output, 'Hoot.');

    const state = (await s.api('GET', '/api/state')).body;
    assert.equal(state.agents[0].name, 'Owl');
    assert.ok(state.tools.some((t: any) => t.name === 'email_fetch' && t.missing.includes('IMAP_HOST')));
    assert.equal(JSON.stringify(state).includes(s.core.tokens.admin), false);

    // webhook trigger: key required, payload reaches the agent
    const hook = made.body.functions[0].hookUrl as string;
    assert.equal((await s.api('POST', hook.replace(/key=.*/, 'key=wrong'), { a: 1 }, '')).status, 404);
    s.script.push((req) => { assert.match((req.messages[0].content[0] as any).text, /"order":17/); return 'handled'; });
    assert.equal((await s.api('POST', hook, { order: 17 }, '')).status, 202);
    await until(() => s.core.store.runs(made.body.id).find((r) => r.trigger === 'webhook' && r.status === 'completed'));

    assert.equal((await s.api('DELETE', `/api/agents/${made.body.id}`)).status, 200);
    assert.equal(s.core.store.agents().length, 0);
  } finally { await s.cleanup(); }
});

test('REST: secrets are write-only and providers hide their key', async () => {
  const s = await makeServer();
  try {
    assert.equal((await s.api('PUT', '/api/secrets', { name: 'imap_pass', value: 'hunter2-hunter2' })).status, 200);
    const p = await s.api('PUT', '/api/providers', { name: 'Claude', kind: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-test-0000' });
    assert.equal(p.body.hasKey, true);
    const dump = JSON.stringify((await s.api('GET', '/api/state')).body);
    assert.ok(dump.includes('IMAP_PASS'));
    assert.ok(!dump.includes('hunter2') && !dump.includes('sk-ant-test'));
    assert.equal((await s.api('GET', '/api/state')).body.defaultProvider, p.body.id);
  } finally { await s.cleanup(); }
});

test('WebSocket streams live events to the app', async () => {
  const s = await makeServer();
  try {
    const bad = new WebSocket(`${s.base.replace('http', 'ws')}/ws?token=nope`);
    await new Promise((r) => bad.on('error', r));
    const ws = new WebSocket(`${s.base.replace('http', 'ws')}/ws?token=${s.core.tokens.admin}`);
    const events: any[] = [];
    ws.on('message', (m) => events.push(JSON.parse(String(m))));
    await new Promise((r) => ws.on('open', r));
    const agent = (await s.api('POST', '/api/agents', { name: 'Nyx', tools: ['notify'] })).body;
    s.script.push([call('notify', { title: 'ping' })], 'done');
    await s.api('POST', `/api/agents/${agent.id}/chat`, { message: 'ping me' });
    await until(() => events.some((e) => e.type === 'notification' && e.data.title === 'ping'));
    assert.ok(events.some((e) => e.type === 'agent.state' && e.data.state === 'working'));
    assert.ok(events.some((e) => e.type === 'audit' && e.data.action === 'tool.call'));
    ws.close();
  } finally { await s.cleanup(); }
});

test('A2A: card discovery, message/send, tasks/get, auth', async () => {
  const s = await makeServer();
  try {
    await s.api('POST', '/api/agents', { name: 'Hidden One' });
    await s.api('POST', '/api/agents', { name: 'Mail Sentinel', role: 'Watches mail', a2a: true });
    assert.equal((await s.api('GET', '/a2a/hidden-one/.well-known/agent-card.json', undefined, '')).status, 404);
    const card = (await s.api('GET', '/a2a/mail-sentinel/.well-known/agent-card.json', undefined, '')).body;
    assert.equal(card.name, 'Mail Sentinel');
    assert.equal(card.protocolVersion, '0.3.0');
    assert.match(card.url, /\/a2a\/mail-sentinel$/);

    const rpc = (method: string, params: unknown, token = s.core.tokens.a2a) => s.api('POST', '/a2a/mail-sentinel', { jsonrpc: '2.0', id: 1, method, params }, token);
    const msg = { message: { kind: 'message', role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'Any urgent mail?' }] } };
    assert.equal((await rpc('message/send', msg, 'wrong')).status, 401);
    assert.equal((await rpc('message/send', msg, s.core.tokens.mcp)).status, 401);

    s.script.push((req) => { assert.match(req.system, /outside agent/); return 'Nothing urgent.'; });
    const sent = (await rpc('message/send', msg)).body;
    assert.equal(sent.result.kind, 'task');
    assert.equal(sent.result.status.state, 'completed');
    assert.equal(extractA2aText(sent.result), 'Nothing urgent.');
    const got = (await rpc('tasks/get', { id: sent.result.id })).body;
    assert.equal(got.result.artifacts[0].parts[0].text, 'Nothing urgent.');
    assert.equal((await rpc('tasks/nope', {})).body.error.code, -32601);
    assert.equal((await rpc('message/send', { message: { parts: [] } })).body.error.code, -32602);
  } finally { await s.cleanup(); }
});

test('MCP: a harness builds, tests and inspects an agent, within the gateway\'s limits', async () => {
  const s = await makeServer();
  try {
    const connect = async (token: string) => {
      const client = new Client({ name: 'claude-code-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      return client;
    };
    await assert.rejects(connect('wrong-token'));
    const client = await connect(s.core.tokens.mcp);
    const text = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0].text, isError: !!r.isError };
    };

    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['shadow_guide', 'create_agent', 'talk_to_agent', 'create_tool', 'grant_tool', 'get_audit_log']) assert.ok(names.includes(n), n);
    assert.ok(!names.some((n) => /approve|resolve/.test(n)), 'a harness has no way to approve');
    assert.match((await text('shadow_guide')).text, /stored as "ask"/);

    const made = JSON.parse((await text('create_agent', {
      name: 'Mail Sentinel', role: 'Watches the inbox', instructions: 'Report important mail.', sprite: 'owl',
      functions: [{ name: 'Check inbox', kind: 'schedule', cron: '*/5 * * * *', prompt: 'Check for new mail.' }],
      tools: ['email_fetch', 'notify', 'memory_get', 'memory_set'],
    })).text);
    assert.deepEqual(made.tools.sort(), ['email_fetch:ask', 'memory_get:allow', 'memory_set:allow', 'notify:allow']);
    assert.equal(s.core.store.agent('Mail Sentinel')!.createdBy, 'mcp:claude-code-test');

    assert.equal(JSON.parse((await text('grant_tool', { agent: 'Mail Sentinel', tool: 'email_fetch', mode: 'allow' })).text).mode, 'ask');
    const dup = await text('create_agent', { name: 'Mail Sentinel', role: 'x', instructions: 'y' });
    assert.ok(dup.isError && /already exists/.test(dup.text));

    s.script.push([call('notify', { title: 'hello from MCP' })], 'Notified you.');
    assert.equal((await text('talk_to_agent', { agent: 'Mail Sentinel', message: 'ping me' })).text, 'Notified you.');
    assert.match((await text('list_notifications')).text, /hello from MCP/);
    assert.match((await text('get_audit_log', { agent: 'Mail Sentinel' })).text, /"action": "tool.call"/);

    // a harness-made tool needs a person before it runs, even for a direct test
    await text('create_tool', { name: 'ping_tool', kind: 'js', description: 'Returns pong.', input_schema: { type: 'object', properties: {} }, config: { code: 'return "pong"' } });
    const pending = text('test_tool', { name: 'ping_tool' });
    const approval = await until(() => s.core.store.approvals('pending')[0]);
    assert.equal(approval.actor, 'mcp:claude-code-test');
    assert.match((await text('list_approvals')).text, /ping_tool/);
    await s.api('POST', `/api/approvals/${approval.id}`, { approve: true });
    assert.match((await pending).text, /pong/);

    await text('set_secret', { name: 'imap_pass', value: 'pw-123456789' });
    assert.ok(s.core.vault.has('IMAP_PASS'));
    assert.ok(!(await text('get_audit_log')).text.includes('pw-123456789'));
    await client.close();
  } finally { await s.cleanup(); }
});
