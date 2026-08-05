// Eesa Documents auth — verify Eesa RS256 tokens via JWKS (jose) + the
// gateway-only shared-secret check. Same trust model as the Attendance plugin
// and the Python SDK.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { timingSafeEqual } from 'node:crypto';

const AUDIENCE = 'documents';
const ISSUER = process.env.EESA_TOKEN_ISSUER || 'eesa';
const GATEWAY_SECRET = process.env.PLUGIN_GATEWAY_SECRET || '';

// Checked explicitly: `new URL(undefined)` throws "Invalid URL" at import time,
// which in a container reads as an unrelated startup crash rather than a
// missing variable.
if (!process.env.EESA_JWKS_URL) {
  throw new Error('EESA_JWKS_URL is required (e.g. https://api.eesa.ai/api/v1/.well-known/jwks.json)');
}
const JWKS = createRemoteJWKSet(new URL(process.env.EESA_JWKS_URL));

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

export async function verifyToken(authHeader, { surface } = {}) {
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    throw new AuthError('missing bearer token');
  }
  const token = authHeader.slice(7).trim();
  let payload;
  try {
    ({ payload } = await jwtVerify(token, JWKS, { issuer: ISSUER, audience: AUDIENCE }));
  } catch (e) {
    throw new AuthError('token verification failed: ' + e.message);
  }
  if (surface && (payload.surface || 'mcp') !== surface) {
    throw new AuthError('wrong token surface', 403);
  }
  const tenantId = payload.tenantId || payload.tenant_id;
  if (!tenantId) throw new AuthError('token missing tenantId');
  return {
    sub: String(payload.sub || ''),
    tenantId: String(tenantId),
    scopes: payload.scopes || [],
    surface: payload.surface || 'mcp',
    email: payload.email || '',
    role: payload.role || '',
    raw: payload,
  };
}

// Fails CLOSED when the secret is unset. The manifest declares
// `auth.gatewayOnly: true`, so a missing env var must not quietly downgrade
// /mcp to "any valid Eesa token gets in" — a deploy that forgot the variable
// would look healthy while advertising a protection it no longer had.
//
// Set ALLOW_UNGATED_MCP=1 for local development against a gateway you are not
// running. It is deliberately noisy and deliberately not the default.
const ALLOW_UNGATED = process.env.ALLOW_UNGATED_MCP === '1';

if (!GATEWAY_SECRET && !ALLOW_UNGATED) {
  console.warn(
    '[auth] PLUGIN_GATEWAY_SECRET is not set — every /mcp call will be refused. ' +
    'Set it to the value held in the platform connection, or ALLOW_UNGATED_MCP=1 for local dev.',
  );
}

export function requireGateway(req) {
  if (ALLOW_UNGATED) return;
  if (!GATEWAY_SECRET) {
    throw new AuthError('plugin is not configured for gateway calls', 503);
  }
  const got = req.get('X-Eesa-Gateway-Secret');
  if (!got || !timingSafeEqualStr(got, GATEWAY_SECRET)) {
    throw new AuthError('gateway secret missing or invalid', 403);
  }
}

// Constant-time compare: a plain `!==` on a shared secret leaks its prefix a
// byte at a time to anyone who can measure the response.
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Express middleware: verify token (optionally a surface) + gateway secret.
export function authMiddleware({ surface, gatewayOnly } = {}) {
  return async (req, res, next) => {
    try {
      if (gatewayOnly) requireGateway(req);
      req.ctx = await verifyToken(req.get('Authorization'), { surface });
      next();
    } catch (e) {
      res.status(e.status || 401).json({ ok: false, error: e.message });
    }
  };
}
