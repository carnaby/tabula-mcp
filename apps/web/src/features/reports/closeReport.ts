/** The confirmation before a report is closed: what happens to its video and audio (`media` still on disk). */
export function closeReportMessage(media: number, keepMedia: boolean, purgeAfterHours: number): string {
  if (!media) return 'You can reopen it later.';
  if (keepMedia) return `Keep media is on: its ${media} video/audio file(s) stay after closing. You can reopen it later.`;
  const when = purgeAfterHours === 0 ? 'within 15 minutes of' : `${purgeAfterHours} ${purgeAfterHours === 1 ? 'hour' : 'hours'} after`;
  return `Its ${media} video/audio file(s) will be deleted ${when} closing. Photos, saved frames and the text stay. Reopen before then, or turn on Keep media, to keep them.`;
}
