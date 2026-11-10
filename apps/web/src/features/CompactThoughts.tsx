import { DEFAULT_COMPACT_PROMPT, fillCompactPrompt } from '@tabula/shared/compact-prompt';
import { useState } from 'react';
import { api } from '../api';
import { copyText } from '../format';
import { useQuery } from '../hooks/data';
import { Button, IconButton, useToast } from '../ui';
import { PromptDialog } from './home/PromptDialog';

/** Tidy with Claude: copies the compact text, scoped to the tag the list is filtered by; the gear edits the text. */
export function CompactThoughts({ tag }: { tag: string | undefined }) {
  const compact = useQuery((s) => api.compactPrompt(s), []);
  const [editing, setEditing] = useState(false);
  const notify = useToast();
  // Until the saved text has loaded there is none: copying the default would be the wrong text.
  const text = compact.data?.text;
  const copy = async () => {
    if (text === undefined) return;
    if (await copyText(fillCompactPrompt(text, tag))) notify('Copied');
    // The text is long: point to the gear's dialog, where it can be selected and copied by hand.
    else notify('Copy failed — open the gear next to Tidy with Claude and copy the text from there.', { tone: 'danger' });
  };
  return (
    <span className="compact-thoughts">
      {compact.error && !text && <span className="t-subtle">The tidy text did not load.</span>}
      <Button icon="copy" disabled={text === undefined} onClick={() => void copy()}>Tidy with Claude</Button>
      <IconButton icon="gear" label="Tidy thoughts text" disabled={text === undefined} onClick={() => setEditing(true)} />
      <PromptDialog
        open={editing && text !== undefined}
        title="Tidy thoughts"
        intro={<><strong>Tidy with Claude</strong> copies this text. Paste it into a chat: Claude proposes how to merge, split and de-duplicate your thoughts, waits for your OK, then archives the originals (nothing is deleted). With a tag selected, a last line limits it to that tag.</>}
        text={text ?? ''}
        fallback={DEFAULT_COMPACT_PROMPT}
        preview={(clean) => fillCompactPrompt(clean, tag)}
        save={(t) => api.setCompactPrompt(t)}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          compact.reload();
        }}
      />
    </span>
  );
}
