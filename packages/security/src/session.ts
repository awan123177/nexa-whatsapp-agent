import crypto from 'node:crypto';
import { AuthenticationError, NexaError, SecurityViolationError } from '@nexa/shared';

export interface SessionTokenPayload {
  userId: string;
  nonce: string;
  timestamp: number;
  expiresAt: number;
}

const DEFAULT_DEV_SESSION_SECRET = 'nexa-default-session-hmac-secret-key-32b!';

function resolveSessionSecret(secret?: string): string {
  if (secret) return secret;
  if (process.env.ENCRYPTION_KEY) return process.env.ENCRYPTION_KEY;
  if (process.env.WHATSAPP_APP_SECRET) return process.env.WHATSAPP_APP_SECRET;
  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '[SECURITY WARNING] Neither ENCRYPTION_KEY nor WHATSAPP_APP_SECRET is set in production. Using fallback secret.'
    );
  }
  return DEFAULT_DEV_SESSION_SECRET;
}

/**
 * Creates a signed, tamper-proof session token for user-authenticated actions
 * such as Google OAuth initiation and account management.
 *
 * @param userId - Unique user identifier
 * @param secret - Optional override secret key (defaults to ENCRYPTION_KEY)
 * @param ttlMs - Time-to-live in milliseconds (default: 1 hour)
 */
export function createSessionToken(
  userId: string,
  secret?: string,
  ttlMs = 3600_000
): string {
  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    throw new NexaError('userId must be a non-empty string to generate a session token.', {
      code: 'INVALID_USER_ID',
      statusCode: 400,
    });
  }

  const payload: SessionTokenPayload = {
    userId: userId.trim(),
    nonce: crypto.randomBytes(16).toString('hex'),
    timestamp: Date.now(),
    expiresAt: Date.now() + ttlMs,
  };

  const serialized = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const hmacSecret = resolveSessionSecret(secret);
  const signature = crypto.createHmac('sha256', hmacSecret).update(serialized).digest('base64url');

  return `${serialized}.${signature}`;
}

/**
 * Validates and decodes a signed session token.
 * Verifies HMAC-SHA256 signature with constant-time equality and enforces expiration.
 */
export function verifySessionToken(
  token: string,
  secret?: string
): SessionTokenPayload {
  if (!token || typeof token !== 'string') {
    throw new AuthenticationError('Missing or invalid session token.');
  }

  const parts = token.trim().split('.');
  if (parts.length !== 2) {
    throw new AuthenticationError('Malformed session token format.');
  }

  const [serialized, signature] = parts;
  const hmacSecret = resolveSessionSecret(secret);
  const expectedSignature = crypto
    .createHmac('sha256', hmacSecret)
    .update(serialized)
    .digest('base64url');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const actualBuffer = Buffer.from(signature, 'utf8');

  if (
    expectedBuffer.length !== actualBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw new SecurityViolationError('Session token signature verification failed. Token is invalid or tampered.');
  }

  try {
    const json = Buffer.from(serialized, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as SessionTokenPayload;

    if (!payload.userId || typeof payload.expiresAt !== 'number') {
      throw new AuthenticationError('Invalid session token payload structure.');
    }

    if (Date.now() > payload.expiresAt) {
      throw new AuthenticationError('Session token has expired. Please initiate authentication again.');
    }

    return payload;
  } catch (err: any) {
    if (err instanceof NexaError) throw err;
    throw new AuthenticationError('Failed to parse session token payload.');
  }
}

/**
 * Authenticates a request by inspecting Authorization header, query parameters, or request body.
 * Returns the verified userId.
 *
 * @throws AuthenticationError if no valid token is provided or if token is expired/invalid.
 */
export function authenticateUserRequest(
  request: {
    headers?: Record<string, string | string[] | undefined>;
    query?: any;
    body?: any;
  },
  secret?: string
): string {
  let rawToken: string | undefined;

  // 1. Inspect Authorization header (Bearer <token>)
  const authHeader = request.headers?.['authorization'] || request.headers?.['Authorization'];
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    rawToken = authHeader.slice(7).trim();
  }

  // 2. Fall back to query param (e.g. ?token=... or ?sessionToken=...)
  if (!rawToken && request.query && typeof request.query === 'object') {
    const q = request.query as Record<string, unknown>;
    const qToken = q.token || q.sessionToken;
    if (typeof qToken === 'string' && qToken.trim().length > 0) {
      rawToken = qToken.trim();
    }
  }

  // 3. Fall back to body (e.g. { token: ... } or { sessionToken: ... })
  if (!rawToken && request.body && typeof request.body === 'object') {
    const b = request.body as Record<string, unknown>;
    const bToken = b.token || b.sessionToken;
    if (typeof bToken === 'string' && bToken.trim().length > 0) {
      rawToken = bToken.trim();
    }
  }

  if (!rawToken) {
    throw new AuthenticationError(
      'Authentication required: Provide a valid session token via Authorization header (Bearer <token>) or token query/body parameter.'
    );
  }

  const payload = verifySessionToken(rawToken, secret);
  return payload.userId;
}
