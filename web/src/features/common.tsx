import type { ReactNode } from 'react';
import { fullDate, timeAgo } from '../format';
import { KIND_INFO, type MemoryKind, type Project, type Source } from '../types';
import { Badge, cx, Icon, type IconName, Markdown, Popover, Select } from '../ui';

export function KindBadge({ kind }: { kind: MemoryKind }) {
  return <Badge tone={kind} title={KIND_INFO[kind].hint}>{KIND_INFO[kind].label}</Badge>;
}

type AuthorKind = 'you' | 'code' | 'ai' | 'agent';
const AUTHOR_CLASS: Record<AuthorKind, string | false> = { you: false, code: 't-avatar--code', ai: 't-avatar--ai', agent: 't-avatar--agent' };

/** Who wrote it, from the source and the client label agents send ("claude-code", "claude-ai", …). */
export function authorInfo(source: Source, label?: string | null): { kind: AuthorKind; name: string; title: string } {
  const agent = source === 'agent' || (label !== undefined && label !== null && label !== 'human');
  if (!agent) return { kind: 'you', name: 'You', title: 'Written by you' };
  const key = (label ?? '').trim().toLowerCase().replace(/[\s_.]+/g, '-');
  if (key === 'claude-code') return { kind: 'code', name: 'Claude Code', title: 'Written by Claude Code' };
  if (key === 'claude-ai') return { kind: 'ai', name: 'claude.ai', title: 'Written by claude.ai' };
  return label ? { kind: 'agent', name: label, title: `Written by agent ${label}` } : { kind: 'agent', name: 'Agent', title: 'Written by an agent' };
}

/** Records that keep only who edited them last ("human" or the agent's label) as an author. */
export const authorOf = (by: string): { source: Source; label: string } => ({ source: by === 'human' ? 'human' : 'agent', label: by });

/** The author's icon: a person for you, the spark for Claude Code and claude.ai, a bot for any other agent. */
export const authorIcon = (kind: AuthorKind): IconName => (kind === 'you' ? 'user' : kind === 'agent' ? 'bot' : 'claude');

/**
 * Who wrote it as a coloured icon: you (grey person), Claude Code (red spark), claude.ai (orange spark), any other
 * agent (bot). `compact` shows the icon only; the name is then in the tooltip and the accessible name.
 */
export function Author({ source, label, compact }: { source: Source; label?: string | null; compact?: boolean }) {
  const a = authorInfo(source, label);
  const icon = authorIcon(a.kind);
  return (
    <span className="t-author" title={a.title}>
      <span className={cx('t-avatar', AUTHOR_CLASS[a.kind])} {...(compact ? { role: 'img', 'aria-label': a.title } : {})}>
        <Icon name={icon} />
      </span>
      {!compact && <span className="t-truncate">{a.name}</span>}
    </span>
  );
}

/**
 * The editor bar's "who and when": the author icon and the relative time; a tap opens a small panel with the name,
 * the full date, `details` and, when the record keeps versions, a "Version history" item.
 */
export function AuthorMeta({
  author, iso, heading = 'Last edited', details, onHistory,
}: {
  /** Omit for records that don't store who wrote them. */
  author?: { source: Source; label?: string | null };
  iso: string;
  heading?: string;
  details?: ReactNode;
  onHistory?: () => void;
}) {
  const a = author && authorInfo(author.source, author.label);
  return (
    <Popover
      className="author-meta"
      triggerLabel={`${a ? `${a.title}, ` : `${heading} `}${timeAgo(iso)}. Details`}
      trigger={
        <>
          {author && <Author source={author.source} label={author.label} compact />}
          <span className="t-truncate">{timeAgo(iso)}</span>
        </>
      }
    >
      {(close, labelId) => (
        <>
          <div className="author-meta__info">
            <span className="t-subtle" id={labelId}>{heading}{a ? ' by' : ''}</span>
            {author && <Author source={author.source} label={author.label} />}
            <time dateTime={iso}>{fullDate(iso)}</time>
            {details}
          </div>
          {onHistory && (
            <>
              <hr />
              <button type="button" className="t-popover__item" onClick={() => { close(); onHistory(); }}>
                <Icon name="history" /> Version history
              </button>
            </>
          )}
        </>
      )}
    </Popover>
  );
}

export function TimeAgo({ iso }: { iso: string }) {
  return <time dateTime={iso} title={fullDate(iso)} className="t-nowrap">{timeAgo(iso)}</time>;
}

export function ProjectSelect({
  projects, value, onChange, allowAll, size, id,
}: { projects: Project[] | undefined; value: string; onChange: (v: string) => void; allowAll?: boolean; size?: 'sm'; id?: string }) {
  return (
    <Select
      id={id}
      size={size}
      aria-label="Project"
      value={value}
      onChange={onChange}
      options={[
        ...(allowAll ? [{ value: '', label: 'All projects' }] : []),
        ...(projects ?? []).map((p) => ({ value: p.id, label: p.id === 'global' ? 'Global' : p.id })),
      ]}
    />
  );
}

/** "**word**" from ts_headline → <mark>; everything else rendered as text. */
export function Highlighted({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>;
}

export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

/** File text: Markdown (sanitized) for .md files, plain text otherwise. */
export function FileContent({ path, content }: { path: string; content: string }) {
  return isMarkdown(path) ? <Markdown source={content} /> : <pre className="digest">{content}</pre>;
}
