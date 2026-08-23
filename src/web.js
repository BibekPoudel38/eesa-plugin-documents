// Pure helpers for the HTTP surface: HTML escaping and the signed OAuth state.
//
// They live here rather than in server.js because server.js calls app.listen()
// at import time, so anything defined there cannot be unit tested without
// starting a real server. These are the two pieces most worth testing: one
// stops script injection, the other stops callback replay.
import { encrypt, decrypt } from './crypto.js';

/** How long a signed state stays usable. Encryption makes it tamper-proof, not
 *  single-use — without an expiry a captured callback URL could be replayed to
 *  re-bind a drive long after the admin who started the flow had left. */
export const STATE_TTL_MS = 10 * 60 * 1000;

/** Escape for HTML text context. Everything interpolated into the callback
 *  pages is attacker-reachable: the provider puts `error` straight into the
 *  query string, and a crafted link would otherwise run script on our origin. */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function makeState(tenantId, sub, provider) {
  return encodeURIComponent(
    encrypt(JSON.stringify({ t: tenantId, s: sub, p: provider, ts: Date.now() })),
  );
}

/** Returns the decoded state, or null if it is malformed, tampered with, or
 *  older than STATE_TTL_MS. Callers must not distinguish those cases to the
 *  user — see the single "Link expired" message in server.js. */
export function readState(state, { now = Date.now() } = {}) {
  try {
    const st = JSON.parse(decrypt(decodeURIComponent(String(state || ''))));
    if (!st || typeof st.ts !== 'number' || now - st.ts > STATE_TTL_MS) return null;
    return st;
  } catch {
    return null;
  }
}

/** The shell of the small standalone pages shown after an OAuth redirect.
 *  `title` is always a literal from server.js; `bodyHtml` is pre-escaped by the
 *  caller, which is what lets the success page keep its <b> tag. */
export function page(title, bodyHtml) {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title><body style="font-family:system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#0b1020;color:#e6e9f0">
  <div style="max-width:420px;text-align:center;padding:24px"><h2 style="margin:0 0 8px">${esc(title)}</h2>
  <p style="opacity:.8;line-height:1.5">${bodyHtml}</p></div>`;
}


/** Which single folder a caller asked to browse, from `?scope=`.
 *
 *  Returns `undefined` for "no filter — use the caller's own readable set",
 *  a scope string to narrow to one folder, or `null` for REFUSED.
 *
 *  A master admin may open anybody's folder — that is what master means. A
 *  member may name only their own folder or Shared. Anything else is refused
 *  outright rather than quietly falling back to their own set: silently
 *  widening a request somebody was not allowed to make is how a UI ends up
 *  showing the wrong person's files and nobody notices.
 *
 *  Lives here rather than in server.js for the same reason `esc` and
 *  `readState` do — server.js calls app.listen() at import time, so anything
 *  defined there cannot be unit tested without starting a real server. This is
 *  a permission boundary; it has to be testable.
 */
export function requestedScope(raw, { master = false, mine = '' } = {}) {
  const want = String(raw || '').trim();
  if (!want) return undefined;
  if (master) return want;
  if (want === 'shared') return want;
  if (mine && want === mine) return want;
  return null;
}
