import { type ReactNode, useId, useState } from 'react';
import { Button } from '../ui';

/**
 * The toolbar of every list, always in this order: search → quick filter (e.g. Open/Done/All) → filters → sort,
 * then the primary "New …" action (at the right end on desktop, full width below on phones).
 * On phones `filters` and `sort` fold behind a Filters toggle that shows how many differ from the defaults.
 */
export function ListToolbar({
  search, quick, filters, sort, active = 0, action,
}: {
  search: ReactNode;
  /** Always visible next to the search (a segmented filter, a switch). */
  quick?: ReactNode;
  /** Folded behind the Filters toggle on phones, inline on desktop. */
  filters?: ReactNode;
  /** Folded with the filters, always after them. */
  sort?: ReactNode;
  /** How many folded filters (and sort) differ from their defaults; the toggle shows the number. */
  active?: number;
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const folded = !!(filters || sort);
  return (
    <div className="toolbar">
      {search}
      {folded && (
        <Button
          className="toolbar__toggle"
          icon="sliders"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          variant={active ? 'accent' : 'default'}
        >
          {active ? `Filters · ${active}` : 'Filters'}
        </Button>
      )}
      {quick && <div className="toolbar__quick">{quick}</div>}
      {folded && (
        <div id={id} className="toolbar__filters" data-open={open}>
          {filters}
          {sort && <div className="toolbar__sort">{sort}</div>}
        </div>
      )}
      {action && <div className="toolbar__action">{action}</div>}
    </div>
  );
}
