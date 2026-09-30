import { SecurityViolationError } from '@nexa/shared';

// Prohibited hostnames and IP prefixes (SSRF protection)
const BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '169.254.169.254', // AWS/GCP metadata IP
  'metadata.google.internal',
  '10.',
  '192.168.',
  '172.16.',
  '::1',
];

export function validateBrowserUrl(targetUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new SecurityViolationError(`Invalid URL provided: ${targetUrl}`);
  }

  // Enforce HTTP / HTTPS only
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SecurityViolationError(
      `Access to protocol '${parsed.protocol}' is forbidden. Only HTTP/HTTPS is allowed.`
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  for (const blocked of BLOCKED_HOSTS) {
    if (hostname === blocked || hostname.startsWith(blocked)) {
      throw new SecurityViolationError(
        `Navigation to internal/private network address '${hostname}' is prohibited.`
      );
    }
  }

  return parsed;
}

/**
 * Checks HTML content for common CAPTCHA / bot challenge indicators.
 */
export function detectCaptchaOrBotBlock(pageContent: string): {
  detected: boolean;
  type?: string;
  message?: string;
} {
  const contentLower = pageContent.toLowerCase();

  if (
    contentLower.includes('cf-browser-verification') ||
    contentLower.includes('turnstile') ||
    contentLower.includes('cloudflare ray id') && contentLower.includes('challenge')
  ) {
    return {
      detected: true,
      type: 'Cloudflare Challenge',
      message:
        'This website is protected by Cloudflare bot protection. Automated browsing is blocked and human verification is required.',
    };
  }

  if (
    contentLower.includes('g-recaptcha') ||
    contentLower.includes('recaptcha/api.js') ||
    contentLower.includes('please solve this recaptcha')
  ) {
    return {
      detected: true,
      type: 'Google reCAPTCHA',
      message:
        'This website requires solving a Google reCAPTCHA. Automated completion is not permitted.',
    };
  }

  if (contentLower.includes('hcaptcha') || contentLower.includes('hcaptcha.com')) {
    return {
      detected: true,
      type: 'hCaptcha',
      message:
        'This website requires solving an hCaptcha. Automated completion is not permitted.',
    };
  }

  return { detected: false };
}
