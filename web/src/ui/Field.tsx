import {
  forwardRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes,
  type TextareaHTMLAttributes, useId, useRef, useState,
} from 'react';
import { cx, IconButton } from './Button';
import { Icon } from './Icon';

export const charCount = (s: string) => [...s].length;

export function Counter({ value, max }: { value: string; max: number }) {
  const n = charCount(value.trim());
  return <span className={cx('t-counter', n > max && 't-counter--over')}>{n}/{max}</span>;
}

/** A label above a control. Pass the control as a render function to get the generated id. */
export function Field({
  label, hint, error, aside, children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  aside?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="t-field">
      <label className="t-field__label" htmlFor={id}>
        <span>{label}</span>
        {aside}
      </label>
      {children(id)}
      {error ? <span className="t-field__error">{error}</span> : hint && <span className="t-field__hint">{hint}</span>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { size_?: 'sm' }>(
  function Input({ className, size_, ...rest }, ref) {
    return <input ref={ref} className={cx('t-input', size_ === 'sm' && 't-input--sm', className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(
  function Textarea({ className, mono, ...rest }, ref) {
    return <textarea ref={ref} className={cx('t-textarea', mono && 't-textarea--mono', className)} {...rest} />;
  },
);

export function Select<T extends string>({
  value, onChange, options, size, className, ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value' | 'size'> & {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
  size?: 'sm';
}) {
  return (
    <select
      className={cx('t-select', size === 'sm' && 't-select--sm', className)}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      {...rest}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

export const SearchInput = forwardRef<
  HTMLInputElement,
  { value: string; onChange: (v: string) => void; placeholder?: string; shortcut?: string; className?: string; autoFocus?: boolean }
>(function SearchInput({ value, onChange, placeholder = 'Search', shortcut, className, autoFocus }, ref) {
  return (
    <div className={cx('t-search', className)}>
      <Icon name="search" />
      <input
        ref={ref}
        type="search"
        className="t-input"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
      />
      {value ? (
        <IconButton className="t-search__clear" icon="x" label="Clear search" size="sm" onClick={() => onChange('')} />
      ) : (
        shortcut && <span className="t-search__kbd t-kbd">{shortcut}</span>
      )}
    </div>
  );
});

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="t-switch">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** Lowercase tags; Enter, comma or Tab adds one, Backspace on an empty input removes the last. */
export function TagInput({
  value, onChange, placeholder = 'Add tag…', id, suggestions,
}: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; id?: string; suggestions?: string[] }) {
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const add = (raw: string) => {
    const tags = raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (tags.length) onChange([...new Set([...value, ...tags])]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && draft)) && draft.trim()) {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div className="t-tag-input" onClick={() => input.current?.focus()}>
      {value.map((t) => (
        <span key={t} className="t-badge">
          {t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>
            <Icon name="x" width={12} height={12} />
          </button>
        </span>
      ))}
      <input
        ref={input}
        id={id}
        value={draft}
        list={suggestions?.length ? listId : undefined}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={onKey}
        onBlur={() => draft.trim() && add(draft)}
      />
      {suggestions?.length ? (
        <datalist id={listId}>
          {suggestions.filter((s) => !value.includes(s)).map((s) => <option key={s} value={s} />)}
        </datalist>
      ) : null}
    </div>
  );
}
