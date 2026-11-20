import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { act, ago, api, cronWords, until } from '../api';
import { popIn } from '../anim';
import { Sprite } from '../components/Sprite';
import { Button, Chip, Copy, Drawer, Empty, Field, Tabs, Toggle } from '../components/ui';
import { FunctionForm, LookPicker, ToolGrants } from '../components/editors';
import type { Agent, ChatMessage, Fn, Mode, Run } from '../types';

type Tab = 'talk' | 'jobs' | 'permissions' | 'activity' | 'setup';
const STATE_TEXT = { idle: 'Idle', working: 'Working', waiting: 'Waiting for your approval', error: 'Hit a problem', paused: 'Paused' };

export function AgentPanel({ agent }: { agent: Agent }) {
  const { set, data } = useStore();
  const [tab, setTab] = useState<Tab>('talk');
  const [detail, setDetail] = useState<{ runs: Run[]; memory: { key: string; value: string; updatedAt: number }[] } | null>(null);
  const hero = useRef<HTMLDivElement>(null);
  const state = agent.status === 'paused' ? 'paused' : agent.state;

  useEffect(() => { popIn(hero.current); }, [agent.id]);
  useEffect(() => {
    let live = true;
    api<{ messages: ChatMessage[]; runs: Run[]; memory: { key: string; value: string; updatedAt: number }[] }>('GET', `/api/agents/${agent.id}/detail`).then((d) => {
      if (!live) return;
      setDetail({ runs: d.runs, memory: d.memory });
      useStore.getState().set({ chat: { ...useStore.getState().chat, [agent.id]: d.messages } });
    }).catch(() => {});
    return () => { live = false; };
    // Reload when the agent finishes something, so runs and memory stay current.
  }, [agent.id, agent.lastRun?.id, agent.lastRun?.status]);

  const pending = data?.approvals.filter((a) => a.agentId === agent.id).length ?? 0;

  return (
    <Drawer onClose={() => set({ selected: null })} wide>
      <header className="panel-head">
        <div className="panel-hero" ref={hero} style={{ '--glow': agent.color } as React.CSSProperties}>
          <Sprite sprite={agent.sprite} color={agent.color} state={state} size={112} />
        </div>
        <div className="panel-title">
          <h2>{agent.name}</h2>
          <p>{agent.role || 'No role set yet.'}</p>
          <div className="row">
            <Chip tone={`state-${state}`}>{STATE_TEXT[state]}</Chip>
            {agent.a2a && <Chip tone="read">A2A</Chip>}
            {agent.createdBy.startsWith('mcp:') && <Chip tone="plain">Made by {agent.createdBy.slice(4)}</Chip>}
          </div>
        </div>
        <div className="panel-actions">
          <Button onClick={() => act(() => api('PATCH', `/api/agents/${agent.id}`, { status: agent.status === 'paused' ? 'active' : 'paused' }))}>
            {agent.status === 'paused' ? 'Wake up' : 'Pause'}
          </Button>
          <Button onClick={() => set({ selected: null })}>Close</Button>
        </div>
      </header>

      {pending > 0 && (
        <button type="button" className="banner banner-ask" onClick={() => useStore.getState().go('gateway', { gatewayTab: 'approvals' })}>
          {agent.name} is waiting for your approval on {pending} tool call{pending === 1 ? '' : 's'}. Review
        </button>
      )}
      {agent.state === 'error' && agent.lastRun?.error && <div className="banner banner-bad">Last run failed: {agent.lastRun.error}</div>}

      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: 'talk', label: 'Talk' }, { id: 'jobs', label: 'Jobs', count: agent.functions.length },
        { id: 'permissions', label: 'Permissions', count: agent.grants.filter((g) => g.mode !== 'deny').length },
        { id: 'activity', label: 'Activity' }, { id: 'setup', label: 'Setup' },
      ]} />

      <div className="panel-body">
        {tab === 'talk' && <Talk agent={agent} />}
        {tab === 'jobs' && <Jobs agent={agent} />}
        {tab === 'permissions' && <Permissions agent={agent} />}
        {tab === 'activity' && <Activity agent={agent} detail={detail} onChange={() => setDetail(null)} />}
        {tab === 'setup' && <Setup agent={agent} />}
      </div>
    </Drawer>
  );
}

