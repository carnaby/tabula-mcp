const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
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
