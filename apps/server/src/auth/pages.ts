import type { FastifyReply } from 'fastify';

/**
 * The CSP of the sign-in, registration and consent pages: nothing but this origin's script and stylesheet, no framing.
 * No form-action: Chrome applies it to the redirect after the consent form, which goes to the app's own address.
 */
export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Text into HTML (element content or a quoted attribute). Every value from a client or a request goes through this. */
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

export function page(title: string, body: string, data: Record<string, string> = {}): string {
  const attrs = Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)} · Tabula</title>
<link rel="stylesheet" href="/auth/pages.css"><script src="/auth/passkey.js" defer></script></head>
<body${attrs}><main class="card">
${body}
</main></body></html>`;
}

export function sendPage(reply: FastifyReply, status: number, html: string): FastifyReply {
  return reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('content-security-policy', PAGE_CSP)
    .header('x-frame-options', 'DENY')
    .header('referrer-policy', 'no-referrer')
    .send(html);
}

/** A page with one message. `link.href` must be a local path the server chose, never a value from the request. */
export function messagePage(title: string, text: string, link?: { href: string; label: string }): string {
  const more = link ? `<p><a href="${esc(link.href)}">${esc(link.label)}</a></p>` : '';
  return page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>${more}`);
}

/** Where to go after signing in: a local path only (one leading slash, no "//", no backslash, no control character). */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 4096 || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return '/';
  }
  return raw;
}

export function signInPage(view: { next: string; reason: 'signin' | 'fresh'; noPasskeys: boolean }): string {
  const intro = view.reason === 'fresh'
    ? 'Confirm it is you with your passkey to continue.'
    : 'Use a passkey saved on this device, on your phone or on a security key.';
  const none = view.noPasskeys
    ? '<p class="warn">No passkey is registered yet. Open the registration link from the server log, or run <span class="mono">node dist/admin.js passkey-link</span> on the server. Until then the web app also accepts the legacy token.</p>'
    : '';
  return page(
    'Sign in',
    `<h1>Sign in to Tabula</h1>
<p class="muted">${esc(intro)}</p>${none}
<div class="actions"><button id="go" type="button" class="primary">Sign in with passkey</button></div>
<p id="status" class="muted" role="status"></p>`,
    { mode: 'signin', next: view.next, auto: view.noPasskeys ? '0' : '1' },
  );
}

export function registerPage(view: { token: string; defaultName: string; next: string }): string {
  return page(
    'Add a passkey',
    `<h1>Add a passkey</h1>
<p class="muted">Tabula signs you in with passkeys: one on this computer, one on your phone, or a security key. This page works once, for 15 minutes.</p>
<label for="name">Name of this passkey<input id="name" type="text" maxlength="60" value="${esc(view.defaultName)}"></label>
<div class="actions"><button id="go" type="button" class="primary">Create passkey</button></div>
<p id="status" class="muted" role="status"></p>`,
    { mode: 'register', token: view.token, next: view.next },
  );
}

export const PAGES_CSS = `:root{color-scheme:light dark;--fg:#1c1917;--muted:#57534e;--bg:#fafaf9;--card:#fff;--line:#e7e5e4;--accent:#b45309;--danger:#b91c1c}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f4;--muted:#a8a29e;--bg:#0f0e0d;--card:#1c1917;--line:#292524;--accent:#f59e0b;--danger:#f87171}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
.card{width:min(560px,100%);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;display:grid;gap:16px}
h1{font-size:1.4rem;margin:0}h2{font-size:1rem;margin:0 0 4px}p{margin:0}form,section{display:grid;gap:12px}
.muted{color:var(--muted)}.mono{font-family:ui-monospace,monospace;overflow-wrap:anywhere}
.warn{border-left:3px solid var(--accent);padding-left:12px}.error{color:var(--danger)}
label{display:grid;gap:4px;font-weight:600}.check{display:flex;gap:8px;align-items:center;font-weight:400}
input[type=text]{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
.actions{display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:disabled{opacity:.6;cursor:default}
`;