function Talk({ agent }: { agent: Agent }) {
  const messages = useStore((s) => s.chat[agent.id]) ?? [];
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages.length, busy]);

  const send = async () => {
    const message = text.trim();
    if (!message || busy) return;
    setText(''); setBusy(true);
    const out = await act(() => api<{ run: Run }>('POST', `/api/agents/${agent.id}/chat`, { message }));
    if (out?.run.status === 'failed') useStore.getState().toast(out.run.error ?? 'The run failed.', 'bad');
    setBusy(false);
  };

  return (
    <div className="talk">
      <div className="talk-list">
        {messages.length === 0 && !busy && (
          <Empty title={`Say something to ${agent.name}`}>Ask what it has seen, give it a one-off task, or tell it to change how it works. It answers using the tools you granted.</Empty>
        )}
        {messages.map((m) => <div key={m.id} className={`bubble bubble-${m.role}`}>{m.content}</div>)}
        {busy && (
          <div className="bubble bubble-assistant bubble-busy">
            {agent.state === 'waiting' ? 'Waiting for your approval…' : 'Working…'}
          </div>
        )}
        <div ref={end} />
      </div>
      <form className="talk-input" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea rows={2} value={text} placeholder={`Message ${agent.name}`} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <Button tone="primary" busy={busy} disabled={!text.trim()} onClick={send}>Send</Button>
      </form>
    </div>
  );
}

function Jobs({ agent }: { agent: Agent }) {
  const conn = useStore((s) => s.conn);
  const [adding, setAdding] = useState(agent.functions.length === 0);
  const [editing, setEditing] = useState<string | null>(null);
  const kindText = (f: Fn) => (f.kind === 'schedule' ? cronWords(f.cron) : f.kind === 'webhook' ? 'On a webhook' : 'When you run it');
  return (
    <div className="stack">
      <p className="lede">Jobs are what wake {agent.name} up. One shadow can have several.</p>
      {agent.functions.map((f) => editing === f.id ? (
        <div key={f.id} className="card">
          <FunctionForm initial={f} saveLabel="Save" onCancel={() => setEditing(null)}
            onSave={async (spec) => { if (await act(() => api('PATCH', `/api/functions/${f.id}`, spec), 'Saved')) setEditing(null); }} />
        </div>
      ) : (
        <div key={f.id} className={`card job ${f.enabled ? '' : 'is-off'}`}>
          <div className="job-head">
            <div>
              <h3>{f.name}</h3>
              <p className="job-when">
                {kindText(f)}
                {f.kind === 'schedule' && f.enabled && agent.status === 'active' && f.nextRun ? ` · next ${until(f.nextRun)}` : ''}
                {` · last ran ${ago(f.lastRun)}`}
              </p>
            </div>
            <Toggle checked={f.enabled} label={`${f.name} enabled`} onChange={(enabled) => act(() => api('PATCH', `/api/functions/${f.id}`, { enabled }))} />
          </div>
          <p className="job-prompt">{f.prompt}</p>
          {f.hookUrl && (
            <div className="hook">
              <code>POST {conn.url}{f.hookUrl}</code>
              <Copy text={`${conn.url}${f.hookUrl}`} label="Copy URL" />
            </div>
          )}
          <div className="row">
            <Button onClick={() => act(() => api('POST', `/api/functions/${f.id}/run`), `${f.name} started`)}>Run now</Button>
            <Button onClick={() => setEditing(f.id)}>Edit</Button>
            <Button tone="danger" onClick={() => act(() => api('DELETE', `/api/functions/${f.id}`))}>Delete</Button>
          </div>
        </div>
      ))}
      {adding ? (
        <div className="card">
          <FunctionForm onCancel={agent.functions.length ? () => setAdding(false) : undefined}
            onSave={async (spec) => { if (await act(() => api('POST', `/api/agents/${agent.id}/functions`, spec), 'Job added')) setAdding(false); }} />
        </div>
      ) : <Button onClick={() => setAdding(true)}>Add a job</Button>}
    </div>
  );
}

function Permissions({ agent }: { agent: Agent }) {
  const tools = useStore((s) => s.data?.tools) ?? [];
  const modes = Object.fromEntries(agent.grants.map((g) => [g.tool, g.mode])) as Record<string, Mode>;
  return (
    <div className="stack">
      <p className="lede">
        What {agent.name} may use. <strong>Ask</strong> pauses the call until you approve it. <strong>Allow</strong> lets it run on its own.
      </p>
      <ToolGrants tools={tools} modes={modes} onChange={(tool, mode) => act(() => api('PUT', '/api/grants', { agentId: agent.id, tool, mode }))} />
    </div>
  );
}

