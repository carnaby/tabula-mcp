import type { ReactNode } from 'react';
import { cx } from './Button';
import { Icon, type IconName } from './Icon';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'danger' | 'info' | 'outline' | 'rule' | 'gotcha' | 'decision' | 'fact';

export function Badge({ tone = 'neutral', icon, children, title }: { tone?: BadgeTone; icon?: IconName; children: ReactNode; title?: string }) {
  return (
    <span className={cx('t-badge', tone !== 'neutral' && `t-badge--${tone}`)} title={title}>
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

export function Chip({
  pressed, onClick, children, count,
}: { pressed?: boolean; onClick: () => void; children: ReactNode; count?: number }) {
  return (
    <button type="button" className="t-chip" aria-pressed={pressed} onClick={onClick}>
      {children}
      {count !== undefined && <span className="t-chip__count">{count}</span>}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="t-kbd">{children}</kbd>;
}
