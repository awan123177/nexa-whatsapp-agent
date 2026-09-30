/**
 * Sensitive Data Redactor
 * Ensures that API keys, passwords, OTPs, CVVs, credit cards, and bearer tokens
 * are masked before being logged, saved, or exposed.
 */

// Regex patterns for sensitive data
const PATTERNS = [
  // Credit cards (Visa, MasterCard, Amex, etc.)
  { regex: /\b(?:\d[ -]*?){13,16}\b/g, replacement: '[REDACTED_CARD]' },
  // CVV (3 or 4 digits usually preceded by cvv/cvc)
  { regex: /\b(cvv|cvc|security\s*code)[:=]\s*(\d{3,4})\b/gi, replacement: '$1: [REDACTED_CVV]' },
  // OTPs (4 to 8 digits explicitly labeled as otp or verification code)
  { regex: /\b(otp|code|pin|verification\s*code)[:=\s]+(\d{4,8})\b/gi, replacement: '$1: [REDACTED_OTP]' },
  // Bearer tokens and JWTs
  { regex: /Bearer\s+([A-Za-z0-9_\-\.]{20,})/gi, replacement: 'Bearer [REDACTED_TOKEN]' },
  { regex: /ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: '[REDACTED_JWT]' },
  // Common API key patterns
  { regex: /(AIza[0-9A-Za-z-_]{35})/g, replacement: '[REDACTED_GEMINI_KEY]' }, // Google API key
  { regex: /(sk-[a-zA-Z0-9]{20,})/g, replacement: '[REDACTED_API_KEY]' },
  // Passwords in query, JSON, or sentences
  { regex: /\b(password|passwd|pin)\b(?:\s+is|\s*[:=])\s*([^\s,;&]+)/gi, replacement: '$1: [REDACTED_PASSWORD]' },
  { regex: /("?password"?\s*[:=]\s*)"([^"]+)"/gi, replacement: '$1"[REDACTED_PASSWORD]"' },
  { regex: /("?password"?\s*[:=]\s*)([^\s,;&]+)/gi, replacement: '$1[REDACTED_PASSWORD]' },
  // Secrets / Tokens in JSON
  { regex: /("?(secret|access_token|private_key|api_key)"?\s*[:=]\s*)"([^"]+)"/gi, replacement: '$1"[REDACTED_SECRET]"' },
];

export function redactString(input: string): string {
  if (!input || typeof input !== 'string') return input;
  let result = input;
  for (const { regex, replacement } of PATTERNS) {
    result = result.replace(regex, replacement);
  }
  return result;
}

export function redactObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    return redactString(obj) as unknown as T;
  }
  if (typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  const sensitiveKeys = new Set([
    'password',
    'passphrase',
    'secret',
    'token',
    'accesstoken',
    'access_token',
    'refreshtoken',
    'refresh_token',
    'apikey',
    'api_key',
    'otp',
    'pin',
    'cvv',
    'cvc',
    'cardnumber',
    'card_number',
    'privatekey',
    'private_key',
  ]);

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase().replace(/[_-]/g, '');
    if (sensitiveKeys.has(lowerKey)) {
      result[key] = '[REDACTED_SENSITIVE_FIELD]';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactObject(value);
    } else if (typeof value === 'string') {
      result[key] = redactString(value);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}
