import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { NexaError, ToolExecutionError } from '@nexa/shared';
import { validateBrowserUrl, detectCaptchaOrBotBlock } from './safety.js';

export class PlaywrightBrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private activeUrl: string | null = null;

  async ensurePage(): Promise<Page> {
    if (!this.browser) {
      try {
        this.browser = await chromium.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
          ],
        });
      } catch (err: any) {
        throw new NexaError(`Playwright browser initialization failed: ${err.message}`, {
          code: 'BROWSER_INIT_FAILED',
          statusCode: 500,
          userFacingMessage: 'Web browser engine is currently unavailable on this host.',
        });
      }
    }

    if (!this.context) {
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 NEXA/1.0',
      });
    }

    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(20_000);
    }

    return this.page;
  }

  async openPage(targetUrl: string): Promise<{ url: string; title: string; contentSnippet: string }> {
    validateBrowserUrl(targetUrl);
    const page = await this.ensurePage();

    try {
      const response = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 25_000,
      });

      this.activeUrl = page.url();
      const title = await page.title();
      const bodyHtml = await page.content();

      // Check CAPTCHA / bot block
      const botCheck = detectCaptchaOrBotBlock(bodyHtml);
      if (botCheck.detected) {
        throw new ToolExecutionError(
          'browser_open',
          `Automated browsing blocked by ${botCheck.type}: ${botCheck.message}`,
          `The website at ${targetUrl} requires human verification (${botCheck.type}). Automated access is restricted. Please complete this step directly.`
        );
      }

      const text = await page.evaluate(() => document.body.innerText || '');
      const contentSnippet = text.slice(0, 1500).replace(/\s+/g, ' ').trim();

      return {
        url: this.activeUrl,
        title,
        contentSnippet,
      };
    } catch (err: any) {
      if (err instanceof ToolExecutionError) throw err;
      throw new ToolExecutionError('browser_open', err.message);
    }
  }

  async readPage(selector?: string): Promise<{ text: string; url: string }> {
    const page = await this.ensurePage();
    if (!this.activeUrl) {
      throw new ToolExecutionError('browser_read', 'No page currently open. Use browser_open first.');
    }

    try {
      let text = '';
      if (selector) {
        const element = await page.$(selector);
        if (!element) {
          throw new ToolExecutionError('browser_read', `Element with selector '${selector}' not found on page.`);
        }
        text = (await element.innerText()) || '';
      } else {
        text = await page.evaluate(() => document.body.innerText || '');
      }

      return {
        url: page.url(),
        text: text.slice(0, 4000).trim(),
      };
    } catch (err: any) {
      if (err instanceof ToolExecutionError) throw err;
      throw new ToolExecutionError('browser_read', err.message);
    }
  }

  async clickElement(selector: string): Promise<{ success: boolean; url: string }> {
    const page = await this.ensurePage();
    try {
      await page.waitForSelector(selector, { timeout: 10_000 });
      await page.click(selector);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      this.activeUrl = page.url();
      return { success: true, url: this.activeUrl };
    } catch (err: any) {
      throw new ToolExecutionError('browser_click', `Failed to click '${selector}': ${err.message}`);
    }
  }

  async typeText(selector: string, text: string): Promise<{ success: boolean }> {
    const page = await this.ensurePage();
    try {
      await page.waitForSelector(selector, { timeout: 10_000 });
      await page.fill(selector, text);
      return { success: true };
    } catch (err: any) {
      throw new ToolExecutionError('browser_type', `Failed to type in '${selector}': ${err.message}`);
    }
  }

  async scrollPage(direction: 'up' | 'down', amount = 500): Promise<{ scrolled: boolean }> {
    const page = await this.ensurePage();
    try {
      const scrollY = direction === 'down' ? amount : -amount;
      await page.evaluate((y) => window.scrollBy(0, y), scrollY);
      return { scrolled: true };
    } catch (err: any) {
      throw new ToolExecutionError('browser_scroll', `Failed to scroll: ${err.message}`);
    }
  }

  async waitFor(selectorOrMs: string | number): Promise<{ success: boolean }> {
    const page = await this.ensurePage();
    try {
      if (typeof selectorOrMs === 'number') {
        const cappedMs = Math.min(Math.max(100, selectorOrMs), 15_000);
        await page.waitForTimeout(cappedMs);
      } else {
        await page.waitForSelector(selectorOrMs, { timeout: 15_000 });
      }
      return { success: true };
    } catch (err: any) {
      throw new ToolExecutionError('browser_wait', `Wait condition timed out: ${err.message}`);
    }
  }

  async takeScreenshot(): Promise<{ base64: string; mimeType: string }> {
    const page = await this.ensurePage();
    try {
      const buffer = await page.screenshot({ type: 'jpeg', quality: 75 });
      return {
        base64: buffer.toString('base64'),
        mimeType: 'image/jpeg',
      };
    } catch (err: any) {
      throw new ToolExecutionError('browser_screenshot', `Failed to take screenshot: ${err.message}`);
    }
  }

  async close(): Promise<void> {
    if (this.page && !this.page.isClosed()) {
      await this.page.close().catch(() => {});
      this.page = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.activeUrl = null;
  }
}
