const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600], ['month', 30 * 24 * 3600], ['week', 7 * 24 * 3600], ['day', 24 * 3600], ['hour', 3600], ['minute', 60],
];

export function timeAgo(iso: string, now = Date.now()): string {
  const secs = (new Date(iso).getTime() - now) / 1000;
  for (const [unit, s] of STEPS) {
    if (Math.abs(secs) >= s) return rtf.format(Math.round(secs / s), unit);
  }
  return 'just now';
}

export const fullDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const shortId = (id: string) => `#${id.slice(0, 4)}`;

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);
export const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** Markdown as one line of plain text for previews; line breaks become " · " unless a sentence ended there. */
export function excerpt(md: string, max = 180): string {
  const lines = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .split('\n')
    .map((l) => l.replace(/^\s*(#{1,6}\s+|[-+*]\s+(\[[ x]\]\s+)?|\d+\.\s+|>\s?)/, '').replace(/[*_`~]/g, '').trim())
    .filter(Boolean);
  let plain = '';
  for (const l of lines) plain += plain ? (/[.:!?;,]$/.test(plain) ? ` ${l}` : ` · ${l}`) : l;
  return plain.length > max ? `${plain.slice(0, max).trimEnd()}…` : plain;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How long ago, without "ago": "just now", "12 min", "3 h", "1 day", "3 days". Unlike timeAgo it never says "yesterday". */
export function age(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** The browser's time zone: the server cuts the days of Home where the user's days begin. */
export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const pad = (n: number) => String(n).padStart(2, '0');

/** A date as YYYY-MM-DD in the browser's zone. */
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "Today", "Yesterday", "7. 11.", or "7. 11. 2025" in another year. `date` is YYYY-MM-DD. */
export function dayLabel(date: string, now = new Date()): string {
  if (date === isoDay(now)) return 'Today';
  if (date === isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday';
  const [y, m, d] = date.split('-').map(Number);
  return y === now.getFullYear() ? `${d}. ${m}.` : `${d}. ${m}. ${y}`;
}
