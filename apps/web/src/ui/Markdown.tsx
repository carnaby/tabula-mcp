import { findRef } from '@tabula/shared/refs';
import DOMPurify from 'dompurify';
import { Marked, marked } from 'marked';
import { useMemo, useState } from 'react';
import { cx } from './Button';
import { Textarea } from './Field';
import { href } from '../router';
import { Segmented } from './Segmented';

marked.setOptions({ gfm: true, breaks: true });

// A reference (tabula:xxxxxxxx) in running text becomes a link to the Search page, which opens the record.
// It is an inline extension, so code spans and code blocks keep the text as is; inside a link's text it is left
// alone (marked sets state.inLink while it reads the text), so there is never a link inside a link.
marked.use({
  extensions: [{
    name: 'tabulaRef',
    level: 'inline',
    start: (src: string) => findRef(src)?.index,
    tokenizer(src: string) {
      if (this.lexer.state.inLink) return undefined;
      const m = findRef(src);
      if (!m || m.index !== 0) return undefined;
      return { type: 'tabulaRef', raw: src.slice(0, m.length), ref: m.ref };
    },
    renderer: (token) => `<a class="ref-link" href="${href.search(token.ref as string)}">${token.ref as string}</a>`,
  }],
});

// External links in notes open in a new tab and never get access to this window; internal ones (#/…) stay in this tab.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  const target = node.tagName === 'A' ? node.getAttribute('href') : null;
  if (target && !target.startsWith('#')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export const renderMarkdown = (src: string) => DOMPurify.sanitize(marked.parse(src, { async: false }) as string);

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Markdown for text from someone nobody verified. It must not be able to change the app around it or make the browser
 * fetch anything, so HTML typed into the text stays visible as text, an image becomes a link to it, and a task list
 * keeps its marks as text. References stay plain text: internal links are not accepted here. Nothing may vanish either:
 * the owner decides from this view while agents read the raw text.
 */
const untrustedMarked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text, block }) {
      return block ? `<p>${escapeHtml(text)}</p>\n` : escapeHtml(text);
    },
    // After an inline <kbd>, <code>, <pre> or <script> marked treats what follows as already escaped, so a tag left open
    // there would swallow the text up to its closing quote. The default renderer escapes it once the flag is off.
    text(token) {
      if ('escaped' in token) token.escaped = false;
      return false;
    },
    // A link definition renders nothing by default, which would make it a place to hide text.
    def({ raw }) {
      return `<p>${escapeHtml(raw)}</p>\n`;
    },
    image({ href, title, text, tokens }) {
      const alt = tokens ? this.parser.parseInline(tokens, this.parser.textRenderer) : text;
      return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(alt || href)}</a>`;
    },
    checkbox({ checked }) {
      return checked ? '[x] ' : '[ ] ';
    },
  },
});

/** The second line of defence: whatever the renderer lets through, only text elements and plain links remain. */
const UNTRUSTED_HTML = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a',
  ],
  ALLOWED_ATTR: ['href', 'title'],
  ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

const renderUntrustedMarkdown = (src: string) => DOMPurify.sanitize(untrustedMarked.parse(src, { async: false }) as string, UNTRUSTED_HTML);

export function Markdown({ source, className, untrusted }: { source: string; className?: string; untrusted?: boolean }) {
  const html = useMemo(() => (untrusted ? renderUntrustedMarkdown(source) : renderMarkdown(source)), [source, untrusted]);
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
