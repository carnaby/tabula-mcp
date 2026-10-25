import { type ReactNode, useEffect, useRef } from 'react';
import { cx, IconButton } from './Button';

/**
 * Native <dialog> as a modal: focus trap, Esc and the top layer come for free.
 * On phones it becomes a bottom sheet (CSS).
 */
export function Dialog({
  open, onClose, title, children, footer, size = 'md', headerExtra,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  headerExtra?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    // Esc: let the owner decide (e.g. ask about unsaved changes) instead of closing right away.
    const onCancel = (e: Event) => {
      e.preventDefault();
      onCloseRef.current();
    };
    d.addEventListener('cancel', onCancel);
    return () => d.removeEventListener('cancel', onCancel);
  }, []);

  return (
    <dialog
      ref={ref}
      className={cx('t-dialog', size !== 'md' && `t-dialog--${size}`)}
      onMouseDown={(e) => {
        // A click on the backdrop lands on the <dialog> element itself.
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <>
          <div className="t-dialog__head">
            <h2>{title}</h2>
            {headerExtra}
            <IconButton icon="x" label="Close" onClick={onClose} />
          </div>
          <div className="t-dialog__body">{children}</div>
          {footer && <div className="t-dialog__foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}
