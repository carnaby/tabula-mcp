import { cx } from './Button';
import { Icon, type IconName } from './Icon';

export function Segmented<T extends string>({
  value, onChange, options, label, block,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string; icon?: IconName; iconOnly?: boolean }[];
  label: string;
  block?: boolean;
}) {
  return (
    <div className={cx('t-seg', block && 't-seg--block')} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          aria-label={o.iconOnly ? o.label : undefined}
          title={o.iconOnly ? o.label : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} />}
          {!o.iconOnly && o.label}
        </button>
      ))}
    </div>
  );
}