function Activity({ agent, detail, onChange }: { agent: Agent; detail: { runs: Run[]; memory: { key: string; value: string; updatedAt: number }[] } | null; onChange: () => void }) {
  if (!detail) return <p className="lede">Loading…</p>;
  return (
    <div className="stack">
      <h3 className="section">Memory</h3>
      {detail.memory.length === 0 ? <p className="lede">{agent.name} has not saved anything yet.</p> : (
        <ul className="kv">
          {detail.memory.map((m) => (
            <li key={m.key}>
              <code>{m.key}</code>
              <span>{m.value}</span>
              <Button onClick={async () => { await act(() => api('DELETE', `/api/agents/${agent.id}/memory/${encodeURIComponent(m.key)}`)); onChange(); }}>Forget</Button>
            </li>
          ))}
        </ul>
      )}
      <h3 className="section">Recent runs</h3>
      {detail.runs.length === 0 && <p className="lede">No runs yet.</p>}
      {detail.runs.map((r) => (
        <details key={r.id} className="run">
          <summary>
            <Chip tone={r.status === 'completed' ? 'allow' : r.status === 'failed' ? 'deny' : 'ask'}>{r.status === 'completed' ? 'Done' : r.status === 'failed' ? 'Failed' : 'Running'}</Chip>
            <span className="run-title">{(r.error ?? r.output ?? r.input).slice(0, 90)}</span>
            <span className="run-meta">{r.trigger} · {ago(r.startedAt)}</span>
          </summary>
          <dl>
            <dt>Asked</dt><dd>{r.input}</dd>
            <dt>{r.error ? 'Error' : 'Answer'}</dt><dd>{r.error ?? r.output ?? '…'}</dd>
            <dt>Cost</dt><dd>{r.steps} steps · {(r.tokensIn + r.tokensOut).toLocaleString()} tokens · {r.endedAt ? `${((r.endedAt - r.startedAt) / 1000).toFixed(1)}s` : 'running'}</dd>
          </dl>
        </details>
      ))}
    </div>
  );
}

function Setup({ agent }: { agent: Agent }) {
  const { data, conn, set } = useStore();
  const [draft, setDraft] = useState({ name: agent.name, role: agent.role, instructions: agent.instructions });
  const [confirm, setConfirm] = useState(false);
  const dirty = draft.name !== agent.name || draft.role !== agent.role || draft.instructions !== agent.instructions;
  const patch = (body: Record<string, unknown>, done?: string) => act(() => api('PATCH', `/api/agents/${agent.id}`, body), done);
  return (
    <div className="stack">
      <Field label="Name"><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
      <Field label="Role" hint="One sentence. Other shadows and outside agents see this."><input value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} /></Field>
      <Field label="Standing instructions" hint="Read on every run. What matters, what to ignore, how to write to you.">
        <textarea rows={8} value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} />
      </Field>
      {dirty && <div className="row row-end"><Button onClick={() => setDraft({ name: agent.name, role: agent.role, instructions: agent.instructions })}>Discard</Button><Button tone="primary" onClick={() => patch(draft, 'Saved')}>Save changes</Button></div>}

      <h3 className="section">Look</h3>
      <LookPicker sprite={agent.sprite} color={agent.color} onChange={(p) => patch(p)} />

      <h3 className="section">Brain</h3>
      <Field label="AI provider" hint="Leave on the default unless this shadow needs a different model.">
        <select value={agent.providerId ?? ''} onChange={(e) => {
          const p = data?.providers.find((x) => x.id === e.target.value);
          void patch({ providerId: p?.id ?? null, model: p?.model ?? null });
        }}>
          <option value="">Default ({data?.providers.find((p) => p.id === data.defaultProvider)?.name ?? 'none configured'})</option>
          {data?.providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
        </select>
      </Field>

      <h3 className="section">Reachable by other agents</h3>
      <div className="card row row-between">
        <div>
          <strong>A2A endpoint</strong>
          <p className="lede">Lets agents on other machines and frameworks message {agent.name}. They need the A2A token from Gateway.</p>
          {agent.a2a && <code className="wrap">{conn.url}/a2a/{agent.slug}</code>}
        </div>
        <Toggle checked={agent.a2a} label="A2A endpoint" onChange={(a2a) => patch({ a2a })} />
      </div>

      <h3 className="section">Danger</h3>
      <div className="row">
        <Button onClick={() => act(() => api('DELETE', `/api/agents/${agent.id}/messages`), 'Conversation cleared')}>Clear conversation</Button>
        {confirm
          ? <><Button tone="danger" onClick={async () => { await act(() => api('DELETE', `/api/agents/${agent.id}`), `${agent.name} dismissed`); set({ selected: null }); }}>Yes, dismiss {agent.name} for good</Button><Button onClick={() => setConfirm(false)}>Keep</Button></>
          : <Button tone="danger" onClick={() => setConfirm(true)}>Dismiss this shadow</Button>}
      </div>
    </div>
  );
}
