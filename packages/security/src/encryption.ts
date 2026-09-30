import crypto from 'node:crypto';

const SENSITIVE_TOKEN_KEYS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'token',
]);

const DEFAULT_DEV_KEY = 'nexa-default-dev-encryption-key-for-local-development!';

function deriveKey(secret?: string): Buffer {
  if (process.env.NODE_ENV === 'production' && !secret && !process.env.ENCRYPTION_KEY) {
    console.warn(
      '[SECURITY WARNING] ENCRYPTION_KEY is not defined in production environment. A default fallback key is being used. Set ENCRYPTION_KEY in your production environment variables immediately!'
    );
  }
  const rawKey = secret || process.env.ENCRYPTION_KEY || DEFAULT_DEV_KEY;
  // If the secret is already 64 hex characters, convert directly to 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }
  // Otherwise derive a 32-byte key using SHA-256
  return crypto.createHash('sha256').update(rawKey).digest();
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Output format: `aes256gcm:<iv_hex>:<tag_hex>:<ciphertext_hex>`
 */
export function encryptToken(plaintext: string, secret?: string): string {
  if (!plaintext) return plaintext;
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `aes256gcm:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a ciphertext string encrypted with `encryptToken`.
 * If the string was not encrypted with this format, returns the input as-is for backward compatibility.
 */
export function decryptToken(ciphertext: string, secret?: string): string {
  if (!ciphertext || typeof ciphertext !== 'string') return ciphertext;
  if (!ciphertext.startsWith('aes256gcm:')) {
    return ciphertext;
  }

  const parts = ciphertext.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted token format.');
  }

  const [, ivHex, tagHex, encryptedHex] = parts;
  const key = deriveKey(secret);
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Encrypts sensitive fields within a token data payload before saving to database.
 */
export function encryptTokenData(
  data: Record<string, unknown>,
  secret?: string
): Record<string, unknown> {
  if (!data || typeof data !== 'object') return data;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_TOKEN_KEYS.has(key) && typeof value === 'string') {
      result[key] = encryptToken(value, secret);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = encryptTokenData(value as Record<string, unknown>, secret);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Decrypts sensitive fields within a token data payload retrieved from database.
 */
export function decryptTokenData(
  data: Record<string, unknown>,
  secret?: string
): Record<string, unknown> {
  if (!data || typeof data !== 'object') return data;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_TOKEN_KEYS.has(key) && typeof value === 'string') {
      result[key] = decryptToken(value, secret);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = decryptTokenData(value as Record<string, unknown>, secret);
    } else {
      result[key] = value;
    }
  }

  return result;
}
