import { COPY_PROMPT_MAX, copyPromptProblem, DEFAULT_COPY_PROMPT, fillCopyPrompt, normalizeCopyPrompt } from '@tabula/shared/copy-prompt';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Button, Counter, Dialog, Field, Textarea, useToast } from '../../ui';

/** A made-up reference for the preview. */
const SAMPLE_REF = 'tabula:1a2b3c4d';

/** The text Copy for Claude copies; the server keeps it, so every device uses the same. */
export function CopyPromptDialog({ open, text, onClose, onSaved }: { open: boolean; text: string; onClose: () => void; onSaved: () => void }) {
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
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.setCopyPrompt(draft);
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
      title="Copy for Claude"
      footer={
        <>
          <Button onClick={() => setDraft(DEFAULT_COPY_PROMPT)} disabled={clean === DEFAULT_COPY_PROMPT}>Reset to default</Button>
          <span className="t-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!!problem} onClick={() => void save()}>Save</Button>
        </>
      }
    >
      <p className="t-muted">
        What <strong>Copy for Claude</strong> puts on the clipboard for a new report. <code className="t-mono">{'{ref}'}</code> becomes the
        report's reference; a text without it gets the reference at the end.
      </p>
      <Field label="Text" aside={<Counter value={clean} max={COPY_PROMPT_MAX} />} error={problem ?? error ?? undefined} hint="Empty goes back to the default.">
        {(id) => <Textarea id={id} rows={5} value={draft} onChange={(e) => setDraft(e.target.value)} />}
      </Field>
      <div className="copy-preview">
        <span className="t-subtle">Preview</span>
        <pre>{fillCopyPrompt(clean || DEFAULT_COPY_PROMPT, SAMPLE_REF)}</pre>
      </div>
    </Dialog>
  );
}
