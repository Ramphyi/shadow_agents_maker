import { useState } from 'react';
import { useStore } from '../store';
import { act, api, cronWords } from '../api';
import { useEnter } from '../anim';
import { Sprite } from '../components/Sprite';
import { Button, Field } from '../components/ui';
import { FunctionForm, LookPicker, ToolGrants } from '../components/editors';
import type { Agent, AgentSpec, Mode, Template } from '../types';

const blank = (): AgentSpec => ({ name: '', sprite: 'wisp', color: '#8b7bff', role: '', instructions: '', functions: [], tools: ['notify', 'memory_get', 'memory_set'] });
const EXAMPLES = [
  'Check my inbox every 10 minutes and ping me when a real person needs a reply',
  'Every morning at 8, read Hacker News and send me the 5 stories worth my time',
  'Watch our status page every 15 minutes and tell me the moment it changes',
];

export function Forge() {
  const { data, go } = useStore();
  const [spec, setSpec] = useState<AgentSpec | null>(null);
  const [description, setDescription] = useState('');
  const [drafting, setDrafting] = useState(false);
  const ref = useEnter<HTMLDivElement>(spec ? 'edit' : 'pick');
  const hasAi = (data?.providers.length ?? 0) > 0;

  const draft = async () => {
    setDrafting(true);
    const out = await act(() => api<AgentSpec>('POST', '/api/forge/draft', { description }));
    setDrafting(false);
    if (out) setSpec({ ...blank(), ...out });
  };
  const fromTemplate = (t: Template) => {
    const { id: _id, tagline: _tagline, ...rest } = t;
    const taken = new Set(data?.agents.map((a) => a.name.toLowerCase()));
    let name = rest.name; let n = 2;
    while (taken.has(name.toLowerCase())) name = `${rest.name} ${n++}`;
    setSpec({ ...rest, name });
  };

  if (spec) return <div ref={ref}><Editor spec={spec} setSpec={setSpec} onBack={() => setSpec(null)} /></div>;

  return (
    <div className="view" ref={ref}>
      <header className="view-head" data-enter>
        <div>
          <h1>The Forge</h1>
          <p className="lede">Make a new shadow. Describe it in your own words, start from a template, or build it by hand.</p>
        </div>
      </header>

      <section className="card forge-describe" data-enter>
        <h2>Describe what you want</h2>
        <textarea rows={3} value={description} placeholder="What should this shadow do for you, and how often?" onChange={(e) => setDescription(e.target.value)} />
        <div className="examples">
          {EXAMPLES.map((ex) => <button key={ex} type="button" onClick={() => setDescription(ex)}>{ex}</button>)}
        </div>
        <div className="row row-between">
          <p className="lede">{hasAi ? 'Your AI drafts the role, instructions, jobs and tools. You review everything before it goes live.' : 'Add an AI provider in Settings to use this.'}</p>
          <div className="row">
            {drafting && <Sprite sprite="mage" color="#8b7bff" state="working" size={44} />}
            <Button tone="primary" busy={drafting} disabled={!description.trim() || !hasAi} onClick={draft}>{drafting ? 'Drafting…' : 'Draft it'}</Button>
          </div>
        </div>
      </section>

      <h2 className="section" data-enter>Or start from a template</h2>
      <div className="grid">
        {data?.templates.map((t) => (
          <button key={t.id} type="button" className="card template" data-enter onClick={() => fromTemplate(t)}>
            <Sprite sprite={t.sprite} color={t.color} size={72} />
            <div>
              <h3>{t.name}</h3>
              <p>{t.tagline}</p>
              <span className="template-meta">{t.functions[0] ? cronWords(t.functions[0].cron) : 'You talk to it'} · {t.tools.length} tools</span>
            </div>
          </button>
        ))}
        <button type="button" className="card template" data-enter onClick={() => setSpec(blank())}>
          <Sprite sprite="wisp" color="#6f7598" size={72} />
          <div>
            <h3>Blank shadow</h3>
            <p>Start with nothing and set every detail yourself.</p>
            <span className="template-meta">From scratch</span>
          </div>
        </button>
      </div>

      <section className="card forge-harness" data-enter>
        <div>
          <h2>Or let your coding assistant build it</h2>
          <p className="lede">Connect Claude, Grok, ChatGPT or any MCP client, then say “make me a shadow that…”. It creates and tests the agent here; you keep control of what it is allowed to do.</p>
        </div>
        <Button onClick={() => go('gateway', { gatewayTab: 'connect' })}>Show me how to connect</Button>
      </section>
    </div>
  );
}

