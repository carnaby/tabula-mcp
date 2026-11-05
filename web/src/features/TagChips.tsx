import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Chip, TextButton } from '../ui';

const MAX_ROWS = 4;

/**
 * Tag filter chips in the server's order, collapsed to 4 rows with a "Show all (N)" toggle. A selected tag the list
 * no longer has is appended so it can still be cleared. When the selected chip would be cut, the cloud opens once.
 */
export function TagChips({
  tags, value, onChange,
}: { tags: readonly { tag: string; count: number }[]; value: string; onChange: (tag: string) => void }) {
  const row = useRef<HTMLDivElement>(null);
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  // Index of the first chip below the 4th row (-1: everything fits).
  const [cut, setCut] = useState(-1);
  // The selection already made visible (or visible anyway), so "Show less" afterwards sticks.
  const revealed = useRef('');

  const missing = !!value && !tags.some((t) => t.tag === value);
  const ordered: readonly { tag: string; count?: number }[] = missing ? [...tags, { tag: value }] : tags;
  const signature = ordered.map((t) => `${t.tag}:${t.count ?? ''}`).join('|');

  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => {
      const chips = Array.from(el.children) as HTMLElement[];
      const tops = [...new Set(chips.map((c) => c.offsetTop))].sort((a, b) => a - b);
      const limit = tops[MAX_ROWS];
      setCut(limit === undefined ? -1 : chips.findIndex((c) => c.offsetTop >= limit));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [signature]);

  // Chip 0 is "All"; tag i is chip i + 1.
  const selectedChip = value ? ordered.findIndex((t) => t.tag === value) + 1 : 0;

  useEffect(() => {
    // Nothing to collapse any more: forget an earlier "Show all".
    if (cut < 0) {
      setExpanded(false);
      return;
    }
    if (!value) revealed.current = '';
    if (!value || revealed.current === value) return;
    revealed.current = value;
    if (selectedChip >= cut) setExpanded(true);
  }, [value, cut, selectedChip]);

  const collapsible = cut >= 0;
  const collapsed = collapsible && !expanded;
  const isCut = (chip: number) => collapsed && chip >= cut;

  return (
    <div className="tag-chips">
      <div ref={row} id={id} className="t-chip-row" role="group" aria-label="Filter by tag" data-collapsed={collapsed}>
        <Chip pressed={!value} onClick={() => onChange('')} className={isCut(0) ? 't-chip--cut' : undefined}>All</Chip>
        {ordered.map((t, i) => (
          <Chip
            key={t.tag}
            pressed={value === t.tag}
            count={t.count}
            onClick={() => onChange(value === t.tag ? '' : t.tag)}
            className={isCut(i + 1) ? 't-chip--cut' : undefined}
          >
            {t.tag}
          </Chip>
        ))}
      </div>
      {collapsible && (
        <TextButton aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : `Show all (${ordered.length})`}
        </TextButton>
      )}
    </div>
  );
}
