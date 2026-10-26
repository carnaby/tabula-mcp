import { api } from '../api';
import { useQuery } from '../hooks/data';
import { copyText } from '../format';
import { Alert, Badge, Button, Skeleton, useToast } from '../ui';

const TRIM_LABELS: Record<string, string> = {
  'files-collapsed': 'file list collapsed',
  'facts-omitted': 'facts collapsed',
  'gotchas-first-sentence': 'gotchas shortened',
  'rules-first-sentence': 'rules shortened',
  'state-truncated': 'state shortened',
};

export function RecallPanel({ project }: { project: string }) {
  const q = useQuery((s) => api.recall(project, s), [project], { topics: ['memories', 'files'] });
  const notify = useToast();
  const d = q.data;
  const pct = d ? Math.min(100, Math.round((d.tokens / d.budget) * 100)) : 0;
  const level = !d ? 'ok' : d.overBudget || d.tokens > d.budget ? 'over' : pct > 80 ? 'warn' : 'ok';

  return (
    <div className="t-stack">
      <p className="t-muted">
        The exact digest an agent receives from <code className="t-mono">recall("{project}")</code>: the global rules, the project state and the list of synced files. Claude Code asks for it without the state (the files are on disk); claude.ai gets it as shown.
      </p>
      {q.error && <Alert tone="danger">{q.error.message}</Alert>}
      <div className="t-card t-card--pad t-stack">
        <div className="meter">
          <div className="meter__label">
            <span>Token budget</span>
            <span>{d ? `~${d.tokens} / ${d.budget}` : '…'}</span>
          </div>
          <div className="meter__bar"><div className="meter__fill" data-level={level} style={{ width: `${pct}%` }} /></div>
        </div>
        <div className="t-row">
          {d?.trimmed.length ? d.trimmed.map((s) => <Badge key={s} tone="accent">{TRIM_LABELS[s] ?? s}</Badge>) : d && <Badge tone="success" icon="check">Nothing trimmed</Badge>}
          <span className="t-spacer" />
          <Button size="sm" icon="refresh" onClick={q.reload} loading={q.loading && !!d}>Refresh</Button>
          <Button size="sm" icon="copy" disabled={!d} onClick={async () => notify((await copyText(d!.text)) ? 'Digest copied' : 'Copy failed', { tone: 'default' })}>Copy</Button>
        </div>
        {level === 'over' && <Alert tone="danger">Over budget even after trimming. Shorten the global rules.</Alert>}
      </div>
      {d ? <pre className="digest">{d.text}</pre> : <Skeleton height={320} />}
    </div>
  );
}
