import type { ReactNode } from 'react';
import { cx } from './Button';
import { Icon, type IconName } from './Icon';

export function EmptyState({ icon = 'inbox', title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="t-empty">
      <div className="t-empty__icon"><Icon name={icon} /></div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function Alert({ tone = 'info', children, icon }: { tone?: 'info' | 'danger' | 'warn'; children: ReactNode; icon?: IconName }) {
  return (
    <div className={cx('t-alert', tone !== 'info' && `t-alert--${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={icon ?? (tone === 'info' ? 'info' : 'alert')} />
      <div className="t-alert__body">{children}</div>
    </div>
  );
}

export function Skeleton({ width = '100%', height = 14, style }: { width?: number | string; height?: number; style?: React.CSSProperties }) {
  return <div className="t-skeleton" style={{ width, height, ...style }} />;
}

export function Spinner() {
  return <span className="t-spinner" role="status" aria-label="Loading" />;
}
