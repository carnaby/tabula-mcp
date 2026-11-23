import { displayClientName } from '../names.js';
import { esc, page } from '../pages.js';
import type { ResourceKind } from '../settings.js';
import { isLoopbackRedirect } from './crypto.js';

/** What the owner sees before an app gets a connection (spec §3.3). Everything from the client is escaped text. */
export type ConsentView = {
  pendingId: string;
  /** As registered: unverified, possibly hostile. */
  clientName: string | null;
  /** The redirect presented and matched; it parses. */
  redirectUri: string;
  resource: ResourceKind;
  /** The connection name in the field: the suggestion, or what the owner typed. */
  name: string;
  /** A live connection already has this name: offer to replace it. */
  nameTaken: boolean;
  /** Whether that offer is ticked: on the first view, or as the owner left it when a decision was refused. */
  replace: boolean;
  error: string | null;
};

/** What a connection to each resource can do, as the owner reads it before deciding. */
const ACCESS: Record<ResourceKind, string> = {
  mcp: 'MCP (all Tabula tools)',
  api: 'REST API (tabula CLI)',
  app: 'App API: send messages to projects, save thoughts, notes and reports',
};

export function renderConsent(v: ConsentView): string {
  const loopback = isLoopbackRedirect(v.redirectUri);
  const target = loopback ? 'an app on this computer (e.g. Claude Code, the tabula CLI)' : new URL(v.redirectUri).host;
  const warning = loopback
    ? '<p class="warn">An app running on this computer is asking for access. Approve only if you are starting it yourself right now.</p>'
    : '';
  const access = ACCESS[v.resource];
  const replace = v.nameTaken
    // The box carries the name it offers to replace: a ticked box replaces only the connection it named.
    ? `<label class="check"><input type="checkbox" name="replace" value="${esc(v.name)}"${v.replace ? ' checked' : ''}> Replace the connection “${esc(v.name)}” (it stops working at once)</label>`
    : '';
  const error = v.error ? `<p class="error" role="alert">${esc(v.error)}</p>` : '';
  return page(
    'Connect an app',
    `<h1>Connect an app</h1>
<p class="muted">An app asks for access to your Tabula. Nothing happens until you decide.</p>
<section><h2>Application</h2><p><strong>${esc(displayClientName(v.clientName))}</strong></p><p class="muted">The app chose this name itself; it is not verified.</p></section>
<section><h2>Where the access goes</h2><p><strong>${esc(target)}</strong></p><p class="muted mono">${esc(v.redirectUri)}</p>${warning}</section>
<section><h2>Access</h2><p>${esc(access)}</p></section>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="pending" value="${esc(v.pendingId)}">
<label for="name">Connection name<input id="name" name="name" type="text" maxlength="40" value="${esc(v.name)}" required></label>
<p class="muted">It labels everything this app writes. You can rename it later under Security.</p>
${replace}${error}
<div class="actions"><button type="submit" name="decision" value="allow" class="primary">Allow</button><button type="submit" name="decision" value="deny" formnovalidate>Deny</button></div>
</form>`,
  );
}
