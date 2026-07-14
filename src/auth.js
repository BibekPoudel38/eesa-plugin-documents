// Eesa Documents auth — verify Eesa RS256 tokens via JWKS (jose) + the
// gateway-only shared-secret check. Same trust model as the Attendance plugin
// and the Python SDK.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const AUDIENCE = 'documents';
const ISSUER = process.env.EESA_TOKEN_ISSUER || 'eesa';
const GATEWAY_SECRET = process.env.PLUGIN_GATEWAY_SECRET || '';

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

export function requireGateway(req) {
  if (!GATEWAY_SECRET) return;
  const got = req.get('X-Eesa-Gateway-Secret');
  if (!got || got !== GATEWAY_SECRET) {
    throw new AuthError('gateway secret missing or invalid', 403);
  }
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
