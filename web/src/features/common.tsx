import { fullDate, timeAgo } from '../format';
import { KIND_INFO, type MemoryKind, type Project, type Source } from '../types';
import { Badge, cx, Icon, Markdown, Select } from '../ui';

export function KindBadge({ kind }: { kind: MemoryKind }) {
  return <Badge tone={kind} title={KIND_INFO[kind].hint}>{KIND_INFO[kind].label}</Badge>;
}

/** Who wrote it: a person icon for the human, a bot icon plus the client label for agents. */
export function Author({ source, label, compact }: { source: Source; label?: string | null; compact?: boolean }) {
  const agent = source === 'agent' || (label !== undefined && label !== null && label !== 'human');
  const name = agent ? (label ?? 'agent') : 'You';
  return (
    <span className="t-row" style={{ gap: 6, flexWrap: 'nowrap' }} title={agent ? `Written by agent ${name}` : 'Written by you'}>
      <span className={cx('t-avatar', agent && 't-avatar--agent')}>
        <Icon name={agent ? 'bot' : 'user'} />
      </span>
      {!compact && <span className="t-truncate">{name}</span>}
    </span>
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

export const FileAuthor = ({ by, compact }: { by: string; compact?: boolean }) => (
  <Author source={by === 'human' ? 'human' : 'agent'} label={by} compact={compact} />
);

export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

/** File text: Markdown (sanitized) for .md files, plain text otherwise. */
export function FileContent({ path, content }: { path: string; content: string }) {
  return isMarkdown(path) ? <Markdown source={content} /> : <pre className="digest">{content}</pre>;
}
