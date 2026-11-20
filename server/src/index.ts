import { Core } from './core.ts';
import { createServer, publicUrl, VERSION } from './api.ts';

/** On the first start, pick up whatever AI is already available so the app works without a settings detour. */
async function seedProviders(core: Core) {
  if (core.store.providers().length) return;
  const env = process.env;
  if (env.ANTHROPIC_API_KEY) {
    const p = core.store.upsertProvider({ name: 'Claude', kind: 'anthropic', baseUrl: null, secret: null, model: env.SHADOW_ANTHROPIC_MODEL ?? 'claude-opus-5-5' });
    core.vault.set(`PROVIDER_${p.id.toUpperCase()}`, env.ANTHROPIC_API_KEY);
    core.store.upsertProvider({ ...p, secret: `PROVIDER_${p.id.toUpperCase()}` });
  }
  for (const [key, name, baseUrl, model] of [
    ['OPENAI_API_KEY', 'OpenAI', 'https://api.openai.com/v1', env.SHADOW_OPENAI_MODEL ?? 'gpt-5'],
    ['XAI_API_KEY', 'Grok', 'https://api.x.ai/v1', env.SHADOW_XAI_MODEL ?? 'grok-4'],
  ] as const) {
    if (!env[key]) continue;
    const p = core.store.upsertProvider({ name, kind: 'openai', baseUrl, secret: null, model });
    core.vault.set(`PROVIDER_${p.id.toUpperCase()}`, env[key]!);
    core.store.upsertProvider({ ...p, secret: `PROVIDER_${p.id.toUpperCase()}` });
  }
  // A local Ollama: on the host when running natively, or through host.docker.internal from the container.
  const candidates = env.SHADOW_OLLAMA_URL ? [env.SHADOW_OLLAMA_URL] : ['http://127.0.0.1:11434', 'http://host.docker.internal:11434'];
  for (const url of candidates) {
    try {
      const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1500) });
      const data = (await res.json()) as { models?: { name: string; size: number }[] };
      const models = (data.models ?? []).filter((m) => !m.name.startsWith('llamacpp:')).sort((a, b) => b.size - a.size);
      const model = env.SHADOW_OLLAMA_MODEL ?? models[0]?.name;
      if (!model) continue;
      core.store.upsertProvider({ name: 'Ollama (local)', kind: 'openai', baseUrl: `${url}/v1`, secret: null, model });
      break;
    } catch { /* not running here */ }
  }
  const first = core.store.providers()[0];
  if (first) core.store.setSetting('defaultProvider', first.id);
}

const core = new Core();
await seedProviders(core);
const server = createServer(core);
const host = process.env.SHADOW_HOST ?? '127.0.0.1';
await server.listen(host);
core.scheduler.start();

const provider = core.defaultProvider();
console.log(`
  ◢◤ SHADOW AGENTS ${VERSION}
  server   ${publicUrl(core)}  (listening on ${host}:${core.port})
  data     ${core.home}
  ai       ${provider ? `${provider.name} · ${provider.model}` : 'none configured yet: add one in the app under Settings'}
  agents   ${core.store.agents().length}
  mcp      ${publicUrl(core)}/mcp   (token in ${core.home}/mcp.token)
`);

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await server.close();
    core.close();
    process.exit(0);
  });
}
