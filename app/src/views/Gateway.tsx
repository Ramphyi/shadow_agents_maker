import { useEffect, useState } from 'react';
import { agentName, useStore } from '../store';
import { act, ago, api } from '../api';
import { actorLabel, describe } from '../audit';
import { useEnter } from '../anim';
import { Sprite } from '../components/Sprite';
import { Button, Chip, CodeBlock, Copy, Empty, ModeSwitch, RiskChip, Tabs } from '../components/ui';
import type { Approval, AuditEntry, ConnectInfo } from '../types';

export function Gateway() {
  const { data, gatewayTab, set } = useStore();
  const ref = useEnter<HTMLDivElement>(gatewayTab);
  return (
    <div className="view" ref={ref}>
      <header className="view-head" data-enter>
        <div>
          <h1>The Gateway</h1>
          <p className="lede">Every tool call from every shadow passes through here. You decide what is allowed, approve what needs you, and can see everything that happened.</p>
        </div>
      </header>
      <div data-enter>
        <Tabs value={gatewayTab} onChange={(t) => set({ gatewayTab: t })} tabs={[
          { id: 'approvals', label: 'Approvals', count: data?.approvals.length },
          { id: 'permissions', label: 'Permissions' }, { id: 'audit', label: 'Audit log' }, { id: 'connect', label: 'Connect' },
        ]} />
      </div>
      {gatewayTab === 'approvals' && <Approvals />}
      {gatewayTab === 'permissions' && <Matrix />}
      {gatewayTab === 'audit' && <Audit />}
      {gatewayTab === 'connect' && <Connect />}
    </div>
  );
}

export function ApprovalCard({ a }: { a: Approval }) {
  const agent = useStore((s) => s.data?.agents.find((x) => x.id === a.agentId));
  const tool = useStore((s) => s.data?.tools.find((x) => x.name === a.tool));
  const answer = (approve: boolean, always = false) => act(() => api('POST', `/api/approvals/${a.id}`, { approve, always }));
  const who = agent?.name ?? a.actor.replace(/^mcp:/, '') ;
  return (
    <article className="card approval" data-enter>
      <div className="approval-head">
        {agent ? <Sprite sprite={agent.sprite} color={agent.color} state="waiting" size={56} /> : <div className="approval-harness">MCP</div>}
        <div>
          <h3>{who} wants to use <code>{a.tool}</code></h3>
          <p className="lede">{agent ? 'Its run is paused until you answer.' : 'A connected harness is testing this tool directly.'} Asked {ago(a.createdAt)}.</p>
        </div>
        {tool && <RiskChip risk={tool.risk} />}
      </div>
      <dl className="args">
        {Object.entries(a.args).length === 0 && <div><dt>Input</dt><dd>none</dd></div>}
        {Object.entries(a.args).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd></div>)}
      </dl>
      {tool && !tool.reviewed && <p className="warn">This tool was made by a harness and has not been reviewed. Check what it does in Tools before you approve.</p>}
      <div className="row">
        <Button tone="ok" onClick={() => answer(true)}>Approve once</Button>
        {agent && tool?.reviewed && <Button onClick={() => answer(true, true)}>Always allow for {agent.name}</Button>}
        <Button tone="danger" onClick={() => answer(false)}>Reject</Button>
      </div>
    </article>
  );
}

function Approvals() {
  const approvals = useStore((s) => s.data?.approvals) ?? [];
  if (approvals.length === 0) return <Empty title="Nothing is waiting for you">When a shadow reaches for a tool set to Ask, its request shows up here and the shadow waits.</Empty>;
  return <div className="stack">{approvals.map((a) => <ApprovalCard key={a.id} a={a} />)}</div>;
}

