import { refOf } from '../../../src/shared/refs';
import { copyText } from '../format';
import { IconButton, useToast } from '../ui';

/** Copies the record's reference (tabula:xxxxxxxx): pasted into a chat, Claude opens the record; pasted into Search, the UI does. */
export function CopyRefButton({ id, size, className }: { id: string; size?: 'md' | 'sm'; className?: string }) {
  const notify = useToast();
  const ref = refOf(id);
  return (
    <IconButton
      icon="tabula"
      size={size}
      className={className}
      label="Copy reference"
      title={`Copy reference ${ref}`}
      // Inside clickable rows the click (and Enter) copies; it must not open the row.
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyText(ref)) notify(`Copied ${ref}`);
        else notify(`Copy failed — the reference is ${ref}`, { tone: 'danger' });
      }}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}
