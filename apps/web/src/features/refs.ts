import { href } from '../router';
import type { RefTarget } from '../types';

/** The address a resolved reference opens. */
export function refHref(t: RefTarget): string {
  switch (t.type) {
    case 'thought': return href.thought(t.id);
    case 'note': return href.note(t.id);
    case 'report': return href.report(t.id);
    case 'file': return href.file(t.project ?? '', t.path ?? t.title);
    case 'memory': return href.memory(t.id);
    case 'attachment': return href.attachment(t.report_id ?? '', t.id);
  }
}