function Matrix() {
  const data = useStore((s) => s.data);
  const set = useStore((s) => s.set);
  const agents = data?.agents ?? [];
  if (agents.length === 0) return <Empty title="No shadows to give permissions to" />;
  return (
    <div className="card matrix-wrap" data-enter>
      <table className="matrix">
        <thead>
          <tr>
            <th>Tool</th>
            {agents.map((a) => (
              <th key={a.id}><button type="button" className="matrix-agent" onClick={() => set({ selected: a.id })}><Sprite sprite={a.sprite} color={a.color} state={a.status === 'paused' ? 'paused' : 'idle'} size={40} /><span>{a.name}</span></button></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data?.tools.map((t) => (
            <tr key={t.name}>
              <th scope="row"><code>{t.name}</code><RiskChip risk={t.risk} /></th>
              {agents.map((a) => (
                <td key={a.id}>
                  <ModeSwitch compact value={a.grants.find((g) => g.tool === t.name)?.mode} onChange={(mode) => act(() => api('PUT', '/api/grants', { agentId: a.id, tool: t.name, mode }))} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Audit() {
  const agents = useStore((s) => s.data?.agents) ?? [];
  const live = useStore((s) => s.feed[0]?.id);
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [agent, setAgent] = useState('');
  const [only, setOnly] = useState('');
  const [chain, setChain] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams({ limit: '200', ...(agent ? { agent } : {}), ...(only === 'calls' ? { action: 'tool.call' } : only ? { decision: only } : {}) });
    api<AuditEntry[]>('GET', `/api/audit?${q}`).then(setRows).catch(() => {});
  }, [agent, only, live]);
  const verify = async () => {
    const v = await act(() => api<{ entries: number; brokenAt: number | null }>('GET', '/api/audit/verify'));
    if (v) setChain(v.brokenAt === null ? `Intact: all ${v.entries} entries match their hash chain.` : `Entry #${v.brokenAt} was changed after it was written.`);
  };
  return (
    <div className="stack" data-enter>
      <div className="row row-between">
        <div className="row">
          <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Filter by shadow"><option value="">All shadows</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <select value={only} onChange={(e) => setOnly(e.target.value)} aria-label="Filter by kind">
            <option value="">Everything</option><option value="calls">Tool calls</option><option value="denied">Blocked</option><option value="rejected">Rejected by you</option><option value="approved">Approved by you</option>
          </select>
        </div>
        <div className="row">{chain && <span className="lede">{chain}</span>}<Button onClick={verify}>Verify log integrity</Button></div>
      </div>
      {rows.length === 0 ? <Empty title="No entries match" /> : (
        <div className="card audit">
          {rows.map((e) => {
            const d = describe(e);
            return (
              <details key={e.id}>
                <summary>
                  <time title={new Date(e.ts).toLocaleString()}>{new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                  <span className="audit-text">{d.text}</span>
                  {d.chip && <Chip tone={d.tone}>{d.chip}</Chip>}
                  {e.ms !== null && <span className="audit-ms">{e.ms} ms</span>}
                </summary>
                <pre>{JSON.stringify({ id: e.id, actor: actorLabel(e), action: e.action, agent: e.agentId ? agentName(e.agentId) : undefined, run: e.runId ?? undefined, ...e.detail }, null, 2)}</pre>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Connect() {
  const [info, setInfo] = useState<ConnectInfo | null>(null);
  const [show, setShow] = useState(false);
  const load = () => { api<ConnectInfo>('GET', '/api/connect').then(setInfo).catch(() => {}); };
  useEffect(load, []);
  if (!info) return <p className="lede">Loading…</p>;
  const token = show ? info.mcpToken : `${info.mcpToken.slice(0, 14)}${'•'.repeat(18)}`;
  const rotate = async (which: 'mcp' | 'a2a') => { await act(() => api('POST', '/api/connect/rotate', { which }), 'New token issued. Update your clients.'); load(); };
  return (
    <div className="stack">
      <section className="card stack" data-enter>
        <h2>Let an AI assistant build and manage shadows</h2>
        <p className="lede">
          This server speaks MCP. Connect a client, then ask it in plain words: “make me a shadow that watches my inbox”. It can create, test and inspect agents.
          It cannot approve its own requests or give its agents unattended access: anything that reads or acts outside is stored as <strong>Ask</strong> until you allow it here.
        </p>
        <div className="kv-line"><span>MCP endpoint</span><code>{info.mcpUrl}</code><Copy text={info.mcpUrl} /></div>
        <div className="kv-line"><span>Token</span><code>{token}</code><Button onClick={() => setShow(!show)}>{show ? 'Hide' : 'Reveal'}</Button><Copy text={info.mcpToken} /><Button tone="danger" onClick={() => rotate('mcp')}>Rotate</Button></div>

        <h3 className="section">Claude Code</h3>
        <CodeBlock text={`claude mcp add --transport http shadow-agents ${info.mcpUrl} \\\n  --header "Authorization: Bearer ${token}"`}
          copyText={`claude mcp add --transport http shadow-agents ${info.mcpUrl} --header "Authorization: Bearer ${info.mcpToken}"`} />
        <h3 className="section">Claude Desktop, Cursor and other clients that launch a command</h3>
        <CodeBlock text={JSON.stringify({ mcpServers: { 'shadow-agents': { command: 'node', args: ['/path/to/shadow_agents_maker/server/src/mcp-stdio.ts'] } } }, null, 2)} />
        <p className="lede">The bridge reads the token from your data folder, so there is nothing else to configure. Replace the path with where you cloned the project.</p>
        <h3 className="section">ChatGPT, Grok and other hosted assistants</h3>
        <p className="lede">Hosted assistants connect from the internet, so they need a public HTTPS address. Put a tunnel in front of {info.url} (Cloudflare Tunnel, Tailscale Funnel, ngrok), then add the tunnel address ending in <code>/mcp</code> as a remote MCP server with the token above as a Bearer token. Only do this with the token kept secret: whoever holds it can create agents.</p>
      </section>

      <section className="card stack" data-enter>
        <h2>Agent to agent (A2A)</h2>
        <p className="lede">Shadows with A2A switched on can be discovered and messaged by agents from other frameworks. Turn it on per shadow under Setup.</p>
        <div className="kv-line"><span>A2A token</span><code>{`${info.a2aToken.slice(0, 14)}${'•'.repeat(18)}`}</code><Copy text={info.a2aToken} /><Button tone="danger" onClick={() => rotate('a2a')}>Rotate</Button></div>
        {info.a2aAgents.length === 0 ? <p className="lede">No shadow is exposed yet.</p> : info.a2aAgents.map((a) => (
          <div key={a.url} className="kv-line"><span>{a.name}</span><code>{a.url}</code><Copy text={a.url} /><Copy text={a.card} label="Copy card URL" /></div>
        ))}
      </section>
    </div>
  );
}
