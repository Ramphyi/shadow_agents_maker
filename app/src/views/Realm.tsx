import { useEffect, useMemo, useRef, useState } from 'react';
import { RealmStage, type RealmAgent } from '../sprites/engine';
import { useStore } from '../store';
import { ago, until } from '../api';
import { describe } from '../audit';
import { useEnter } from '../anim';
import { Button, Chip, Empty } from '../components/ui';
import type { Agent, AuditEntry } from '../types';

function detailFor(a: Agent): string {
  const next = a.functions.filter((f) => f.enabled && f.nextRun).map((f) => f.nextRun!).sort((x, y) => x - y)[0];
  return next ? `Next run ${until(next)}` : 'On call';
}

/** The Pulse shows what shadows did and who changed them, not every setting saved along the way. */
const QUIET = new Set(['permission.set', 'function.add', 'function.update', 'function.remove', 'agent.update', 'secret.set', 'secret.delete', 'provider.save']);
const noteworthy = (e: AuditEntry) => !QUIET.has(e.action) || (e.action === 'permission.set' && (e.detail.via === 'approval' || !!e.detail.requested));

export function Realm() {
  const { data, feed, selected, set, go } = useStore();
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<RealmStage | null>(null);
  const [tick, setTick] = useState(0);
  const agents = data?.agents ?? [];
  const ref = useEnter<HTMLDivElement>(agents.length === 0);

  useEffect(() => {
    if (!host.current) return;
    const s = new RealmStage(host.current, (id) => useStore.getState().set({ selected: id }));
    stage.current = s;
    return () => { s.dispose(); stage.current = null; };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000); // keeps "next run in 4m" honest
    return () => clearInterval(t);
  }, []);

  const realm: RealmAgent[] = useMemo(() => agents.map((a) => ({
    id: a.id, name: a.name, sprite: a.sprite, color: a.color,
    state: a.status === 'paused' ? 'paused' : a.state, detail: detailFor(a),
  })), [agents, tick]);
  useEffect(() => { stage.current?.setAgents(realm); }, [realm]);
  useEffect(() => { stage.current?.setSelected(selected); }, [selected]);

  const working = agents.filter((a) => a.state === 'working').length;
  const waiting = data?.approvals.length ?? 0;
  const summary = agents.length === 0 ? 'Nobody here yet'
    : [`${agents.length} ${agents.length === 1 ? 'shadow' : 'shadows'}`, working ? `${working} working` : waiting ? '' : 'all quiet', waiting ? `${waiting} waiting on you` : ''].filter(Boolean).join(' · ');

  return (
    <div className="realm" ref={ref}>
      <section className="realm-main">
        <header className="view-head realm-head">
          <div>
            <h1>The Realm</h1>
            <p className="lede">{summary}</p>
          </div>
          <div className="row">
            {waiting > 0 && <Button tone="ok" onClick={() => go('gateway', { gatewayTab: 'approvals' })}>Review {waiting} request{waiting === 1 ? '' : 's'}</Button>}
            <Button tone="primary" onClick={() => go('forge')}>Summon a shadow</Button>
          </div>
        </header>
        <div className="realm-stage" ref={host}>
          {agents.length === 0 && (
            <Empty title="Your realm is empty" action={<Button tone="primary" onClick={() => go('forge')}>Summon your first shadow</Button>}>
              A shadow is a small agent that keeps working while you do something else: watching your inbox, checking a site, writing your morning briefing.
            </Empty>
          )}
        </div>
      </section>

      <aside className="pulse">
        <h2>Pulse</h2>
        <p className="lede">Everything your shadows do, as it happens.</p>
        <ol className="pulse-list">
          {feed.filter(noteworthy).length === 0 && <li className="pulse-empty">Nothing has happened yet.</li>}
          {feed.filter(noteworthy).slice(0, 40).map((e) => {
            const d = describe(e);
            return (
              <li key={e.id} className="pulse-item">
                <button type="button" onClick={() => (e.agentId && agents.some((a) => a.id === e.agentId) ? set({ selected: e.agentId }) : go('gateway', { gatewayTab: 'audit' }))}>
                  <span className="pulse-text">{d.text}</span>
                  <span className="pulse-meta">
                    {d.chip && <Chip tone={d.tone}>{d.chip}</Chip>}
                    <time>{ago(e.ts)}</time>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </aside>
    </div>
  );
}