function Editor({ spec, setSpec, onBack }: { spec: AgentSpec; setSpec: (s: AgentSpec) => void; onBack: () => void }) {
  const { data, go } = useStore();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const modes: Record<string, Mode> = {};
  for (const t of spec.tools) {
    const name = typeof t === 'string' ? t : t.name;
    const tool = data?.tools.find((x) => x.name === name);
    modes[name] = typeof t === 'string' ? (tool?.risk === 'act' ? 'ask' : 'allow') : t.mode;
  }
  const setMode = (tool: string, mode: Mode | null) => {
    const rest = spec.tools.filter((t) => (typeof t === 'string' ? t : t.name) !== tool);
    setSpec({ ...spec, tools: mode ? [...rest, { name: tool, mode }] : rest });
  };
  const summon = async () => {
    setBusy(true);
    const tools = Object.entries(modes).map(([name, mode]) => ({ name, mode }));
    const made = await act(() => api<Agent>('POST', '/api/agents', { ...spec, tools }), `${spec.name} has joined your realm`);
    setBusy(false);
    if (made) go('realm', { selected: made.id });
  };

  return (
    <div className="view editor">
      <header className="view-head" data-enter>
        <div>
          <h1>{spec.name || 'New shadow'}</h1>
          <p className="lede">Review each part. Nothing runs until you summon it.</p>
        </div>
        <div className="row">
          <Button onClick={onBack}>Back</Button>
          <Button tone="primary" busy={busy} disabled={!spec.name.trim()} onClick={summon}>Summon</Button>
        </div>
      </header>

      <div className="editor-grid">
        <aside className="card editor-preview" data-enter style={{ '--glow': spec.color } as React.CSSProperties}>
          <Sprite sprite={spec.sprite} color={spec.color} size={176} />
          <h2>{spec.name || 'Unnamed'}</h2>
          <p>{spec.role || 'No role yet'}</p>
          <LookPicker sprite={spec.sprite} color={spec.color} onChange={(p) => setSpec({ ...spec, ...p })} />
        </aside>

        <div className="stack">
          <section className="card stack" data-enter>
            <h2>Who is it?</h2>
            <Field label="Name"><input value={spec.name} placeholder="Mail Sentinel" autoFocus onChange={(e) => setSpec({ ...spec, name: e.target.value })} /></Field>
            <Field label="Role" hint="One sentence on what it is responsible for."><input value={spec.role} placeholder="Watches my inbox and tells me about mail that needs me." onChange={(e) => setSpec({ ...spec, role: e.target.value })} /></Field>
            <Field label="Standing instructions" hint="It reads these on every run. Say what matters to you, what to ignore, and how its messages should read.">
              <textarea rows={6} value={spec.instructions} onChange={(e) => setSpec({ ...spec, instructions: e.target.value })} />
            </Field>
          </section>

          <section className="card stack" data-enter>
            <h2>Jobs</h2>
            <p className="lede">What wakes it up. Leave this empty for a shadow you only talk to.</p>
            {spec.functions.map((f, i) => (
              <div key={i} className="job-mini">
                <div>
                  <strong>{f.name}</strong>
                  <span>{f.kind === 'schedule' ? cronWords(f.cron) : f.kind === 'webhook' ? 'On a webhook' : 'When you run it'}</span>
                  <p>{f.prompt}</p>
                </div>
                <Button onClick={() => setSpec({ ...spec, functions: spec.functions.filter((_, j) => j !== i) })}>Remove</Button>
              </div>
            ))}
            {adding
              ? <FunctionForm onCancel={() => setAdding(false)} onSave={(f) => { setSpec({ ...spec, functions: [...spec.functions, f] }); setAdding(false); }} />
              : <div><Button onClick={() => setAdding(true)}>Add a job</Button></div>}
          </section>

          <section className="card stack" data-enter>
            <h2>Tools and permissions</h2>
            <p className="lede">Give it only what the job needs. You can change this any time in the Gateway.</p>
            <ToolGrants tools={data?.tools ?? []} modes={modes} onChange={setMode} />
          </section>
        </div>
      </div>
    </div>
  );
}
