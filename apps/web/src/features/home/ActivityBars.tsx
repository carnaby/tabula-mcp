import { dayLabel, isoDay } from '../../format';

const BAR = 6;
const GAP = 2;
/** A column is its bar plus the gap, so the columns tile the whole width and every one is hoverable. */
const COLUMN = BAR + GAP;
const HEIGHT = 24;
const MIN_BAR = 2;
const RADIUS = 1.5;

/** A bar anchored at the baseline with its top corners rounded. */
function barPath(x: number, h: number): string {
  const r = Math.min(RADIUS, h / 2);
  return `M${x} ${HEIGHT}V${HEIGHT - h + r}a${r} ${r} 0 0 1 ${r} ${-r}h${BAR - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}V${HEIGHT}z`;
}

const plural = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;

/**
 * Changes per day for the last days, oldest left, today right. `max` is the largest day of any project, so the bars of
 * different projects compare. Each column carries its day and count as a tooltip.
 */
export function ActivityBars({ counts, max, now = new Date() }: { counts: number[]; max: number; now?: Date }) {
  const total = counts.reduce((sum, n) => sum + n, 0);
  return (
    <svg
      className="activity-bars"
      width={counts.length * COLUMN}
      height={HEIGHT}
      viewBox={`0 0 ${counts.length * COLUMN} ${HEIGHT}`}
      role="img"
      aria-label={`${plural(total)} in the last ${counts.length} days`}
    >
      {counts.map((n, i) => {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (counts.length - 1 - i));
        const label = dayLabel(isoDay(d), now);
        const x = i * COLUMN + GAP / 2;
        const h = n > 0 && max > 0 ? Math.max(MIN_BAR, Math.round((n / max) * HEIGHT)) : 0;
        return (
          <g key={i}>
            <title>{`${label}: ${plural(n)}`}</title>
            <rect x={i * COLUMN} y={0} width={COLUMN} height={HEIGHT} fill="transparent" />
            {h > 0 ? <path d={barPath(x, h)} className="activity-bars__bar" /> : <rect x={x} y={HEIGHT - 1} width={BAR} height={1} className="activity-bars__tick" />}
          </g>
        );
      })}
    </svg>
  );
}
