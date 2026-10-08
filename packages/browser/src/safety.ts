import { SecurityViolationError, AuthState } from '@nexa/shared';

function isPrivateOrRestrictedHost(rawHostname: string): boolean {
  // Strip IPv6 square brackets if present (e.g. "[::1]" -> "::1")
  let host = rawHostname.toLowerCase().replace(/^\[|\]$/g, '').trim();

  // Handle IPv4-mapped IPv6 addresses (e.g. "::ffff:127.0.0.1" or normalized "[::ffff:7f00:1]")
  if (host.startsWith('::ffff:')) {
    const rest = host.slice(7);
    if (rest.includes('.')) {
      host = rest;
    } else {
      const hexParts = rest.split(':');
      if (hexParts.length === 2) {
        const h1 = parseInt(hexParts[0], 16) || 0;
        const h2 = parseInt(hexParts[1], 16) || 0;
        const o1 = (h1 >> 8) & 0xff;
        const o2 = h1 & 0xff;
        const o3 = (h2 >> 8) & 0xff;
        const o4 = h2 & 0xff;
        host = `${o1}.${o2}.${o3}.${o4}`;
      }
    }
  }

  // Exact blocked hostnames
  const blockedHostnames = new Set([
    'localhost',
    'metadata.google.internal',
    'instance-data',
    'metadata.azure.com',
    '::1',
  ]);
  if (blockedHostnames.has(host) || host.endsWith('.localhost')) {
    return true;
  }

  // Loopback (127.0.0.0/8) and unspecified (0.0.0.0/8)
  if (host.startsWith('127.') || host.startsWith('0.') || host === '0.0.0.0') {
    return true;
  }

  // Link-Local / Cloud Metadata (169.254.0.0/16)
  if (host.startsWith('169.254.')) {
    return true;
  }

  // Class A Private (10.0.0.0/8)
  if (host.startsWith('10.')) {
    return true;
  }

  // Class B Private (172.16.0.0/12: 172.16.x.x - 172.31.x.x)
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) {
    return true;
  }

  // Class C Private (192.168.0.0/16)
  if (host.startsWith('192.168.')) {
    return true;
  }

  // IPv6 Private & Link-Local (Unique Local fc00::/7, Link-Local fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) {
    return true;
  }

  return false;
}

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

  if (
    process.env.NODE_ENV === 'test' &&
    process.env.ALLOW_LOCAL_TEST_HOSTS === 'true' &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
  ) {
    return parsed;
  }

  if (isPrivateOrRestrictedHost(parsed.hostname)) {
    throw new SecurityViolationError(
      `Navigation to internal/private network address '${parsed.hostname}' is prohibited.`
    );
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

export interface AuthDetectionResult {
  required: boolean;
  state: AuthState;
  type?: string;
  message?: string;
}

/**
 * Detects whether an opened page requires user login, MFA, OTP, or CAPTCHA.
 */
export function detectAuthenticationRequirement(
  pageContent: string,
  currentUrl: string
): AuthDetectionResult {
  const botCheck = detectCaptchaOrBotBlock(pageContent);
  if (botCheck.detected) {
    const isBlock = botCheck.type?.toLowerCase().includes('challenge') || botCheck.type?.toLowerCase().includes('blocked');
    return {
      required: true,
      state: isBlock ? 'BLOCKED' : 'CAPTCHA_REQUIRED',
      type: botCheck.type,
      message: botCheck.message,
    };
  }

  const urlLower = currentUrl.toLowerCase();
  const contentLower = pageContent.toLowerCase();

  const isAuthUrl =
    urlLower.includes('/login') ||
    urlLower.includes('/signin') ||
    urlLower.includes('/sign-in') ||
    urlLower.includes('/auth') ||
    urlLower.includes('accounts.');

  const isAuthContent =
    contentLower.includes('please login') ||
    contentLower.includes('please log in') ||
    contentLower.includes('sign in to continue') ||
    contentLower.includes('enter your mobile number') ||
    contentLower.includes('enter mobile number to login') ||
    contentLower.includes('login / sign up') ||
    contentLower.includes('login or register') ||
    contentLower.includes('verify otp') ||
    contentLower.includes('needs you to sign in') ||
    contentLower.includes('sign in first');

  if (isAuthUrl || isAuthContent) {
    return {
      required: true,
      state: 'AUTH_REQUIRED',
      type: 'Login Required',
      message: 'Website requires user authentication before continuing.',
    };
  }

  return {
    required: false,
    state: 'AUTH_NOT_REQUIRED',
  };
}

