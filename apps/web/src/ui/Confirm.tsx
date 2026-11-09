import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Field, Textarea } from './Field';

type ConfirmOptions = {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};
type PromptOptions = ConfirmOptions & { label: string; placeholder?: string; initial?: string; required?: boolean };

type Pending =
  | { type: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { type: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void };

type Api = { confirm: (o: ConfirmOptions) => Promise<boolean>; prompt: (o: PromptOptions) => Promise<string | null> };

const Ctx = createContext<Api | null>(null);

/** Promise-based replacements for window.confirm / window.prompt that match the kit and work on phones. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [text, setText] = useState('');
  const current = useRef<Pending | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        current.current = { type: 'confirm', opts, resolve };
        setPending(current.current);
      }),
    [],
  );
  const prompt = useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        current.current = { type: 'prompt', opts, resolve };
        setText(opts.initial ?? '');
        setPending(current.current);
      }),
    [],
  );

  const finish = (ok: boolean) => {
    const p = current.current;
    current.current = null;
    setPending(null);
    if (!p) return;
    if (p.type === 'confirm') p.resolve(ok);
    else p.resolve(ok ? text.trim() : null);
  };

  const o = pending?.opts;
  const blocked = pending?.type === 'prompt' && pending.opts.required !== false && !text.trim();

  return (
    <Ctx.Provider value={{ confirm, prompt }}>
      {children}
      <Dialog
        open={!!pending}
        onClose={() => finish(false)}
        title={o?.title ?? ''}
        size="sm"
        footer={
          <>
            <Button onClick={() => finish(false)}>{o?.cancelLabel ?? 'Cancel'}</Button>
            <Button variant={o?.danger ? 'danger-solid' : 'primary'} disabled={blocked} onClick={() => finish(true)} autoFocus={pending?.type === 'confirm'}>
              {o?.confirmLabel ?? 'OK'}
            </Button>
          </>
        }
      >
        {o?.message && <div className="t-muted">{o.message}</div>}
        {pending?.type === 'prompt' && (
          <Field label={pending.opts.label}>
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                autoFocus
                value={text}
                placeholder={pending.opts.placeholder}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !blocked) finish(true);
                }}
              />
            )}
          </Field>
        )}
      </Dialog>
    </Ctx.Provider>
  );
}

export function useConfirm(): Api {
  const api = useContext(Ctx);
  if (!api) throw new Error('useConfirm needs <ConfirmProvider>');
  return api;
}
