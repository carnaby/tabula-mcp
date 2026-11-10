import { COPY_PROMPT_MAX, copyPromptProblem, normalizeCopyPrompt } from '@tabula/shared/copy-prompt';
import { type ReactNode, useEffect, useState } from 'react';
import { Button, Counter, Dialog, Field, Textarea, useToast } from '../../ui';

/** A prompt text Home copies for Claude; the server keeps it, so every device uses the same. */
export function PromptDialog({
  open, title, intro, text, fallback, preview, save, onClose, onSaved,
}: {
  open: boolean;
  title: string;
  intro: ReactNode;
  text: string;
  /** The default text, which Reset to default puts back. */
  fallback: string;
  /** The filled text for the preview. */
  preview: (clean: string) => string;
  save: (text: string) => Promise<unknown>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notify = useToast();
  useEffect(() => {
    if (!open) return;
    setDraft(text);
    setError(null);
  }, [open, text]);

  const clean = normalizeCopyPrompt(draft);
  const problem = copyPromptProblem(clean);
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await save(draft);
      notify('Saved');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={() => setDraft(fallback)} disabled={clean === fallback}>Reset to default</Button>
          <span className="t-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!!problem} onClick={() => void submit()}>Save</Button>
        </>
      }
    >
      <p className="t-muted">{intro}</p>
      <Field label="Text" aside={<Counter value={clean} max={COPY_PROMPT_MAX} />} error={problem ?? error ?? undefined} hint="Empty goes back to the default.">
        {(id) => <Textarea id={id} rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} />}
      </Field>
      <div className="copy-preview">
        <span className="t-subtle">Preview</span>
        <pre>{preview(clean || fallback)}</pre>
      </div>
    </Dialog>
  );
}
