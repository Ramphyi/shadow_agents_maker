import { useEffect, useRef, useState } from 'react';
import { animate } from 'animejs';
import { useStore, type View } from './store';
import { connect } from './api';
import { pulse } from './anim';
import { Sprite } from './components/Sprite';
import { Button, CodeBlock, Field } from './components/ui';
import { Realm } from './views/Realm';
import { Forge } from './views/Forge';
import { Tools } from './views/Tools';
import { Gateway, ApprovalCard } from './views/Gateway';
import { Inbox } from './views/Inbox';
import { Settings } from './views/Settings';
import { AgentPanel } from './views/AgentPanel';

const NAV: { id: View; label: string; hint: string }[] = [
  { id: 'realm', label: 'Realm', hint: 'Your shadows, live' },
  { id: 'forge', label: 'Forge', hint: 'Make a shadow' },
  { id: 'tools', label: 'Armory', hint: 'Tools' },
  { id: 'gateway', label: 'Gateway', hint: 'Permissions and audit' },
  { id: 'inbox', label: 'Inbox', hint: 'Messages for you' },
  { id: 'settings', label: 'Settings', hint: 'AI, secrets' },
];

function Offline() {
  const { status, conn, set } = useStore();
  const [url, setUrl] = useState(conn.url);
  const [token, setToken] = useState(conn.token);
  return (
    <div className="offline">
      <Sprite sprite="wisp" color="#8b7bff" state={status === 'connecting' ? 'working' : 'paused'} size={144} />
      {status === 'connecting' ? <h1>Waking the realm…</h1> : (
        <>
          <h1>{status === 'unauthorized' ? 'The server did not accept the token' : 'The Shadow Agent server is not running'}</h1>
          <p className="lede">Shadows live in a small server that keeps working when this window is closed. Start it, and this screen connects by itself.</p>
          <div className="offline-steps">
            <div><h3>With Docker</h3><CodeBlock text="docker compose up -d" /></div>
            <div><h3>Without Docker</h3><CodeBlock text="npm run server" /></div>
          </div>
          {!window.shadow && (
            <div className="card stack offline-manual">
              <Field label="Server URL"><input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
              <Field label="Admin token" hint="The contents of admin.token in the data folder."><input type="password" value={token} onChange={(e) => setToken(e.target.value)} /></Field>
              <Button tone="primary" onClick={() => { const c = { ...conn, url: url.replace(/\/+$/, ''), token }; localStorage.setItem('shadow-conn', JSON.stringify(c)); set({ conn: c, status: 'connecting' }); void connect(); }}>Connect</Button>
            </div>
          )}
          <p className="lede">Looking for {conn.url} · retrying every few seconds</p>
        </>
      )}
    </div>
  );
}

export function App() {
  const { status, data, view, selected, toasts, go } = useStore();
  const marker = useRef<HTMLSpanElement>(null);
  const nav = useRef<HTMLElement>(null);
  const badge = useRef<HTMLSpanElement>(null);
  const approvals = data?.approvals ?? [];
  const unread = data?.notifications.filter((n) => !n.read).length ?? 0;
  const agent = data?.agents.find((a) => a.id === selected);

  useEffect(() => { void connect(); }, []);

  // The glowing marker glides to the active nav item.
  useEffect(() => {
    const el = nav.current?.querySelector<HTMLElement>(`[data-nav="${view}"]`);
    if (!el || !marker.current) return;
    animate(marker.current, { y: el.offsetTop, height: el.offsetHeight, duration: 420, ease: 'outExpo' });
  }, [view, status]);
  useEffect(() => { if (approvals.length) pulse(badge.current); }, [approvals.length]);

  if (status !== 'online' && !data) return <Offline />;

  const count = (id: View) => (id === 'gateway' ? approvals.length : id === 'inbox' ? unread : id === 'realm' ? data?.agents.length ?? 0 : 0);
  const first = approvals[0];

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <Sprite sprite="wisp" color="#8b7bff" size={40} />
          <div><strong>Shadow</strong><span>Agents</span></div>
        </div>
        <nav ref={nav} aria-label="Sections">
          <span className="nav-marker" ref={marker} />
          {NAV.map((n) => (
            <button key={n.id} type="button" data-nav={n.id} className={`nav ${view === n.id ? 'is-on' : ''}`} aria-current={view === n.id ? 'page' : undefined} onClick={() => go(n.id)}>
              <span className="nav-label">{n.label}</span>
              <span className="nav-hint">{n.hint}</span>
              {count(n.id) > 0 && <span ref={n.id === 'gateway' ? badge : undefined} className={`count ${n.id === 'gateway' ? 'count-ask' : n.id === 'inbox' ? 'count-new' : ''}`}>{count(n.id)}</span>}
            </button>
          ))}
        </nav>
        <div className={`conn conn-${status}`}>
          <span className="dot" />
          {status === 'online' ? 'Server running' : 'Reconnecting…'}
        </div>
      </aside>

      <main className="main">
        <div className="drag" />
        {view === 'realm' && <Realm />}
        {view === 'forge' && <Forge />}
        {view === 'tools' && <Tools />}
        {view === 'gateway' && <Gateway />}
        {view === 'inbox' && <Inbox />}
        {view === 'settings' && <Settings />}
      </main>

      {agent && <AgentPanel key={agent.id} agent={agent} />}

      {first && view !== 'gateway' && (
        <div className="ask-dock">
          <ApprovalCard key={first.id} a={first} />
          {approvals.length > 1 && <button type="button" className="ask-more" onClick={() => go('gateway', { gatewayTab: 'approvals' })}>and {approvals.length - 1} more waiting</button>}
        </div>
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.tone}`}>{t.text}</div>)}
      </div>
    </div>
  );
}
