import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { cx } from './Button';

/**
 * A small panel anchored under its trigger button. Closes on a tap outside, on Escape (focus goes back to the
 * trigger) and when an item calls `close`. It stays inside the viewport, or inside the open <dialog> it sits in,
 * because a dialog clips what overflows it.
 */
export function Popover({
  trigger, triggerLabel, triggerClassName, className, children,
}: {
  trigger: ReactNode;
  /** The accessible name of the trigger button. */
  triggerLabel: string;
  triggerClassName?: string;
  className?: string;
  /** A function gets `close` and `labelId`: give the panel's heading that id to name the panel. */
  children: ReactNode | ((close: () => void, labelId: string) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Capture phase + preventDefault: Escape closes only the panel, not the dialog around it.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    // Browsers that close a <dialog> on Escape without honouring the keydown's preventDefault fire `cancel` on it.
    const dialog = root.current?.closest('dialog');
    const onCancel = (e: Event) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    dialog?.addEventListener('cancel', onCancel, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      dialog?.removeEventListener('cancel', onCancel, true);
    };
  }, [open]);

  // Shift the panel left when it would stick out on the right (8px margin).
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    el.style.left = '0px';
    const box = el.getBoundingClientRect();
    const bounds = el.closest('dialog')?.getBoundingClientRect() ?? { left: 0, right: document.documentElement.clientWidth };
    const over = box.right - (bounds.right - 8);
    if (over > 0) el.style.left = `${-Math.max(0, Math.min(over, box.left - (bounds.left + 8)))}px`;
  }, [open]);

  return (
    <span
      ref={root}
      className={cx('t-popover', className)}
      onBlur={(e) => {
        // Keyboard focus moved elsewhere (Tab). A null relatedTarget (e.g. a tap that focuses nothing) is left to the
        // pointerdown handler, so a tap on an item inside the panel still lands.
        if (open && e.relatedTarget && !root.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className={cx('t-popover__trigger', triggerClassName)}
        aria-label={triggerLabel}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open && (
        <div ref={panel} id={id} className="t-popover__panel" role="group" aria-labelledby={typeof children === 'function' ? `${id}-label` : undefined}>
          {typeof children === 'function' ? children(close, `${id}-label`) : children}
        </div>
      )}
    </span>
  );
}
