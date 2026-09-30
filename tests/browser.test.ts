import { describe, it, expect, afterAll } from 'vitest';
import { PlaywrightBrowserService, validateBrowserUrl, detectCaptchaOrBotBlock } from '../packages/browser/src/index.js';
import { SecurityViolationError } from '../packages/shared/src/index.js';

describe('Playwright Browser & Safety Suite', () => {
  let browserService: PlaywrightBrowserService;

  afterAll(async () => {
    if (browserService) {
      await browserService.close();
    }
  });

  describe('SSRF & Safety Protections', () => {
    it('should reject navigation to localhost, loopback, and private IP ranges', () => {
      expect(() => validateBrowserUrl('http://localhost:8080')).toThrow(SecurityViolationError);
      expect(() => validateBrowserUrl('http://127.0.0.1:3000')).toThrow(SecurityViolationError);
      expect(() => validateBrowserUrl('http://127.0.0.2:8080')).toThrow(SecurityViolationError);
      expect(() => validateBrowserUrl('http://0.0.0.0:80')).toThrow(SecurityViolationError);
      expect(() => validateBrowserUrl('http://169.254.169.254/latest/meta-data')).toThrow(SecurityViolationError);
      expect(() => validateBrowserUrl('http://169.254.1.1')).toThrow(SecurityViolationError);
      expect(() => validateBrowserUrl('http://metadata.google.internal/computeMetadata/v1')).toThrow(SecurityViolationError);
      expect(() => validateBrowserUrl('http://192.168.1.1')).toThrow(SecurityViolationError);
      expect(() => validateBrowserUrl('http://10.0.0.1')).toThrow(SecurityViolationError);
      // Class B RFC 1918 range (172.16.0.0/12 including Docker default bridge 172.17.x.x - 172.31.x.x)
      expect(() => validateBrowserUrl('http://172.16.0.1')).toThrow(SecurityViolationError);
      expect(() => validateBrowserUrl('http://172.20.0.1')).toThrow(SecurityViolationError);
      expect(() => validateBrowserUrl('http://172.31.255.254')).toThrow(SecurityViolationError);
      // IPv6 Loopback, Link-Local, and Mapped IPv4
      expect(() => validateBrowserUrl('http://[::1]')).toThrow(SecurityViolationError);
      expect(() => validateBrowserUrl('http://[::ffff:127.0.0.1]')).toThrow(SecurityViolationError);
      expect(() => validateBrowserUrl('http://[fe80::1]')).toThrow(SecurityViolationError);
    });

    it('should reject non-HTTP/HTTPS protocols', () => {
      expect(() => validateBrowserUrl('file:///etc/passwd')).toThrow(SecurityViolationError);
      expect(() => validateBrowserUrl('ftp://ftp.example.com')).toThrow(SecurityViolationError);
      expect(() => validateBrowserUrl('javascript:alert(1)')).toThrow(SecurityViolationError);
    });

    it('should allow valid public HTTP/HTTPS URLs', () => {
      const url = validateBrowserUrl('https://example.com/search?q=test');
      expect(url.hostname).toBe('example.com');
      expect(url.protocol).toBe('https:');
    });

    it('should detect CAPTCHA and Cloudflare bot challenge patterns', () => {
      const cloudflareHtml = '<html><body><h1>Attention Required! | Cloudflare</h1><div class="cf-browser-verification"></div></body></html>';
      const check1 = detectCaptchaOrBotBlock(cloudflareHtml);
      expect(check1.detected).toBe(true);
      expect(check1.type).toBe('Cloudflare Challenge');

      const recaptchaHtml = '<div><script src="https://www.google.com/recaptcha/api.js"></script></div>';
      const check2 = detectCaptchaOrBotBlock(recaptchaHtml);
      expect(check2.detected).toBe(true);
      expect(check2.type).toBe('Google reCAPTCHA');

      const normalHtml = '<html><body><h1>Welcome to NEXA</h1><p>Clean page</p></body></html>';
      const check3 = detectCaptchaOrBotBlock(normalHtml);
      expect(check3.detected).toBe(false);
    });
  });

  describe('Chromium Browser Engine Startup', () => {
    it('should launch headless Chromium with container flags and successfully create a page', async () => {
      browserService = new PlaywrightBrowserService();
      const page = await browserService.ensurePage();
      expect(page).toBeDefined();
      expect(page.isClosed()).toBe(false);

      // Verify viewport and user agent
      const viewport = page.viewportSize();
      expect(viewport?.width).toBe(1280);
      expect(viewport?.height).toBe(800);

      // Verify basic evaluation
      const result = await page.evaluate(() => 2 + 2);
      expect(result).toBe(4);

      // Clean shutdown
      await browserService.close();
    });
  });
});
