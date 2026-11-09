import { REF_PREFIX } from '@tabula/shared/refs';
import { badRequest } from './errors.js';

/**
 * A record id as agents and the UI pass it; `prefix` is hex without dashes (dashes and letter case never matter).
 * `tabula:` references and full uuids reach every record type. The older short form (`#a1f3` or bare hex of fewer
 * than 8 characters) is `legacy`: it keeps the scope it had when only rules, notes, thoughts and reports had ids, so a rule's short id
 * from recall cannot turn ambiguous because a file or an attachment id starts with the same characters.
 */
export type IdRef = { kind: 'full'; id: string } | { kind: 'prefix'; prefix: string; legacy: boolean };

const FULL_SCOPE_MIN_HEX = 8;

export function parseIdRef(raw: string): IdRef {
  const v = raw.trim().toLowerCase();
  const isRef = v.startsWith(REF_PREFIX);
  const body = isRef ? v.slice(REF_PREFIX.length).trim() : v.replace(/^#/, '');
  const hex = body.replace(/-/g, '');
  if (/^[0-9a-f-]+$/.test(body) && /^[0-9a-f]{4,32}$/.test(hex)) {
    if (hex.length === 32) {
      return { kind: 'full', id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` };
    }
    return { kind: 'prefix', prefix: hex, legacy: !isRef && hex.length < FULL_SCOPE_MIN_HEX };
  }
  throw badRequest(`id "${raw}" must be a reference (tabula:a1f3c2d4), a uuid or its first 4+ hex characters (e.g. #a1f3)`);
}

/** Shortest common prefix length (>= min) at which all ids are unique. */
export function shortIds(ids: readonly string[], min = 4): Map<string, string> {
  const unique = [...new Set(ids)];
  for (let len = min; len <= 36; len++) {
    const prefixes = new Set(unique.map((id) => id.slice(0, len)));
    if (prefixes.size === unique.length) return new Map(unique.map((id) => [id, id.slice(0, len)]));
  }
  return new Map(unique.map((id) => [id, id]));
}
