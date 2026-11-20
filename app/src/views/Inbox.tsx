import { useStore } from '../store';
import { act, ago, api } from '../api';
import { useEnter } from '../anim';
import { Sprite } from '../components/Sprite';
import { Button, Chip, Empty } from '../components/ui';

const LEVEL = { info: ['plain', 'Info'], success: ['allow', 'Good news'], warning: ['ask', 'Heads up'], urgent: ['deny', 'Urgent'] } as const;

export function Inbox() {
  const { data, set } = useStore();
  const notes = data?.notifications ?? [];
  const ref = useEnter<HTMLDivElement>(notes[0]?.id);
  const unread = notes.filter((n) => !n.read).length;
  return (
    <div className="view view-narrow" ref={ref}>
      <header className="view-head" data-enter>
        <div>
          <h1>Inbox</h1>
          <p className="lede">{notes.length === 0 ? 'What your shadows tell you lands here.' : unread ? `${unread} new` : 'All caught up'}</p>
        </div>
        {notes.length > 0 && (
          <div className="row">
            {unread > 0 && <Button onClick={() => act(() => api('POST', '/api/notifications/read', { id: 'all' }))}>Mark all read</Button>}
            <Button tone="danger" onClick={() => act(() => api('DELETE', '/api/notifications'))}>Clear</Button>
          </div>
        )}
      </header>
      {notes.length === 0 && <Empty title="No messages yet">Shadows use the notify tool to reach you. You also get a desktop notification when one arrives.</Empty>}
      <div className="stack">
        {notes.map((n) => {
          const agent = data?.agents.find((a) => a.id === n.agentId);
          return (
            <article key={n.id} className={`card note ${n.read ? '' : 'is-new'}`} data-enter>
              {agent ? <button type="button" className="note-who" onClick={() => set({ selected: agent.id })}><Sprite sprite={agent.sprite} color={agent.color} size={52} /></button> : <div className="note-who" />}
              <div className="note-body">
                <div className="note-head">
                  <h3>{n.title}</h3>
                  <Chip tone={LEVEL[n.level][0]}>{LEVEL[n.level][1]}</Chip>
                </div>
                {n.body && <p>{n.body}</p>}
                <span className="note-meta">{agent?.name ?? 'A dismissed shadow'} · {ago(n.ts)}</span>
              </div>
              {!n.read && <Button onClick={() => act(() => api('POST', '/api/notifications/read', { id: n.id }))}>Mark read</Button>}
            </article>
          );
        })}
      </div>
    </div>
  );
}
