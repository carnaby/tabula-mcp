import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { Button, cx, IconButton } from './Button';
import { Icon } from './Icon';

type Toast = { id: number; message: ReactNode; tone: 'default' | 'danger'; action?: { label: string; run: () => void } };
type Notify = (message: ReactNode, opts?: { tone?: 'default' | 'danger'; action?: Toast['action']; duration?: number }) => void;

const Ctx = createContext<Notify | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  const notify = useCallback<Notify>((message, opts = {}) => {
    const id = ++seq.current;
    const tone = opts.tone ?? 'default';
    setToasts((t) => [...t.slice(-3), { id, message, tone, action: opts.action }]);
    setTimeout(() => dismiss(id), opts.duration ?? (tone === 'danger' ? 7000 : 3500));
  }, []);

  return (
    <Ctx.Provider value={notify}>
      {children}
      <div className="t-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx('t-toast', t.tone === 'danger' && 't-toast--danger')} role={t.tone === 'danger' ? 'alert' : 'status'}>
            <Icon name={t.tone === 'danger' ? 'alert' : 'check'} />
            <div className="t-toast__msg">{t.message}</div>
            {t.action && (
              <Button size="sm" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</Button>
            )}
            <IconButton icon="x" label="Dismiss" size="sm" variant="ghost" onClick={() => dismiss(t.id)} style={{ color: 'inherit', height: 24, width: 24 }} />
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): Notify {
  const n = useContext(Ctx);
  if (!n) throw new Error('useToast needs <ToastProvider>');
  return n;
}
