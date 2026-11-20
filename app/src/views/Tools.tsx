import { useState } from 'react';
import { useStore } from '../store';
import { act, api } from '../api';
import { useEnter } from '../anim';
import { Button, Chip, CodeBlock, Field, Modal, RiskChip } from '../components/ui';
import type { JsonSchema, Risk, Tool } from '../types';

interface Param { name: string; type: string; description: string; required: boolean }
interface Draft {
  original: string | null; name: string; kind: 'http' | 'js'; description: string; risk: Risk; params: Param[];
  method: string; url: string; headers: string; body: string; code: string; secrets: string;
}

const emptyDraft = (): Draft => ({
  original: null, name: '', kind: 'http', description: '', risk: 'read', params: [{ name: '', type: 'string', description: '', required: true }],
  method: 'GET', url: '', headers: '', body: '', secrets: '',
  code: '// args holds the inputs, secrets the secrets you listed below.\n// fetch and console.log are available. Return a string or an object.\nconst res = await fetch(`https://api.example.com/items/${args.id}`);\nreturn await res.json();',
});

function toDraft(t: Tool): Draft {
  const c = (t.config ?? {}) as Record<string, unknown>;
  const props = t.inputSchema.properties ?? {};
  return {
    ...emptyDraft(), original: t.name, name: t.name, kind: t.kind === 'js' ? 'js' : 'http', description: t.description, risk: t.risk,
    params: Object.entries(props).map(([name, p]) => ({ name, type: p.type ?? 'string', description: p.description ?? '', required: t.inputSchema.required?.includes(name) ?? false })),
    method: String(c.method ?? 'GET'), url: String(c.url ?? ''), body: String(c.body ?? ''), code: String(c.code ?? ''),
    headers: Object.entries((c.headers as Record<string, string>) ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
    secrets: ((c.secrets as string[]) ?? []).join(', '),
  };
}

function fromDraft(d: Draft) {
  const params = d.params.filter((p) => p.name.trim());
  const inputSchema: JsonSchema = {
    type: 'object',
    properties: Object.fromEntries(params.map((p) => [p.name.trim(), { type: p.type, ...(p.description ? { description: p.description } : {}) }])),
    required: params.filter((p) => p.required).map((p) => p.name.trim()),
  };
  const secrets = d.secrets.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const headers = Object.fromEntries(d.headers.split('\n').map((l) => l.split(/:(.*)/s).map((x) => x.trim())).filter((p) => p[0] && p[1]).map((p) => [p[0], p[1]]));
  const config = d.kind === 'http' ? { method: d.method, url: d.url, headers, body: d.body, secrets } : { code: d.code, secrets };
  return { name: d.name.trim(), kind: d.kind, description: d.description, risk: d.risk, reviewed: true, inputSchema, config };
}

export function Tools() {
  const data = useStore((s) => s.data);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const tools = data?.tools ?? [];
  const custom = tools.filter((t) => t.kind !== 'builtin');
  const ref = useEnter<HTMLDivElement>(tools.length);
  const current = tools.find((t) => t.name === open);

  const card = (t: Tool) => (
    <button key={t.name} type="button" className="card tool" data-enter onClick={() => setOpen(t.name)}>
      <div className="tool-head">
        <code>{t.name}</code>
        <RiskChip risk={t.risk} />
      </div>
      <p>{t.description.split('. ')[0]}.</p>
      <div className="row">
        {t.kind !== 'builtin' && <Chip tone="plain">{t.kind === 'http' ? 'HTTP' : 'JavaScript'}</Chip>}
        {!t.reviewed && <Chip tone="ask">Needs your review</Chip>}
        {t.missing.length > 0 && <Chip tone="ask">Needs {t.missing.length} secret{t.missing.length === 1 ? '' : 's'}</Chip>}
      </div>
    </button>
  );

  return (
    <div className="view" ref={ref}>
      <header className="view-head" data-enter>
        <div>
          <h1>The Armory</h1>
          <p className="lede">Tools are what shadows can do. Build your own from any HTTP API or a few lines of JavaScript, then grant them to agents.</p>
        </div>
        <Button tone="primary" onClick={() => setDraft(emptyDraft())}>Make a tool</Button>
      </header>

      <h2 className="section" data-enter>Your tools</h2>
      {custom.length === 0
        ? <p className="lede" data-enter>None yet. A tool can be a single API call: a weather lookup, a Slack message, a row in your tracker.</p>
        : <div className="grid">{custom.map(card)}</div>}

      <h2 className="section" data-enter>Built in</h2>
      <div className="grid">{tools.filter((t) => t.kind === 'builtin').map(card)}</div>

      {current && <ToolModal tool={current} onClose={() => setOpen(null)} onEdit={() => { setDraft(toDraft(current)); setOpen(null); }} />}
      {draft && <ToolEditor draft={draft} setDraft={setDraft} onClose={() => setDraft(null)} />}
    </div>
  );
}

function ToolModal({ tool, onClose, onEdit }: { tool: Tool; onClose: () => void; onEdit: () => void }) {
  const props = Object.entries(tool.inputSchema.properties ?? {});
  const [args, setArgs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ ok: boolean; output: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setResult(null);
    const typed: Record<string, unknown> = {};
    for (const [name, p] of props) {
      const v = args[name];
      if (v === undefined || v === '') continue;
      typed[name] = p.type === 'integer' || p.type === 'number' ? Number(v) : p.type === 'boolean' ? v === 'true' : p.type === 'object' || p.type === 'array' ? safeParse(v) : v;
    }
    const out = await act(() => api<{ ok: boolean; output: string }>('POST', `/api/tools/${tool.name}/test`, { args: typed }));
    setBusy(false);
    if (out) setResult(out);
  };
  return (
    <Modal title={tool.name} onClose={onClose}>
      <div className="stack">
        <div className="row"><RiskChip risk={tool.risk} />{tool.kind !== 'builtin' && <Chip tone="plain">Made by {tool.createdBy.replace(/^user:.*/, 'you').replace(/^mcp:/, '')}</Chip>}</div>
        <p>{tool.description}</p>
        {tool.missing.length > 0 && <div className="banner banner-ask">Add {tool.missing.join(', ')} in Settings → Secrets before this tool can work.</div>}
        {!tool.reviewed && (
          <div className="banner banner-ask">
            A harness made this tool, so every call asks for your approval. Read what it does below; if you trust it, mark it reviewed.
            <Button tone="ok" onClick={() => act(() => api('POST', '/api/tools', { name: tool.name, kind: tool.kind, description: tool.description, inputSchema: tool.inputSchema, config: tool.config, risk: tool.risk, reviewed: true }), 'Marked as reviewed')}>Mark reviewed</Button>
          </div>
        )}
        {tool.config && <CodeBlock text={tool.kind === 'js' ? String(tool.config.code ?? '') : `${String(tool.config.method ?? 'GET')} ${String(tool.config.url ?? '')}`} copy={false} />}

        <h3 className="section">Try it</h3>
        {props.length === 0 && <p className="lede">This tool takes no input.</p>}
        {props.map(([name, p]) => (
          <Field key={name} label={`${name}${tool.inputSchema.required?.includes(name) ? '' : ' (optional)'}`} hint={p.description}>
            {p.enum
              ? <select value={args[name] ?? ''} onChange={(e) => setArgs({ ...args, [name]: e.target.value })}><option value="">Default</option>{p.enum.map((o) => <option key={o}>{o}</option>)}</select>
              : p.type === 'boolean'
                ? <select value={args[name] ?? ''} onChange={(e) => setArgs({ ...args, [name]: e.target.value })}><option value="">Default</option><option value="true">Yes</option><option value="false">No</option></select>
                : <input value={args[name] ?? ''} onChange={(e) => setArgs({ ...args, [name]: e.target.value })} />}
          </Field>
        ))}
        <div className="row">
          <Button tone="primary" busy={busy} onClick={run}>Run once</Button>
          {tool.kind !== 'builtin' && <Button onClick={onEdit}>Edit</Button>}
          {tool.kind !== 'builtin' && <Button tone="danger" onClick={async () => { await act(() => api('DELETE', `/api/tools/${tool.name}`), 'Tool deleted'); onClose(); }}>Delete</Button>}
        </div>
        {tool.risk === 'act' && <p className="lede">Running this does the real thing. It is not a dry run.</p>}
        {result && <div className={`result ${result.ok ? '' : 'result-bad'}`}><pre>{result.output}</pre></div>}
      </div>
    </Modal>
  );
}

const safeParse = (v: string) => { try { return JSON.parse(v); } catch { return v; } };

function ToolEditor({ draft, setDraft, onClose }: { draft: Draft; setDraft: (d: Draft | null) => void; onClose: () => void }) {
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setParam = (i: number, patch: Partial<Param>) => set({ params: draft.params.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const save = async () => {
    const saved = await act(() => api('POST', '/api/tools', fromDraft(draft)), 'Tool saved');
    if (saved) onClose();
  };
  return (
    <Modal title={draft.original ? `Edit ${draft.original}` : 'Make a tool'} onClose={onClose}>
      <div className="stack">
        <div className="two">
          <Field label="Name" hint="lowercase_with_underscores"><input className="mono" value={draft.name} disabled={!!draft.original} placeholder="weather_lookup" onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></Field>
          <Field label="What can it touch?">
            <select value={draft.risk} onChange={(e) => set({ risk: e.target.value as Risk })}>
              <option value="safe">Nothing outside the agent</option>
              <option value="read">Reads outside data</option>
              <option value="act">Changes something outside</option>
            </select>
          </Field>
        </div>
        <Field label="Description" hint="The agent reads this to decide when to use the tool. Say what it does and what comes back.">
          <textarea rows={2} value={draft.description} placeholder="Look up the current weather for a city. Returns temperature and conditions." onChange={(e) => set({ description: e.target.value })} />
        </Field>

        <div className="field">
          <span className="field-label">Inputs</span>
          {draft.params.map((p, i) => (
            <div key={i} className="param">
              <input className="mono" value={p.name} placeholder="name" onChange={(e) => setParam(i, { name: e.target.value.replace(/[^\w]/g, '_') })} />
              <select value={p.type} onChange={(e) => setParam(i, { type: e.target.value })}>{['string', 'number', 'integer', 'boolean'].map((t) => <option key={t}>{t}</option>)}</select>
              <input value={p.description} placeholder="What it means" onChange={(e) => setParam(i, { description: e.target.value })} />
              <label className="check"><input type="checkbox" checked={p.required} onChange={(e) => setParam(i, { required: e.target.checked })} />Required</label>
              <Button onClick={() => set({ params: draft.params.filter((_, j) => j !== i) })} aria-label="Remove input">Remove</Button>
            </div>
          ))}
          <div><Button onClick={() => set({ params: [...draft.params, { name: '', type: 'string', description: '', required: false }] })}>Add an input</Button></div>
        </div>

        <div className="field">
          <span className="field-label">How does it work?</span>
          <div className="seg">
            <button type="button" className={draft.kind === 'http' ? 'is-on' : ''} onClick={() => set({ kind: 'http' })}>Call an HTTP API</button>
            <button type="button" className={draft.kind === 'js' ? 'is-on' : ''} onClick={() => set({ kind: 'js' })}>Run JavaScript</button>
          </div>
        </div>

        {draft.kind === 'http' ? (
          <>
            <div className="param param-url">
              <select value={draft.method} onChange={(e) => set({ method: e.target.value })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}</select>
              <input className="mono" value={draft.url} placeholder="https://api.example.com/weather?q={{city}}" onChange={(e) => set({ url: e.target.value })} />
            </div>
            <Field label="Headers" hint="One per line. Use {{secret.NAME}} for keys, {{input_name}} for inputs.">
              <textarea className="mono" rows={2} value={draft.headers} placeholder={'Authorization: Bearer {{secret.WEATHER_KEY}}'} onChange={(e) => set({ headers: e.target.value })} />
            </Field>
            {draft.method !== 'GET' && <Field label="Body"><textarea className="mono" rows={3} value={draft.body} placeholder={'{"city": "{{city}}"}'} onChange={(e) => set({ body: e.target.value })} /></Field>}
          </>
        ) : (
          <Field label="Code" hint="The body of an async function (args, secrets). It runs in its own thread with a 20 second limit.">
            <textarea className="mono" rows={9} spellCheck={false} value={draft.code} onChange={(e) => set({ code: e.target.value })} />
          </Field>
        )}
        <Field label="Secrets it may read" hint="Comma-separated names from Settings → Secrets. A tool can only read the secrets listed here.">
          <input className="mono" value={draft.secrets} placeholder="WEATHER_KEY" onChange={(e) => set({ secrets: e.target.value })} />
        </Field>
        <div className="row row-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" disabled={!draft.name || !draft.description.trim()} onClick={save}>Save tool</Button>
        </div>
      </div>
    </Modal>
  );
}
