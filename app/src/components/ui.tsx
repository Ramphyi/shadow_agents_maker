import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { slideIn } from '../anim';
import type { Mode, Risk } from '../types';

export function Button({ tone = 'ghost', busy, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'ghost' | 'danger' | 'ok'; busy?: boolean }) {
  return (
    <button type="button" {...rest} className={`btn btn-${tone} ${rest.className ?? ''}`} disabled={rest.disabled || busy}>
      {busy && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Chip({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

const RISK_TEXT: Record<Risk, string> = { safe: 'Stays inside', read: 'Reads outside', act: 'Acts outside' };
export const RiskChip = ({ risk }: { risk: Risk }) => <Chip tone={risk}>{RISK_TEXT[risk]}</Chip>;

const MODES: { mode: Mode | null; label: string; hint: string }[] = [
  { mode: null, label: 'Off', hint: 'The agent does not have this tool.' },
  { mode: 'ask', label: 'Ask', hint: 'You approve each call.' },
  { mode: 'allow', label: 'Allow', hint: 'Runs without asking.' },
];
/** Off / Ask / Allow. "deny" from older data shows as Off. */
export function ModeSwitch({ value, onChange, compact }: { value: Mode | null | undefined; onChange: (m: Mode | null) => void; compact?: boolean }) {
  const current = value === 'allow' || value === 'ask' ? value : null;
  return (
    <div className={`modes ${compact ? 'modes-compact' : ''}`} role="radiogroup">
      {MODES.map((m) => (
        <button key={m.label} type="button" role="radio" aria-checked={current === m.mode} title={m.hint}
          className={`mode mode-${m.mode ?? 'off'} ${current === m.mode ? 'is-on' : ''}`} onClick={() => onChange(m.mode)}>
          {m.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`toggle ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? 'is-on' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
          {!!t.count && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty" data-enter>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button onClick={() => { void navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); }}>
      {done ? 'Copied' : label}
    </Button>
  );
}

/** `copyText` lets the block show a masked value while the button copies the real one. */
export function CodeBlock({ text, copy = true, copyText }: { text: string; copy?: boolean; copyText?: string }) {
  return (
    <div className="code">
      <pre>{text}</pre>
      {copy && <Copy text={copyText ?? text} />}
    </div>
  );
}

/** Side panel that slides over the current view. Escape or the backdrop closes it. */
export function Drawer({ onClose, children, wide }: { onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    slideIn(ref.current);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={ref} className={`drawer ${wide ? 'drawer-wide' : ''}`} role="dialog" aria-modal="true">{children}</aside>
    </div>
  );
}

export function Modal({ onClose, title, children }: { onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    slideIn(ref.current, 'up');
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="scrim scrim-center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head"><h2>{title}</h2><Button onClick={onClose} aria-label="Close">Close</Button></header>
        {children}
      </div>
    </div>
  );
}
