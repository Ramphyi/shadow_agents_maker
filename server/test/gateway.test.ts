import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, MCP, until, USER } from './helpers.ts';

test('a tool call without a grant is denied and audited', async () => {
  const { core, ops, cleanup } = makeCore();
  try {
    const agent = ops.createAgent({ name: 'Nyx' }, USER);
    const out = await core.gateway.call({ actor: { type: 'agent', id: agent.id }, agent, runId: null, tool: 'notify', args: { title: 'hi' } });
    assert.equal(out.ok, false);
    assert.equal(out.decision, 'denied');
    assert.equal(core.store.notifications().length, 0);
    const entry = core.store.audit({ action: 'tool.call' })[0];
    assert.equal(entry.decision, 'denied');
    assert.equal(entry.agentId, agent.id);
  } finally { cleanup(); }
});

test('an allowed call runs; invalid arguments are rejected before running', async () => {
  const { core, ops, cleanup } = makeCore();
  try {
    const agent = ops.createAgent({ name: 'Nyx', tools: ['notify'] }, USER);
    const actor = { type: 'agent' as const, id: agent.id };
    const ok = await core.gateway.call({ actor, agent, runId: null, tool: 'notify', args: { title: 'Build finished', level: 'success' } });
    assert.equal(ok.ok, true);
    assert.equal(core.store.notifications()[0].title, 'Build finished');
    const bad = await core.gateway.call({ actor, agent, runId: null, tool: 'notify', args: { body: 'no title' } });
    assert.equal(bad.decision, 'invalid');
    assert.equal(core.store.notifications().length, 1);
  } finally { cleanup(); }
});

test('"ask" pauses the call until a person approves or rejects it', async () => {
  const { core, ops, cleanup } = makeCore();
  try {
    const agent = ops.createAgent({ name: 'Nyx', tools: [{ name: 'notify', mode: 'ask' }] }, USER);
    const actor = { type: 'agent' as const, id: agent.id };

    const first = core.gateway.call({ actor, agent, runId: null, tool: 'notify', args: { title: 'one' } });
    const a1 = await until(() => core.store.approvals('pending')[0]);
    assert.equal(core.state(agent.id), 'waiting');
    assert.equal(core.store.notifications().length, 0, 'must not run before approval');
    core.gateway.resolve(a1.id, false, USER);
    assert.equal((await first).decision, 'rejected');
    assert.equal(core.store.notifications().length, 0);

    const second = core.gateway.call({ actor, agent, runId: null, tool: 'notify', args: { title: 'two' } });
    const a2 = await until(() => core.store.approvals('pending')[0]);
    core.gateway.resolve(a2.id, true, USER, true);
    assert.equal((await second).decision, 'approved');
    assert.equal(core.store.notifications()[0].title, 'two');
    assert.equal(core.store.grant(agent.id, 'notify')?.mode, 'allow', '"always" raises the grant');
    assert.throws(() => core.gateway.resolve(a2.id, true, USER), /already approved/);
  } finally { cleanup(); }
});

test('an unanswered approval expires and the call does not run', async () => {
  const { core, ops, cleanup } = makeCore();
  try {
    core.store.setSetting('approvalMinutes', '0.0005'); // 30 ms
    const agent = ops.createAgent({ name: 'Nyx', tools: [{ name: 'notify', mode: 'ask' }] }, USER);
    const out = await core.gateway.call({ actor: { type: 'agent', id: agent.id }, agent, runId: null, tool: 'notify', args: { title: 'x' } });
    assert.equal(out.decision, 'expired');
    assert.equal(core.store.approvals()[0].status, 'expired');
    assert.equal(core.store.notifications().length, 0);
  } finally { cleanup(); }
});

test('a harness cannot grant itself unattended access to outside-facing tools', () => {
  const { core, ops, cleanup } = makeCore();
  try {
    const agent = ops.createAgent({ name: 'Mailer', tools: ['email_fetch', 'email_send', 'notify', { name: 'http_fetch', mode: 'allow' }] }, MCP);
    const modes = Object.fromEntries(core.store.grants(agent.id).map((g) => [g.tool, g.mode]));
    assert.deepEqual(modes, { email_fetch: 'ask', email_send: 'ask', notify: 'allow', http_fetch: 'ask' });
    assert.equal(ops.setGrant(agent.id, 'email_send', 'allow', MCP), 'ask');
    assert.equal(ops.setGrant(agent.id, 'email_send', 'allow', USER), 'allow');
  } finally { cleanup(); }
});

test('a tool made by a harness is unreviewed: "allow" still asks until a person reviews it', async () => {
  const { core, ops, cleanup } = makeCore();
  try {
    const spec = { name: 'echo_tool', kind: 'js' as const, description: 'Echo.', config: { code: 'return "echo:" + args.text' }, inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, risk: 'safe' as const, reviewed: true };
    const made = ops.saveTool(spec, MCP);
    assert.equal(made.reviewed, false);
    assert.equal(made.risk, 'act', 'a harness cannot declare its own tool safe');
    const agent = ops.createAgent({ name: 'Nyx' }, USER);
    ops.setGrant(agent.id, 'echo_tool', 'allow', USER);
    assert.equal(core.gateway.effectiveMode({ agent, tool: 'echo_tool' }), 'ask');

    ops.saveTool({ ...spec, reviewed: true }, USER);
    assert.equal(core.gateway.effectiveMode({ agent, tool: 'echo_tool' }), 'allow');
    const out = await core.gateway.call({ actor: { type: 'agent', id: agent.id }, agent, runId: null, tool: 'echo_tool', args: { text: 'hi' } });
    assert.equal(out.output, 'echo:hi');
  } finally { cleanup(); }
});

test('secrets are redacted from tool output and from the audit log', async () => {
  const { core, ops, cleanup } = makeCore();
  try {
    core.vault.set('API_KEY', 'sk-super-secret-123');
    ops.saveTool({ name: 'leaky', kind: 'js', description: 'Leaks.', config: { code: 'return "key is " + secrets.API_KEY', secrets: ['API_KEY'] } }, USER);
    const out = await ops.testTool('leaky', {}, USER);
    assert.equal(out.output, 'key is [secret:API_KEY]');
    assert.ok(!JSON.stringify(core.store.audit()).includes('sk-super-secret-123'));
    assert.ok(!core.store.secretRaw('API_KEY')!.includes('sk-super-secret-123'), 'stored encrypted');
  } finally { cleanup(); }
});

test('the audit log is hash-chained and detects tampering', async () => {
  const { core, ops, cleanup } = makeCore();
  try {
    const agent = ops.createAgent({ name: 'Nyx', tools: ['notify'] }, USER);
    await core.gateway.call({ actor: { type: 'agent', id: agent.id }, agent, runId: null, tool: 'notify', args: { title: 'a' } });
    assert.equal(core.store.verifyAudit().brokenAt, null);
    const victim = core.store.audit({ action: 'tool.call' })[0];
    core.store.db.prepare("UPDATE audit SET decision = 'denied' WHERE id = ?").run(victim.id);
    assert.equal(core.store.verifyAudit().brokenAt, victim.id);
  } finally { cleanup(); }
});
