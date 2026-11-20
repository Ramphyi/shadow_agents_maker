import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeCore, USER } from './helpers.ts';
import { validateArgs } from '../src/util.ts';

function echoServer() {
  const seen: { url: string; auth?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url!, auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, echo: req.headers.authorization }));
    });
  });
  return new Promise<{ url: string; seen: typeof seen; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => server.close() }));
  });
}

test('an HTTP tool fills arguments and secrets, and the secret never comes back', async () => {
  const { core, ops, cleanup } = makeCore();
  const srv = await echoServer();
  try {
    core.vault.set('WEATHER_KEY', 'wk-123456789');
    core.vault.set('OTHER_KEY', 'other-987654321');
    ops.saveTool({
      name: 'weather', kind: 'http', description: 'Weather for a city.', risk: 'read',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      config: { method: 'POST', url: `${srv.url}/v1/weather?q={{city}}`, headers: { authorization: 'Bearer {{secret.WEATHER_KEY}}', 'x-other': '{{secret.OTHER_KEY}}' }, body: '{"city":"{{city}}"}', secrets: ['WEATHER_KEY'] },
    }, USER);
    const out = await ops.testTool('weather', { city: 'Cluj Napoca' }, USER);
    assert.equal(out.ok, true);
    assert.equal(srv.seen[0].url, '/v1/weather?q=Cluj%20Napoca');
    assert.equal(srv.seen[0].auth, 'Bearer wk-123456789');
    assert.equal(srv.seen[0].body, '{"city":"Cluj Napoca"}');
    assert.match(out.output, /Bearer \[secret:WEATHER_KEY\]/, 'echoed secret is redacted');
    const missing = await ops.testTool('weather', {}, USER);
    assert.equal(missing.decision, 'invalid');
  } finally { srv.close(); cleanup(); }
});

test('a JavaScript tool runs isolated from the server process', async () => {
  const { ops, cleanup } = makeCore();
  try {
    ops.saveTool({ name: 'adder', kind: 'js', description: 'Adds.', config: { code: 'console.log("adding"); return { sum: args.a + args.b }' } }, USER);
    const out = await ops.testTool('adder', { a: 2, b: 3 }, USER);
    assert.match(out.output, /"sum": 5/);
    assert.match(out.output, /\[console\]\nadding/);
    ops.saveTool({ name: 'escape', kind: 'js', description: 'Tries to reach process.', config: { code: 'return typeof process + "," + typeof require' } }, USER);
    assert.equal((await ops.testTool('escape', {}, USER)).output, 'undefined,undefined');
    ops.saveTool({ name: 'thrower', kind: 'js', description: 'Throws.', config: { code: 'throw new Error("boom")' } }, USER);
    const bad = await ops.testTool('thrower', {}, USER);
    assert.equal(bad.ok, false);
    assert.match(bad.output, /boom/);
  } finally { cleanup(); }
});

test('workspace files stay inside the agent\'s folder', async () => {
  const { core, ops, cleanup } = makeCore();
  try {
    const agent = ops.createAgent({ name: 'Scribe', tools: ['file_read', 'file_write'] }, USER);
    const actor = { type: 'agent' as const, id: agent.id };
    const go = (tool: string, args: Record<string, unknown>) => core.gateway.call({ actor, agent, runId: null, tool, args });
    assert.equal((await go('file_write', { path: 'notes/todo.md', content: '- milk' })).ok, true);
    assert.equal((await go('file_read', { path: 'notes/todo.md' })).output, '- milk');
    assert.equal((await go('file_read', { path: 'notes' })).output, 'todo.md');
    const escape = await go('file_read', { path: '../../admin.token' });
    assert.equal(escape.ok, false);
    assert.match(escape.output, /outside your workspace/);
  } finally { cleanup(); }
});

test('agents cannot reach the server itself through web tools', async () => {
  const { core, ops, cleanup } = makeCore();
  try {
    core.port = 7777;
    const out = await ops.testTool('http_fetch', { url: 'http://localhost:7777/api/state' }, USER);
    assert.equal(out.ok, false);
    assert.match(out.output, /blocked/);
  } finally { cleanup(); }
});

test('rss_read parses RSS and Atom', async () => {
  const { ops, cleanup } = makeCore();
  const feed = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[First & best]]></title><link>https://x.test/1</link><pubDate>Mon, 01 Jan 2026</pubDate><description>&lt;p&gt;Hello&lt;/p&gt;</description></item><item><title>Second</title><link>https://x.test/2</link></item></channel></rss>`;
  const server = http.createServer((_q, r) => r.end(feed));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const out = await ops.testTool('rss_read', { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/feed`, limit: 5 }, USER);
    const items = JSON.parse(out.output);
    assert.equal(items.length, 2);
    assert.deepEqual([items[0].title, items[0].link, items[1].title], ['First & best', 'https://x.test/1', 'Second']);
  } finally { server.close(); cleanup(); }
});

test('validateArgs checks types, required fields and enums', () => {
  const schema = { type: 'object', properties: { n: { type: 'integer' }, mode: { type: 'string', enum: ['a', 'b'] }, list: { type: 'array', items: { type: 'string' } } }, required: ['n'] };
  assert.equal(validateArgs(schema, { n: 1, mode: 'a', list: ['x'] }), null);
  assert.match(validateArgs(schema, {})!, /n is required/);
  assert.match(validateArgs(schema, { n: 1.5 })!, /must be integer/);
  assert.match(validateArgs(schema, { n: 1, mode: 'c' })!, /one of/);
  assert.match(validateArgs(schema, { n: 1, list: [2] })!, /list\[0\]/);
});
