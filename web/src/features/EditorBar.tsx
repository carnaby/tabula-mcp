import type { ReactNode } from 'react';
import { Button, IconLink } from '../ui';

/**
 * The sticky one-line bar on top of an editor: [back] [who · when · unsaved dot] … [actions] [Save].
 * Only the middle part shrinks (it truncates); the back button and the actions keep their size.
 */
export function EditorBar({
  back, meta, dirty, children,
}: { back: { href: string; label: string }; meta: ReactNode; dirty?: boolean; children?: ReactNode }) {
  return (
    <div className="editor__bar">
      <IconLink href={back.href} icon="arrowLeft" label={back.label} />
      <div className="editor__meta">
        {meta}
        {dirty && <span className="dirty-dot" title="Unsaved changes" role="img" aria-label="Unsaved changes" />}
      </div>
      {children && <div className="editor__actions">{children}</div>}
    </div>
  );
}

/** The editor's Save; on phones an icon-only primary button (the label stays for screen readers). */
export function SaveButton({ loading, disabled, onClick }: { loading: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <Button variant="primary" icon="check" className="editor__save" loading={loading} disabled={disabled} onClick={onClick} title="Save (Ctrl/⌘ S)">
      <span className="editor__save-label">Save</span>
    </Button>
  );
}
