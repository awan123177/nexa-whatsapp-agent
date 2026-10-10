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

  // 1. Cloudflare & Turnstile Challenges
  if (
    contentLower.includes('cf-browser-verification') ||
    contentLower.includes('turnstile') ||
    contentLower.includes('challenges.cloudflare.com') ||
    (contentLower.includes('cloudflare ray id') && contentLower.includes('challenge')) ||
    (contentLower.includes('just a moment...') && contentLower.includes('cloudflare'))
  ) {
    console.log('[ComputerUse] challenge_detected type="Cloudflare Challenge"');
    return {
      detected: true,
      type: 'Cloudflare Challenge',
      message:
        'This website is protected by Cloudflare bot protection. Automated browsing is blocked and human verification is required.',
    };
  }

  // 2. "Verify you are human" / Generic Human Verification
  if (
    contentLower.includes('verify you are human') ||
    contentLower.includes('verify that you are human') ||
    contentLower.includes('confirm you are human') ||
    contentLower.includes('checking your browser before accessing')
  ) {
    console.log('[ComputerUse] challenge_detected type="Human Verification Challenge"');
    return {
      detected: true,
      type: 'Human Verification Challenge',
      message:
        'This website requires interactive "Verify you are human" confirmation. Automated browsing is paused for safety.',
    };
  }

  // 3. Google reCAPTCHA
  if (
    contentLower.includes('g-recaptcha') ||
    contentLower.includes('recaptcha/api.js') ||
    contentLower.includes('please solve this recaptcha') ||
    contentLower.includes('recaptcha-anchor')
  ) {
    console.log('[ComputerUse] challenge_detected type="Google reCAPTCHA"');
    return {
      detected: true,
      type: 'Google reCAPTCHA',
      message:
        'This website requires solving a Google reCAPTCHA. Automated completion is not permitted.',
    };
  }

  // 4. hCaptcha
  if (contentLower.includes('hcaptcha') || contentLower.includes('hcaptcha.com')) {
    console.log('[ComputerUse] challenge_detected type="hCaptcha"');
    return {
      detected: true,
      type: 'hCaptcha',
      message:
        'This website requires solving an hCaptcha. Automated completion is not permitted.',
    };
  }

  // 5. Bot Protection / Access-Denied Challenges (DataDome, PerimeterX, AWS WAF, Akamai)
  if (
    contentLower.includes('datadome') ||
    contentLower.includes('perimeterx') ||
    contentLower.includes('px-captcha') ||
    contentLower.includes('geo.captcha') ||
    (contentLower.includes('access denied') && contentLower.includes('security reasons')) ||
    (contentLower.includes('blocked') && contentLower.includes('automated request'))
  ) {
    console.log('[ComputerUse] challenge_detected type="Bot Protection Challenge"');
    return {
      detected: true,
      type: 'Bot Protection Challenge',
      message:
        'Website bot protection has flagged automated browsing. Security controls require human verification.',
    };
  }

  // 6. Amazon Robot Check & CAPTCHA
  if (
    contentLower.includes('enter the characters you see below') ||
    contentLower.includes('type the characters you see in this image') ||
    contentLower.includes('sorry, we just need to make sure you\'re not a robot') ||
    contentLower.includes('validatecaptcha') ||
    contentLower.includes('amazon.com/errors/validatecaptcha') ||
    contentLower.includes('amazon.in/errors/validatecaptcha') ||
    contentLower.includes('errors/validatecaptcha') ||
    contentLower.includes('<title>robot check</title>') ||
    (contentLower.includes('robot check') && contentLower.includes('amazon'))
  ) {
    console.log('[ComputerUse] challenge_detected type="Amazon Robot Check"');
    return {
      detected: true,
      type: 'Amazon Robot Check',
      message:
        'Amazon robot check / CAPTCHA detected. Automated browsing cannot bypass this challenge and human verification is required.',
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

