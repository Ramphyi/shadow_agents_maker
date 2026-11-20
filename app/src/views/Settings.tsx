import { useState } from 'react';
import { useStore } from '../store';
import { act, api } from '../api';
import { useEnter } from '../anim';
import { Button, Chip, Field } from '../components/ui';
import type { Provider } from '../types';

const PRESETS = [
  { id: 'claude', label: 'Claude', kind: 'anthropic' as const, baseUrl: '', model: 'claude-opus-5-5', needsKey: true, hint: 'API key from console.anthropic.com' },
  { id: 'openai', label: 'OpenAI', kind: 'openai' as const, baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', needsKey: true, hint: 'API key from platform.openai.com' },
  { id: 'grok', label: 'Grok', kind: 'openai' as const, baseUrl: 'https://api.x.ai/v1', model: 'grok-4', needsKey: true, hint: 'API key from console.x.ai' },
  { id: 'ollama', label: 'Ollama (local)', kind: 'openai' as const, baseUrl: 'http://host.docker.internal:11434/v1', model: '', needsKey: false, hint: 'Runs on your machine. Use http://127.0.0.1:11434/v1 if the server is not in Docker.' },
  { id: 'custom', label: 'Other', kind: 'openai' as const, baseUrl: '', model: '', needsKey: false, hint: 'Any server with an OpenAI-compatible /chat/completions endpoint: LM Studio, OpenRouter, vLLM.' },
];

export function Settings() {
  const { data, conn } = useStore();
  const ref = useEnter<HTMLDivElement>();
  const [form, setForm] = useState<{ preset: string; name: string; kind: Provider['kind']; baseUrl: string; model: string; apiKey: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState({ name: '', value: '' });
  const [push, setPush] = useState(data?.settings.notifyUrl ?? '');
  const [minutes, setMinutes] = useState(String(data?.settings.approvalMinutes ?? 60));
  const missing = [...new Set((data?.tools ?? []).flatMap((t) => t.missing))];
  const preset = PRESETS.find((p) => p.id === form?.preset);

  const pick = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)!;
    setModels([]);
    setForm({ preset: id, name: p.label, kind: p.kind, baseUrl: p.baseUrl, model: p.model, apiKey: '' });
  };
  const findModels = async () => {
    if (!form) return;
    const out = await act(() => api<{ models: string[]; error?: string }>('POST', '/api/providers/models', { baseUrl: form.baseUrl, apiKey: form.apiKey }));
    if (out?.models.length) { setModels(out.models); if (!form.model) setForm({ ...form, model: out.models[0] }); }
    else useStore.getState().toast(out?.error ? `Could not list models: ${out.error}` : 'That server listed no models.', 'bad');
  };
  const test = async (p: Provider) => {
    setTests({ ...tests, [p.id]: 'Testing…' });
    const out = await act(() => api<{ ok: boolean; reply?: string; ms?: number; error?: string }>('POST', `/api/providers/${p.id}/test`));
    setTests((t) => ({ ...t, [p.id]: out?.ok ? `Works. Answered in ${((out.ms ?? 0) / 1000).toFixed(1)}s.` : `Failed: ${out?.error ?? 'no answer'}` }));
  };

  return (
    <div className="view view-narrow" ref={ref}>
      <header className="view-head" data-enter><div><h1>Settings</h1><p className="lede">The AI your shadows think with, the secrets their tools use, and how they reach you.</p></div></header>

      <section className="card stack" data-enter>
        <h2>AI providers</h2>
        <p className="lede">Use a hosted model with an API key, a model running on your own machine, or both. Each shadow can pick its own.</p>
        {data?.providers.length === 0 && <div className="banner banner-ask">No AI is connected yet, so shadows cannot run. Add one below.</div>}
        {data?.providers.map((p) => (
          <div key={p.id} className="provider">
            <div>
              <strong>{p.name}</strong>
              <code>{p.model}</code>
              {data.defaultProvider === p.id && <Chip tone="allow">Default</Chip>}
              {p.kind === 'openai' && <span className="lede"> {p.baseUrl}</span>}
              {tests[p.id] && <p className={tests[p.id].startsWith('Failed') ? 'warn' : 'lede'}>{tests[p.id]}</p>}
            </div>
            <div className="row">
              <Button onClick={() => test(p)}>Test</Button>
              {data.defaultProvider !== p.id && <Button onClick={() => act(() => api('PUT', '/api/settings', { defaultProvider: p.id }), `${p.name} is now the default`)}>Make default</Button>}
              <Button tone="danger" onClick={() => act(() => api('DELETE', `/api/providers/${p.id}`))}>Remove</Button>
            </div>
          </div>
        ))}
        <div className="row">{PRESETS.map((p) => <Button key={p.id} className={form?.preset === p.id ? 'is-on' : ''} onClick={() => pick(p.id)}>Add {p.label}</Button>)}</div>
        {form && (
          <div className="stack sub">
            <p className="lede">{preset?.hint}</p>
            <div className="two">
              <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Model">
                {models.length
                  ? <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>{models.map((m) => <option key={m}>{m}</option>)}</select>
                  : <input className="mono" value={form.model} placeholder="model id" onChange={(e) => setForm({ ...form, model: e.target.value })} />}
              </Field>
            </div>
            {form.kind === 'openai' && (
              <Field label="Base URL"><div className="row"><input className="mono" value={form.baseUrl} placeholder="http://127.0.0.1:11434/v1" onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /><Button onClick={findModels}>Find models</Button></div></Field>
            )}
            <Field label={preset?.needsKey ? 'API key' : 'API key (optional)'} hint="Stored encrypted on your machine. It is never shown again and never sent to a model.">
              <input type="password" value={form.apiKey} autoComplete="off" onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
            </Field>
            <div className="row row-end">
              <Button onClick={() => setForm(null)}>Cancel</Button>
              <Button tone="primary" disabled={!form.name || !form.model || (preset?.needsKey && !form.apiKey)} onClick={async () => { if (await act(() => api('PUT', '/api/providers', form), 'Provider saved')) setForm(null); }}>Save provider</Button>
            </div>
          </div>
        )}
      </section>

      <section className="card stack" data-enter>
        <h2>Secrets</h2>
        <p className="lede">Passwords and API keys that tools need. They are encrypted on disk and write-only: tools can use them, but no agent, model or assistant can read one back.</p>
        {missing.length > 0 && <div className="banner banner-ask">Your tools are waiting for: {missing.join(', ')}</div>}
        <ul className="kv">
          {data?.secrets.filter((s) => !s.name.startsWith('PROVIDER_')).map((s) => (
            <li key={s.name}><code>{s.name}</code><span>••••••••</span><Button tone="danger" onClick={() => act(() => api('DELETE', `/api/secrets/${s.name}`))}>Delete</Button></li>
          ))}
        </ul>
        <div className="param">
          <input className="mono" value={secret.name} placeholder="IMAP_PASS" list="secret-names" onChange={(e) => setSecret({ ...secret, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} />
          <datalist id="secret-names">{missing.map((m) => <option key={m} value={m} />)}</datalist>
          <input type="password" value={secret.value} placeholder="Value" autoComplete="off" onChange={(e) => setSecret({ ...secret, value: e.target.value })} />
          <Button tone="primary" disabled={!secret.name || !secret.value} onClick={async () => { if (await act(() => api('PUT', '/api/secrets', secret), `${secret.name} stored`)) setSecret({ name: '', value: '' }); }}>Store secret</Button>
        </div>
        <p className="lede">For email: IMAP_HOST, IMAP_USER, IMAP_PASS to read; SMTP_HOST, SMTP_USER, SMTP_PASS to send. Gmail and most providers need an app password, not your login password.</p>
      </section>

      <section className="card stack" data-enter>
        <h2>Reaching you</h2>
        <Field label="Phone push (optional)" hint="An ntfy topic URL such as https://ntfy.sh/my-private-topic. Every notification is also posted there.">
          <input className="mono" value={push} placeholder="https://ntfy.sh/…" onChange={(e) => setPush(e.target.value)} />
        </Field>
        <Field label="How long a shadow waits for your approval" hint="After this many minutes an unanswered request expires and the call does not run.">
          <input type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </Field>
        <div className="row row-end"><Button tone="primary" onClick={() => act(() => api('PUT', '/api/settings', { notifyUrl: push, approvalMinutes: Number(minutes) }), 'Saved')}>Save</Button></div>
      </section>

      <section className="card stack" data-enter>
        <h2>This installation</h2>
        <div className="kv-line"><span>Server</span><code>{conn.url}</code></div>
        <div className="kv-line"><span>Data folder</span><code>{conn.home}</code></div>
      </section>
    </div>
  );
}
