import { Icon, type IconName } from './Icon';

export function Tabs({
  items, current, label,
}: {
  items: readonly { id: string; label: string; href: string; icon?: IconName; count?: number }[];
  current: string;
  label: string;
}) {
  return (
    <nav className="t-tabs" aria-label={label}>
      {items.map((t) => (
        <a key={t.id} className="t-tab" href={t.href} aria-current={t.id === current ? 'page' : undefined}>
          {t.icon && <Icon name={t.icon} />}
          {t.label}
          {t.count !== undefined && <span className="t-tab__count">{t.count}</span>}
        </a>
      ))}
    </nav>
  );
}
