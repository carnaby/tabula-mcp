import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo, useState } from 'react';
import { cx } from './Button';
import { Textarea } from './Field';
import { Segmented } from './Segmented';

marked.setOptions({ gfm: true, breaks: true });

// Links in notes open in a new tab and never get access to this window.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export const renderMarkdown = (src: string) => DOMPurify.sanitize(marked.parse(src, { async: false }) as string);

export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={cx('t-md', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

type Mode = 'write' | 'split' | 'preview';
const MODE_KEY = 'tabula.editorMode';
const readMode = (): Mode => {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === 'write' || m === 'split' || m === 'preview') return m;
  } catch { /* storage unavailable */ }
  return window.matchMedia('(min-width: 900px)').matches ? 'split' : 'write';
};

export function MarkdownEditor({
  value, onChange, id, placeholder, onSubmit, aside, minRows = 16,
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
  placeholder?: string;
  /** Ctrl/Cmd+S or Ctrl/Cmd+Enter. */
  onSubmit?: () => void;
  aside?: React.ReactNode;
  minRows?: number;
}) {
  const [mode, setModeState] = useState<Mode>(readMode);
  const setMode = (m: Mode) => {
    setModeState(m);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ }
  };
  const narrow = typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;

  return (
    <div className="t-md-editor" data-mode={mode}>
      <div className="t-md-editor__bar">
        <Segmented
          label="Editor mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'write', label: 'Write', icon: 'pencil' },
            ...(narrow ? [] : [{ value: 'split' as const, label: 'Split', icon: 'columns' as const }]),
            { value: 'preview', label: 'Preview', icon: 'eye' },
          ]}
        />
        {aside}
      </div>
      <div className="t-md-editor__panes">
        {mode !== 'preview' && (
          <Textarea
            id={id}
            mono
            rows={minRows}
            value={value}
            placeholder={placeholder ?? 'Markdown: # heading, - list, **bold**, `code`, [link](https://…)'}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (onSubmit && (e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'Enter')) {
                e.preventDefault();
                onSubmit();
              }
            }}
          />
        )}
        {mode !== 'write' && (
          <div className="t-md-editor__preview">
            {value.trim() ? <Markdown source={value} /> : <p className="t-subtle">Nothing to preview yet.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
