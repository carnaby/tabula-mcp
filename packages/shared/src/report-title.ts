/** "Report 9. 11. 2026 14:32": the title of a report with neither title nor description, in the time zone of `now`'s getters. */
export function dateTitle(now: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `Report ${now.getDate()}. ${now.getMonth() + 1}. ${now.getFullYear()} ${two(now.getHours())}:${two(now.getMinutes())}`;
}
