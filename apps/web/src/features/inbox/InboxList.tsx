import { api } from '../../api';
import { useClampPage, useQuery, useTableState } from '../../hooks/data';
import { href } from '../../router';
import { MESSAGE_STATUS_LABEL, MESSAGE_WAITING_LABEL, type MessageStatus, type MessageStatusFilter, type MessageSummary, type MessageType, type Project } from '../../types';
import { Alert, Badge, type BadgeTone, Button, EmptyState, Pagination, Select, Skeleton } from '../../ui';
import { TimeAgo } from '../common';
import { ListToolbar } from '../ListToolbar';

type Filters = { status: MessageStatusFilter; to: string; from: string; type: MessageType | '' };

export const MESSAGE_TONE: Record<MessageStatus, BadgeTone> = { new: 'accent', in_progress: 'info', waiting: 'decision', done: 'success', rejected: 'neutral' };

const STATUS_OPTIONS: { value: MessageStatusFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'new', label: 'New' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'archive', label: 'Archive' },
  { value: 'done', label: 'Done' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
];
const TYPE_OPTIONS: { value: MessageType | ''; label: string }[] = [
  { value: '', label: 'All types' }, { value: 'request', label: 'Requests' }, { value: 'report', label: 'Reports' },
];

export const statusText = (m: Pick<MessageSummary, 'status' | 'waiting_on'>) =>
  m.status === 'waiting' && m.waiting_on ? `Waiting for ${MESSAGE_WAITING_LABEL[m.waiting_on]}` : MESSAGE_STATUS_LABEL[m.status];

export function InboxList({ projects }: { projects: Project[] | undefined }) {
  const t = useTableState<'updatedAt', Filters>('inbox', { sort: 'updatedAt', dir: 'desc', pageSize: 25, filters: { status: 'open', to: '', from: '', type: '' } });
  const { status, to, from, type } = t.filters;
  const list = useQuery(
    (s) => api.messages({ status, to: to || undefined, from: from || undefined, type: type || undefined, page: t.page, pageSize: t.pageSize }, s),
    [status, to, from, type, t.page, t.pageSize],
    { topics: ['messages'] },
  );
  useClampPage(list.data?.total, t.page, t.pageSize, t.setPage);
  const slugs = (projects ?? []).filter((p) => p.id !== 'global').map((p) => ({ value: p.id, label: p.name || p.id }));
  const filtered = status !== 'open' || !!to || !!from || !!type;

  return (
    <div className="t-stack">
      <ListToolbar
        search={<Select aria-label="Status" value={status} onChange={(v) => t.setFilter('status', v)} options={STATUS_OPTIONS} />}
        filters={
          <>
            <Select aria-label="Recipient" value={to} onChange={(v) => t.setFilter('to', v)} options={[{ value: '', label: 'All recipients' }, ...slugs]} />
            <Select aria-label="Sender" value={from} onChange={(v) => t.setFilter('from', v)} options={[{ value: '', label: 'All senders' }, ...slugs]} />
            <Select aria-label="Type" value={type} onChange={(v) => t.setFilter('type', v)} options={TYPE_OPTIONS} />
          </>
        }
        active={[to, from, type].filter(Boolean).length}
      />

      {list.error && <Alert tone="danger">{list.error.message}</Alert>}
      {!list.data && !list.error && <div className="t-stack">{[0, 1, 2].map((i) => <Skeleton key={i} height={76} style={{ borderRadius: 12 }} />)}</div>}
      {list.data?.items.length === 0 &&
        (filtered ? (
          <EmptyState icon="search" title="No messages match" action={<Button onClick={t.resetFilters}>Clear filters</Button>} />
        ) : (
          <EmptyState icon="mail" title="No open messages">Projects send requests and reports here through their agents.</EmptyState>
        ))}
      {list.data && list.data.items.length > 0 && (
        <div className="report-list" style={{ opacity: list.loading ? 0.6 : 1 }}>
          {list.data.items.map((m) => (
            <a key={m.id} href={href.message(m.id)} className="t-card t-card--interactive report-card">
              <div className="report-card__top">
                <span className="report-card__title">{m.title}</span>
                <Badge tone={MESSAGE_TONE[m.status]}>{statusText(m)}</Badge>
              </div>
              <div className="report-card__meta">
                <Badge tone="outline" title="Declared by the sender, not verified">{m.from}</Badge>
                <span className="t-subtle">to</span>
                <Badge tone="outline" icon="folder">{m.to}</Badge>
                <Badge>{m.type === 'request' ? 'Request' : 'Report'}</Badge>
                <span className="t-spacer" />
                <span className="t-subtle"><TimeAgo iso={m.updated_at} /></span>
              </div>
            </a>
          ))}
        </div>
      )}
      {list.data && list.data.total > t.pageSize && (
        <div className="list-foot">
          <span>{list.data.total} messages</span>
          <Pagination page={t.page} pageSize={t.pageSize} total={list.data.total} onPage={t.setPage} />
        </div>
      )}
    </div>
  );
}
