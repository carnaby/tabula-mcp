import { isAgentLabel } from '../domain/validation.js';

/** Why a connection name cannot be used, or null. The same rules as an agent label: it becomes one. */
export function connectionNameProblem(name: string): string | null {
  if (name === 'human') return '"human" is reserved for what you write in the web UI';
  if (!isAgentLabel(name)) return 'a connection name is 1 to 40 lowercase letters, digits, dots, dashes or underscores';
  return null;
}

/**
 * The name the consent page proposes. claude.ai registers under a generic name, so its callback host decides;
 * otherwise a slug of what the client calls itself ("Claude Code" → "claude-code").
 */
export function suggestConnectionName(clientName: string | null, redirectUri: string): string {
  let host = '';
  try {
    host = new URL(redirectUri).hostname;
  } catch {
    // Only redirect URIs that parse reach the consent page.
  }
  if (['claude.ai', 'claude.com'].some((d) => host === d || host.endsWith(`.${d}`))) return 'claude-ai';
  const slug = (clientName ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+/, '')
    .slice(0, 40)
    .replace(/[-._]+$/, '');
  return isAgentLabel(slug) ? slug : 'app';
}

/**
 * Characters a client name may not show: controls, line and paragraph separators and every format character
 * (bidirectional overrides, zero-width characters), which would let a name display as something it is not.
 */
const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export const isDisplayableClientName = (name: string): boolean => !FORBIDDEN_NAME_CHARACTERS.test(name);

/** The client name as the consent page and the Security page show it. */
export const displayClientName = (name: string | null): string =>
  name === null || name.trim() === '' || !isDisplayableClientName(name) ? 'Unnamed app' : name;
