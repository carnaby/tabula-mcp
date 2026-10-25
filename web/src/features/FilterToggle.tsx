import { Button } from '../ui';

/** Phones only (CSS): filters fold behind this button so the list starts above the fold. */
export function FilterToggle({ open, onToggle, active }: { open: boolean; onToggle: () => void; active: number }) {
  return (
    <Button className="toolbar__toggle" icon="sliders" aria-expanded={open} onClick={onToggle} variant={active ? 'accent' : 'default'}>
      {active ? `Filters · ${active}` : 'Filters'}
    </Button>
  );
}
