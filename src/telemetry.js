// This plugin's own access log, shipped to Eesa.
//
// Railway printed container start lines and nothing else, so whether a device
// had even called this service was unanswerable — which was half of a nine-day
// outage: a decommissioned host and a quiet week produce identical evidence.
//
// Every request carries the client's `X-Eesa-Trace`, so a punch here lands on
// the same thread as the backend request and the tap that caused it. Three
// services, one story.
const API_BASE = (process.env.EESA_API_BASE || 'https://eesa.ai/api/v1').replace(/\/+$/, '');
const SECRET = process.env.PLUGIN_GATEWAY_SECRET || '';
const PLUGIN = process.env.PLUGIN_NAME || 'documents';
const VERSION = process.env.RAILWAY_GIT_COMMIT_SHA
  ? String(process.env.RAILWAY_GIT_COMMIT_SHA).slice(0, 12)
  : '';

// Matches the backend's rule exactly, on purpose: two halves of one log that
// sampled differently would give two different answers to "how often".
const SAMPLE_RATE = 20;
const SLOW_MS = 2000;
const SKIP = ['/health', '/favicon'];

const MAX_BUFFER = 500;   // a stranded buffer must not grow without bound
const FLUSH_EVERY_MS = 30_000;
const FLUSH_AT = 50;

let buffer = [];
let timer = null;

/** Keep it? Errors, writes and slow requests always; fast reads 1-in-N. */
export function shouldKeep({ status, durationMs, method }) {
  if (status >= 400 || durationMs >= SLOW_MS) return { keep: true, sampled: false };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(String(method || '').toUpperCase())) {
    return { keep: true, sampled: false };
  }
  return { keep: Math.floor(Math.random() * SAMPLE_RATE) === 0, sampled: true };
}

/// The route PATTERN, not the path. `/api/admin/events/:id` groups; the same
/// URL with a uuid in it makes a thousand rows that answer nothing.
export function routeOf(req) {
  const base = req.baseUrl || '';
  const path = (req.route && req.route.path) || req.path || '';
  const full = `${base}${path}` || req.originalUrl || '';
  return full.split('?')[0].slice(0, 255);
}

export async function flush() {
  if (!buffer.length || !SECRET) return;
  const batch = buffer;
  buffer = [];
  try {
    await fetch(`${API_BASE}/telemetry/plugin-requests/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Eesa-Gateway-Secret': SECRET },
      body: JSON.stringify({ requests: batch }),
    });
  } catch (e) {
    // Put them back, but never past the ceiling: a backend outage must not
    // turn into this process running out of memory.
    buffer = [...batch, ...buffer].slice(-MAX_BUFFER);
  }
}

/** Express middleware. Records on response finish; never delays a request. */
export function telemetry() {
  if (!timer && SECRET) {
    timer = setInterval(() => { flush().catch(() => {}); }, FLUSH_EVERY_MS);
    if (timer.unref) timer.unref();   // never hold the process open
  }
  return (req, res, next) => {
    if (!SECRET || SKIP.some((p) => (req.path || '').startsWith(p))) return next();
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      try {
        const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
        const { keep, sampled } = shouldKeep({
          status: res.statusCode, durationMs, method: req.method,
        });
        if (!keep) return;
        buffer.push({
          trace_id: String(req.get('X-Eesa-Trace') || '').slice(0, 64),
          at: new Date().toISOString(),
          method: req.method,
          route: routeOf(req),
          status: res.statusCode,
          duration_ms: durationMs,
          tenant_id: (req.ctx && req.ctx.tenantId) || null,
          plugin: PLUGIN,
          plugin_version: VERSION,
          sampled,
        });
        if (buffer.length >= FLUSH_AT) flush().catch(() => {});
        if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
      } catch {
        // A log row is never worth a thrown handler on a finished response.
      }
    });
    next();
  };
}
