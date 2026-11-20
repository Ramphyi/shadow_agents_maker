import { useState } from 'react';
import { SPRITE_INFO, type SpriteId } from '../sprites/models';
import { useStore } from '../store';
import { cronWords } from '../api';
import { Sprite } from './Sprite';
import { Button, Field, ModeSwitch, RiskChip } from './ui';
import type { Fn, FnSpec, Mode, Tool } from '../types';

export function LookPicker({ sprite, color, onChange }: { sprite: SpriteId; color: string; onChange: (p: { sprite?: SpriteId; color?: string }) => void }) {
  const data = useStore((s) => s.data);
  return (
    <div className="look">
      <div className="look-sprites" role="radiogroup" aria-label="Sprite">
        {(data?.sprites ?? []).map((id) => (
          <button key={id} type="button" role="radio" aria-checked={sprite === id} title={SPRITE_INFO[id].hint}
            className={`look-sprite ${sprite === id ? 'is-on' : ''}`} onClick={() => onChange({ sprite: id })}>
            <Sprite sprite={id} color={color} size={56} />
            <span>{SPRITE_INFO[id].label}</span>
          </button>
        ))}
      </div>
      <div className="look-colors" role="radiogroup" aria-label="Color">
        {(data?.colors ?? []).map((c) => (
          <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c}
            className={`swatch ${color === c ? 'is-on' : ''}`} style={{ background: c }} onClick={() => onChange({ color: c })} />
        ))}
      </div>
    </div>
  );
}

const PRESETS = [
  { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 08:00', cron: '0 8 * * *' },
  { label: 'Weekdays at 08:00', cron: '0 8 * * 1-5' },
];
const KINDS: { id: Fn['kind']; label: string; hint: string }[] = [
  { id: 'schedule', label: 'On a schedule', hint: 'Wakes up by itself.' },
  { id: 'webhook', label: 'On a webhook', hint: 'Wakes up when another system calls its URL.' },
  { id: 'manual', label: 'When I run it', hint: 'Only when you press Run.' },
];

export function FunctionForm({ initial, onSave, onCancel, saveLabel = 'Add function' }: {
  initial?: FnSpec; onSave: (f: FnSpec) => void | Promise<void>; onCancel?: () => void; saveLabel?: string;
}) {
  const [f, setF] = useState<FnSpec>(initial ?? { name: '', kind: 'schedule', cron: '*/15 * * * *', prompt: '' });
  const custom = f.kind === 'schedule' && !PRESETS.some((p) => p.cron === f.cron);
  const [showCustom, setShowCustom] = useState(custom);
  const ready = f.prompt.trim() && (f.kind !== 'schedule' || f.cron);
  return (
    <div className="fn-form">
      <Field label="What is this job called?">
        <input value={f.name} placeholder="Check inbox" onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <div className="field">
        <span className="field-label">When does it run?</span>
        <div className="seg">
          {KINDS.map((k) => (
            <button key={k.id} type="button" className={f.kind === k.id ? 'is-on' : ''} title={k.hint}
              onClick={() => setF({ ...f, kind: k.id, cron: k.id === 'schedule' ? f.cron ?? '*/15 * * * *' : null })}>{k.label}</button>
          ))}
        </div>
      </div>
      {f.kind === 'schedule' && (
        <Field label="How often?" hint={showCustom ? 'Cron format: minute hour day month weekday, in the server\'s local time.' : undefined}>
          <div className="row">
            <select value={showCustom ? 'custom' : f.cron ?? ''} onChange={(e) => {
              if (e.target.value === 'custom') setShowCustom(true);
              else { setShowCustom(false); setF({ ...f, cron: e.target.value }); }
            }}>
              {PRESETS.map((p) => <option key={p.cron} value={p.cron}>{p.label}</option>)}
              <option value="custom">Custom schedule…</option>
            </select>
            {showCustom && <input className="mono" value={f.cron ?? ''} placeholder="*/10 * * * *" onChange={(e) => setF({ ...f, cron: e.target.value })} />}
          </div>
        </Field>
      )}
      <Field label="What should it do each time?" hint="Say what to check, what is worth telling you, and what to remember for next time.">
        <textarea rows={4} value={f.prompt} placeholder="Check for new mail since your last check. Notify me about anything that needs a reply today." onChange={(e) => setF({ ...f, prompt: e.target.value })} />
      </Field>
      <div className="row row-end">
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        <Button tone="primary" disabled={!ready} onClick={() => onSave({ ...f, name: f.name.trim() || (f.kind === 'schedule' ? cronWords(f.cron) : 'Untitled job') })}>{saveLabel}</Button>
      </div>
    </div>
  );
}

/** One row per tool with Off / Ask / Allow. Used when creating an agent and in its permissions tab. */
export function ToolGrants({ tools, modes, onChange }: { tools: Tool[]; modes: Record<string, Mode | null | undefined>; onChange: (tool: string, mode: Mode | null) => void }) {
  return (
    <ul className="grants">
      {tools.map((t) => (
        <li key={t.name} className={modes[t.name] === 'allow' || modes[t.name] === 'ask' ? 'is-on' : ''}>
          <div className="grant-text">
            <div className="grant-name">
              <code>{t.name}</code>
              <RiskChip risk={t.risk} />
              {!t.reviewed && <span className="chip chip-ask" title="Made by a harness. Every call asks you until you review it in Tools.">Unreviewed</span>}
            </div>
            <p>{t.description.split('. ')[0]}.</p>
            {t.missing.length > 0 && <p className="warn">Needs {t.missing.join(', ')} in Settings before it can work.</p>}
          </div>
          <ModeSwitch value={modes[t.name]} onChange={(m) => onChange(t.name, m)} />
        </li>
      ))}
    </ul>
  );
}
