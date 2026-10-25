import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'default' | 'primary' | 'accent' | 'ghost' | 'danger' | 'danger-solid';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  block?: boolean;
};

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

const classes = (variant: ButtonVariant, size: 'md' | 'sm', extra?: string) =>
  cx('t-btn', variant !== 'default' && `t-btn--${variant}`, size === 'sm' && 't-btn--sm', extra);

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, iconRight, loading, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={classes(variant, size, cx(block && 't-btn--block', className))}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="t-spinner" /> : icon && <Icon name={icon} />}
      {children}
      {iconRight && <Icon name={iconRight} />}
    </button>
  );
});

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  /** Required: the accessible name and the tooltip. */
  label: string;
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  pressed?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = 'ghost', size = 'md', pressed, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={classes(variant, size, cx('t-icon-btn', className))}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
});

export function ButtonLink({
  href, variant = 'default', size = 'md', icon, children, className,
}: { href: string; variant?: ButtonVariant; size?: 'md' | 'sm'; icon?: IconName; children: ReactNode; className?: string }) {
  return (
    <a href={href} className={classes(variant, size, className)} style={{ textDecoration: 'none' }}>
      {icon && <Icon name={icon} />}
      {children}
    </a>
  );
}
