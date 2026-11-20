import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeCore, until, USER } from './helpers.ts';

test('a run loops over tool calls, feeds results back, and finishes', async () => {
  const { core, ops, script, cleanup } = makeCore();
  try {
    const agent = ops.createAgent({ name: 'Nyx', role: 'Tester', tools: ['notify', 'memory_set', 'memory_get'] }, USER);
    script.push(
      [call('memory_set', { key: 'last_uid', value: '42' }), call('notify', { title: '2 new mails', body: 'From Ana, from Bo' })],
      (req) => {
        const results = req.messages.at(-1)!.content;
        assert.equal(results.length, 2, 'both results come back in one user message');
        assert.ok(results.every((b) => b.type === 'tool_result' && !b.is_error));
        return 'Checked the inbox: 2 new.';
      },
    );
    const run = await core.runtime.run(agent.id, { trigger: 'manual', input: 'Check inbox' });
    assert.equal(run.status, 'completed');
    assert.equal(run.output, 'Checked the inbox: 2 new.');
    assert.equal(run.steps, 2);
    assert.equal(core.store.memoryGet(agent.id, 'last_uid'), '42');
    assert.equal(core.store.notifications()[0].title, '2 new mails');
    assert.equal(core.state(agent.id), 'idle');
    // only granted tools are offered to the model
    assert.deepEqual(script.requests[0].tools.map((t) => t.name).sort(), ['memory_get', 'memory_set', 'notify']);
    assert.match(script.requests[0].system, /You are Nyx/);
  } finally { cleanup(); }
});

test('a denied tool comes back to the model as an error result, not a crash', async () => {
  const { core, ops, script, cleanup } = makeCore();
  try {
    const agent = ops.createAgent({ name: 'Nyx', tools: ['notify'] }, USER);
    script.push([call('email_send', { to: 'a@b.c', subject: 's', body: 'b' })], (req) => {
      const r = req.messages.at(-1)!.content[0];
      assert.ok(r.type === 'tool_result' && r.is_error && /Permission denied/.test(r.content));
      return 'Could not send.';
    });
    const run = await core.runtime.run(agent.id, { trigger: 'manual', input: 'send it' });
    assert.equal(run.status, 'completed');
  } finally { cleanup(); }
});

test('chat keeps history between turns', async () => {
  const { core, ops, script, cleanup } = makeCore();
  try {
    const agent = ops.createAgent({ name: 'Nyx' }, USER);
    script.push('Hello!', (req) => {
      assert.deepEqual(req.messages.map((m) => m.role), ['user', 'assistant', 'user']);
      return 'You said hi.';
    });
    await core.runtime.run(agent.id, { trigger: 'chat', input: 'hi' });
    const second = await core.runtime.run(agent.id, { trigger: 'chat', input: 'what did I say?' });
    assert.equal(second.output, 'You said hi.');
    assert.deepEqual(core.store.messages(agent.id).map((m) => m.content), ['hi', 'Hello!', 'what did I say?', 'You said hi.']);
  } finally { cleanup(); }
});

test('shadows can message each other, and a loop is refused', async () => {
  const { core, ops, script, cleanup } = makeCore();
  try {
    const a = ops.createAgent({ name: 'Alpha', tools: ['agent_message'] }, USER);
    ops.createAgent({ name: 'Beta', tools: ['agent_message'] }, USER);
    script.push(
      [call('agent_message', { agent: 'Beta', message: 'status?' })],          // Alpha asks Beta
      [call('agent_message', { agent: 'Alpha', message: 'you tell me' })],      // Beta tries to ask Alpha back
      (req) => {                                                                 // Beta sees the refusal
        const r = req.messages.at(-1)!.content[0];
        assert.ok(r.type === 'tool_result' && r.is_error && /would loop/.test(r.content));
        return 'All quiet.';
      },
      (req) => {                                                                 // Alpha gets Beta's answer
        const r = req.messages.at(-1)!.content[0];
        assert.ok(r.type === 'tool_result' && r.content === 'All quiet.');
        return 'Beta says all quiet.';
      },
    );
    const run = await core.runtime.run(a.id, { trigger: 'manual', input: 'collect status' });
    assert.equal(run.output, 'Beta says all quiet.');
  } finally { cleanup(); }
});

test('an unattended failure notifies the owner once per streak', async () => {
  const { core, ops, script, cleanup } = makeCore();
  try {
    const agent = ops.createAgent({ name: 'Nyx' }, USER);
    script.push(() => { throw new Error('provider down'); }, () => { throw new Error('provider down'); });
    const r1 = await core.runtime.run(agent.id, { trigger: 'schedule', input: 'go' });
    await core.runtime.run(agent.id, { trigger: 'schedule', input: 'go' });
    assert.equal(r1.status, 'failed');
    assert.equal(core.state(agent.id), 'error');
    assert.equal(core.store.notifications().length, 1);
  } finally { cleanup(); }
});

test('runs for one agent are serialized', async () => {
  const { core, ops, script, cleanup } = makeCore();
  try {
    const agent = ops.createAgent({ name: 'Nyx' }, USER);
    let active = 0; let peak = 0;
    const slow = async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 30)); active--; return 'ok'; };
    const original = script.complete;
    script.complete = async (req) => { await slow(); return original(req); };
    script.push('a', 'b', 'c');
    await Promise.all([1, 2, 3].map(() => core.runtime.run(agent.id, { trigger: 'manual', input: 'x' })));
    assert.equal(peak, 1);
  } finally { cleanup(); }
});

test('a scheduled function fires on its cron and a paused agent does not', async () => {
  const { core, ops, script, cleanup } = makeCore();
  try {
    core.scheduler.start();
    const agent = ops.createAgent({ name: 'Tick', functions: [{ name: 'Every second', kind: 'schedule', cron: '* * * * * *', prompt: 'tick' }] }, USER);
    for (let i = 0; i < 10; i++) script.push('ticked');
    const run = await until(() => core.store.runs(agent.id).find((r) => r.status === 'completed'), 2500);
    assert.equal(run.trigger, 'schedule');
    assert.ok(core.store.functions(agent.id)[0].lastRun);
    ops.updateAgent(agent.id, { status: 'paused' }, USER);
    assert.equal(core.scheduler.nextRun(agent.functions[0].id), null);
    assert.throws(() => ops.addFunction(agent.id, { kind: 'schedule', cron: 'every tuesday', prompt: 'x' }, USER), /Invalid cron/);
  } finally { cleanup(); }
});
