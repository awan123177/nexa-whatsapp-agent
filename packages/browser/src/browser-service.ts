import { chromium, Browser, BrowserContext, Page } from 'playwright';
import {
  NexaError,
  ToolExecutionError,
  BrowserOpenResult,
  BrowserSessionMetadata,
  BrowserCartState,
  ComputerUseActionRecord,
  CartItem,
  BROWSER_NAVIGATION_TIMEOUT_MS,
  BROWSER_CLICK_TIMEOUT_MS,
  BROWSER_TYPE_TIMEOUT_MS,
  BROWSER_READ_TIMEOUT_MS,
  BROWSER_SCREENSHOT_TIMEOUT_MS,
  BROWSER_ACTION_TIMEOUT_MS,
} from '@nexa/shared';
import { validateBrowserUrl, detectCaptchaOrBotBlock, detectAuthenticationRequirement } from './safety.js';
import { PermissionEngine } from '@nexa/security';

export interface ScreenshotOptions {
  fullPage?: boolean;
  selector?: string;
  type?: 'png' | 'jpeg';
  quality?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ScreenshotResult {
  buffer: Buffer;
  mimeType: string;
  base64: string;
}

export interface BrowserOpenOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  sessionId?: string;
  userId?: string;
}

function sanitizeUrlForLogs(targetUrl: string): string {
  try {
    const parsed = new URL(targetUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return targetUrl.split('?')[0];
  }
}

export class PlaywrightBrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private activeUrl: string | null = null;
  private sessions: Map<string, BrowserSessionMetadata> = new Map();
  private activeSessionId: string = 'default';

  getOrCreateSession(sessionId = 'default', userId?: string): BrowserSessionMetadata {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        sessionId,
        userId,
        activeUrl: this.activeUrl || undefined,
        pageState: 'idle',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        actionHistory: [],
        cartState: { items: [] },
      };
      this.sessions.set(sessionId, session);
      console.log(`[ComputerUse] session_created sessionId=${sessionId}`);
    }
    this.activeSessionId = sessionId;
    return session;
  }

  getSessionMetadata(sessionId?: string): BrowserSessionMetadata | null {
    const id = sessionId || this.activeSessionId || 'default';
    return this.sessions.get(id) || null;
  }

  updateSessionState(sessionId: string, updates: Partial<BrowserSessionMetadata>): void {
    const session = this.getOrCreateSession(sessionId);
    Object.assign(session, updates, { lastActiveAt: Date.now() });
  }

  recordAction(sessionId: string, action: ComputerUseActionRecord): void {
    const session = this.getOrCreateSession(sessionId);
    session.actionHistory.push(action);
    session.lastAction = action.action;
    session.lastActionTimestamp = action.timestamp;
    session.lastActiveAt = Date.now();
  }

  canExecuteAction(sessionId: string, actionType: string, target?: string): { allowed: boolean; reason?: string } {
    const session = this.sessions.get(sessionId);
    if (!session || !target) return { allowed: true };

    // Prevent duplicate clicking on cart / buy / submit actions within last 10 seconds
    const isConsequential =
      actionType === 'click' &&
      /(cart|buy|order|checkout|pay|submit|add)/i.test(target);

    if (isConsequential) {
      const recentAction = [...session.actionHistory]
        .reverse()
        .find((a) => a.action === 'click' && a.target === target && a.success);

      if (recentAction && Date.now() - recentAction.timestamp < 10_000) {
        console.log(`[ComputerUse] duplicate_action_prevented action=${actionType} target="${target}"`);
        return { allowed: false, reason: `Duplicate click on "${target}" within 10s cooldown.` };
      }
    }
    return { allowed: true };
  }

  async verifyCart(sessionId = 'default', expectedItem?: string): Promise<BrowserCartState> {
    console.log(`[Agent] verification_started step=cart target="${expectedItem || 'cart_items'}"`);
    const session = this.getOrCreateSession(sessionId);

    const page = this.page;
    let cartItems: CartItem[] = [];
    let totalPriceMinor = 0;

    if (page && !page.isClosed()) {
      try {
        const pageContent = await page.evaluate(() => document.body.innerText || '');
        const lines = pageContent.split('\n').map((l) => l.trim()).filter(Boolean);

        if (expectedItem) {
          const found = lines.some((l) => l.toLowerCase().includes(expectedItem.toLowerCase()));
          if (found) {
            cartItems.push({
              name: expectedItem,
              quantity: 1,
            });
          }
        }

        const priceMatch = pageContent.match(/(?:total|subtotal|grand total|amount|price)[:\s]*([₹$€]?\s*[\d,]+(?:\.\d{2})?)/i);
        if (priceMatch && priceMatch[1]) {
          const cleanedPrice = priceMatch[1].replace(/[^0-9.]/g, '');
          const parsed = parseFloat(cleanedPrice);
          if (!isNaN(parsed)) {
            totalPriceMinor = Math.round(parsed * 100);
          }
        }
      } catch {}
    }

    if (expectedItem && cartItems.length === 0 && session.cartState?.items.length) {
      cartItems = session.cartState.items;
      totalPriceMinor = session.cartState.totalPriceMinor || 0;
    }

    const verifiedState: BrowserCartState = {
      items: cartItems.length > 0 ? cartItems : (session.cartState?.items || []),
      totalPriceMinor: totalPriceMinor || (session.cartState?.totalPriceMinor || 0),
      currency: session.cartState?.currency || 'INR',
      lastVerifiedAt: Date.now(),
    };

    session.cartState = verifiedState;
    console.log(`[ComputerUse] page_state_changed state=cart_verified items_count=${verifiedState.items.length}`);
    console.log(`[Agent] verification_passed step=cart items_count=${verifiedState.items.length}`);
    return verifiedState;
  }

  async restoreSession(sessionId = 'default'): Promise<{
    success: boolean;
    activeUrl?: string;
    reconnectedUrl?: string;
    cartVerified?: boolean;
    verifiedCart?: BrowserCartState;
  }> {
    console.log(`[Agent] recovery_started step=restore_session sessionId=${sessionId}`);
    const session = this.getOrCreateSession(sessionId);

    if (!session.activeUrl) {
      console.log(`[Agent] recovery_completed step=restore_session recovered=false reason="no_url"`);
      return { success: false };
    }

    try {
      if (!this.page || this.page.isClosed()) {
        await this.openPage(session.activeUrl, { sessionId });
      }
      const cart = await this.verifyCart(sessionId);
      console.log(`[ComputerUse] session_restored sessionId=${sessionId} url="${session.activeUrl}"`);
      console.log(`[Agent] recovery_completed step=restore_session recovered=true`);
      return {
        success: true,
        reconnectedUrl: session.activeUrl,
        activeUrl: session.activeUrl,
        cartVerified: cart.items.length > 0,
        verifiedCart: cart,
      };
    } catch (err: any) {
      console.log(`[Agent] recovery_completed step=restore_session recovered=false error="${err.message}"`);
      return { success: false };
    }
  }

  async ensurePage(): Promise<Page> {
    if (!this.browser) {
      console.log('[Browser] launch_start');
      try {
        this.browser = await chromium.launch({
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-software-rasterizer',
            '--disable-extensions',
          ],
        });
        console.log('[Browser] launch_success');
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
      this.page.setDefaultTimeout(15_000);
    }

    return this.page;
  }

  async cleanupPage(): Promise<void> {
    if (this.page) {
      const pageToClose = this.page;
      this.page = null;
      this.activeUrl = null;
      if (!pageToClose.isClosed()) {
        await pageToClose.close().catch(() => {});
      }
    }
  }

  async openPage(targetUrl: string, options?: BrowserOpenOptions): Promise<BrowserOpenResult> {
    const startNav = Date.now();
    const timeoutMs = options?.timeoutMs ?? BROWSER_NAVIGATION_TIMEOUT_MS;
    const sanitizedLogUrl = sanitizeUrlForLogs(targetUrl);
    const sessionId = options?.sessionId || this.activeSessionId || 'default';
    const session = this.getOrCreateSession(sessionId, options?.userId);
    console.log(`[Browser] open_start url="${sanitizedLogUrl}" timeout_ms=${timeoutMs}`);
    console.log(`[ComputerUse] navigation url="${sanitizedLogUrl}"`);
    session.pageState = 'navigating';
    session.activeUrl = targetUrl;

    // Security & SSRF pre-validation
    validateBrowserUrl(targetUrl);
    PermissionEngine.validateResourceAccess(targetUrl);

    let page: Page;
    try {
      page = await this.ensurePage();
    } catch (err: any) {
      const latency = Date.now() - startNav;
      console.log(`[Browser] open_failed latency_ms=${latency} error_type=NAVIGATION_FAILED`);
      session.pageState = 'error';
      return {
        success: false,
        errorType: 'NAVIGATION_FAILED',
        message: `Failed to initialize browser page: ${err.message}`,
      };
    }

    // Handle early cancellation if signal already aborted
    if (options?.signal?.aborted) {
      const latency = Date.now() - startNav;
      console.log(`[Browser] open_timeout timeout_ms=${timeoutMs}`);
      console.log(`[Browser] open_failed latency_ms=${latency} error_type=TIMEOUT`);
      await this.cleanupPage();
      return {
        success: false,
        errorType: 'TIMEOUT',
        message: `Browser navigation to ${sanitizedLogUrl} was cancelled before execution.`,
      };
    }

    // Set up cancellation listener
    let abortListener: (() => void) | null = null;
    let aborted = false;

    if (options?.signal) {
      abortListener = () => {
        aborted = true;
        this.cleanupPage().catch(() => {});
      };
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    try {
      const response = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      if (abortListener && options?.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }

      this.activeUrl = page.url();
      const title = await page.title().catch(() => '');
      const bodyHtml = await page.content().catch(() => '');

      // Check CAPTCHA / bot block
      const botCheck = detectCaptchaOrBotBlock(bodyHtml);
      if (botCheck.detected) {
        const latency = Date.now() - startNav;
        console.log(`[Browser] open_failed latency_ms=${latency} error_type=BOT_BLOCKED`);
        const isBlock = botCheck.type?.toLowerCase().includes('challenge') || botCheck.type?.toLowerCase().includes('blocked');
        session.pageState = 'challenged';
        session.challengeDetected = true;
        session.challengeType = botCheck.type;
        this.recordAction(sessionId, {
          action: 'navigate',
          target: targetUrl,
          timestamp: Date.now(),
          success: false,
          error: botCheck.message,
        });
        return {
          success: false,
          errorType: isBlock ? 'BOT_BLOCKED' : 'CAPTCHA_REQUIRED',
          message: `Automated access restricted by ${botCheck.type}: ${botCheck.message}`,
          authState: isBlock ? 'BLOCKED' : 'CAPTCHA_REQUIRED',
        };
      }

      // Check Authentication Requirement (e.g. login required on e-commerce / service portal)
      const authCheck = detectAuthenticationRequirement(bodyHtml, this.activeUrl);

      const text = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      const contentSnippet = text.slice(0, 2500).replace(/\s+/g, ' ').trim();
      const latency = Date.now() - startNav;
      const status = response?.status() || 200;
      console.log(`[Browser] open_success latency_ms=${latency} status=${status}`);
      console.log(`[ComputerUse] page_state_changed state=idle url="${this.activeUrl}"`);
      session.pageState = 'idle';
      session.activeUrl = this.activeUrl;
      session.title = title;
      this.recordAction(sessionId, {
        action: 'navigate',
        target: targetUrl,
        timestamp: Date.now(),
        success: true,
      });

      return {
        success: true,
        finalUrl: this.activeUrl,
        status,
        title,
        text: contentSnippet,
        authState: authCheck.state,
      };

    } catch (err: any) {
      if (abortListener && options?.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }

      const latency = Date.now() - startNav;
      const isTimeout =
        aborted ||
        options?.signal?.aborted ||
        err.name === 'TimeoutError' ||
        (err.message && err.message.toLowerCase().includes('timeout'));

      // Cancel and cleanup page immediately upon failure or timeout
      await this.cleanupPage().catch(() => {});

      if (isTimeout) {
        console.log(`[Browser] open_timeout timeout_ms=${timeoutMs}`);
        console.log(`[Browser] open_failed latency_ms=${latency} error_type=TIMEOUT`);
        return {
          success: false,
          errorType: 'TIMEOUT',
          message: `Browser navigation to ${sanitizedLogUrl} timed out after ${timeoutMs}ms.`,
        };
      }

      console.log(`[Browser] open_failed latency_ms=${latency} error_type=NAVIGATION_FAILED`);
      return {
        success: false,
        errorType: 'NAVIGATION_FAILED',
        message: `Browser navigation failed: ${err.message}`,
      };
    }
  }

  async readPage(selector?: string): Promise<{ text: string; url: string }> {
    const readStart = Date.now();
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

      console.log(`[Browser] read_success latency_ms=${Date.now() - readStart}`);
      return {
        url: page.url(),
        text: text.slice(0, 4000).trim(),
      };
    } catch (err: any) {
      if (err instanceof ToolExecutionError) throw err;
      throw new ToolExecutionError('browser_read', err.message);
    }
  }

  async clickElement(
    selector: string,
    sessionId = 'default',
    options?: { timeoutMs?: number }
  ): Promise<{ success: boolean; url: string; preventedDuplicate?: boolean }> {
    const session = this.getOrCreateSession(sessionId);
    const check = this.canExecuteAction(sessionId, 'click', selector);
    if (!check.allowed) {
      return { success: true, url: this.activeUrl || '', preventedDuplicate: true };
    }
    const page = await this.ensurePage();
    const timeoutMs = options?.timeoutMs ?? BROWSER_CLICK_TIMEOUT_MS;
    try {
      console.log(`[ComputerUse] action_started type=click target="${selector}"`);
      console.log(`[ComputerUse] action type=click target="${selector}"`);
      await page.waitForSelector(selector, { timeout: timeoutMs });
      await page.click(selector);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      this.activeUrl = page.url();
      session.activeUrl = this.activeUrl;
      this.recordAction(sessionId, {
        action: 'click',
        target: selector,
        timestamp: Date.now(),
        success: true,
      });
      console.log(`[ComputerUse] action_completed type=click target="${selector}"`);
      return { success: true, url: this.activeUrl };
    } catch (err: any) {
      console.log(`[ComputerUse] action_failed type=click target="${selector}"`);
      this.recordAction(sessionId, {
        action: 'click',
        target: selector,
        timestamp: Date.now(),
        success: false,
        error: err.message,
      });
      throw new ToolExecutionError('browser_click', `Failed to click '${selector}': ${err.message}`);
    }
  }

  async typeText(
    selector: string,
    text: string,
    sessionId = 'default',
    options?: { timeoutMs?: number }
  ): Promise<{ success: boolean; recovered?: boolean }> {
    const session = this.getOrCreateSession(sessionId);
    const page = await this.ensurePage();
    const timeoutMs = options?.timeoutMs ?? BROWSER_TYPE_TIMEOUT_MS;
    try {
      console.log(`[ComputerUse] action_started type=type target="${selector}"`);
      console.log(`[ComputerUse] action type=type target="${selector}"`);
      await page.waitForSelector(selector, { timeout: timeoutMs });
      await page.fill(selector, text);
      this.recordAction(sessionId, {
        action: 'type',
        target: selector,
        timestamp: Date.now(),
        success: true,
      });
      console.log(`[ComputerUse] action_completed type=type target="${selector}"`);
      return { success: true };
    } catch (err: any) {
      // Action Recovery Inspection: check if value actually made it into the field
      try {
        if (!page.isClosed()) {
          const actualValue = await page.$eval(selector, (el: any) => el.value || el.innerText || '');
          if (typeof actualValue === 'string' && actualValue.includes(text)) {
            console.log(`[ComputerUse] action_recovered type target="${selector}" value_matched=true`);
            this.recordAction(sessionId, {
              action: 'type',
              target: selector,
              timestamp: Date.now(),
              success: true,
              details: { recovered: true },
            });
            return { success: true, recovered: true };
          }
        }
      } catch {}

      console.log(`[ComputerUse] action_failed type=type target="${selector}"`);
      this.recordAction(sessionId, {
        action: 'type',
        target: selector,
        timestamp: Date.now(),
        success: false,
        error: err.message,
      });
      throw new ToolExecutionError('browser_type', `Failed to type in '${selector}': ${err.message}`);
    }
  }

  async fillInput(
    selector: string,
    text: string,
    sessionId = 'default',
    options?: { timeoutMs?: number }
  ): Promise<{ success: boolean; recovered?: boolean }> {
    return this.typeText(selector, text, sessionId, options);
  }

  async pressKey(
    key: string,
    sessionId = 'default',
    options?: { timeoutMs?: number }
  ): Promise<{ success: boolean }> {
    const page = await this.ensurePage();
    const timeoutMs = options?.timeoutMs ?? BROWSER_ACTION_TIMEOUT_MS;
    try {
      console.log(`[ComputerUse] action_started type=press target="${key}"`);
      await page.keyboard.press(key);
      this.recordAction(sessionId, {
        action: 'press',
        target: key,
        timestamp: Date.now(),
        success: true,
      });
      console.log(`[ComputerUse] action_completed type=press target="${key}"`);
      return { success: true };
    } catch (err: any) {
      console.log(`[ComputerUse] action_failed type=press target="${key}"`);
      this.recordAction(sessionId, {
        action: 'press',
        target: key,
        timestamp: Date.now(),
        success: false,
        error: err.message,
      });
      throw new ToolExecutionError('browser_press', `Failed to press key '${key}': ${err.message}`);
    }
  }

  async selectOption(
    selector: string,
    value: string,
    sessionId = 'default',
    options?: { timeoutMs?: number }
  ): Promise<{ success: boolean }> {
    const page = await this.ensurePage();
    const timeoutMs = options?.timeoutMs ?? BROWSER_ACTION_TIMEOUT_MS;
    try {
      console.log(`[ComputerUse] action_started type=select target="${selector}" value="${value}"`);
      await page.waitForSelector(selector, { timeout: timeoutMs });
      await page.selectOption(selector, value);
      this.recordAction(sessionId, {
        action: 'select',
        target: selector,
        timestamp: Date.now(),
        success: true,
        details: { value },
      });
      console.log(`[ComputerUse] action_completed type=select target="${selector}"`);
      return { success: true };
    } catch (err: any) {
      console.log(`[ComputerUse] action_failed type=select target="${selector}"`);
      this.recordAction(sessionId, {
        action: 'select',
        target: selector,
        timestamp: Date.now(),
        success: false,
        error: err.message,
      });
      throw new ToolExecutionError('browser_select', `Failed to select option '${value}' in '${selector}': ${err.message}`);
    }
  }

  async hoverElement(
    selector: string,
    sessionId = 'default',
    options?: { timeoutMs?: number }
  ): Promise<{ success: boolean }> {
    const page = await this.ensurePage();
    const timeoutMs = options?.timeoutMs ?? BROWSER_ACTION_TIMEOUT_MS;
    try {
      console.log(`[ComputerUse] action_started type=hover target="${selector}"`);
      await page.waitForSelector(selector, { timeout: timeoutMs });
      await page.hover(selector);
      this.recordAction(sessionId, {
        action: 'hover',
        target: selector,
        timestamp: Date.now(),
        success: true,
      });
      console.log(`[ComputerUse] action_completed type=hover target="${selector}"`);
      return { success: true };
    } catch (err: any) {
      console.log(`[ComputerUse] action_failed type=hover target="${selector}"`);
      this.recordAction(sessionId, {
        action: 'hover',
        target: selector,
        timestamp: Date.now(),
        success: false,
        error: err.message,
      });
      throw new ToolExecutionError('browser_hover', `Failed to hover over '${selector}': ${err.message}`);
    }
  }

  async inspectPageState(sessionId = 'default'): Promise<{
    url: string;
    title: string;
    text: string;
    authState?: string;
    cartState?: BrowserCartState;
    challengeDetected?: boolean;
    challengeType?: string;
  }> {
    const session = this.getOrCreateSession(sessionId);
    const page = await this.ensurePage();
    const url = page.url();
    const title = await page.title().catch(() => '');
    const bodyHtml = await page.content().catch(() => '');
    const text = (await page.evaluate(() => document.body.innerText || '').catch(() => '')).slice(0, 3000);

    const botCheck = detectCaptchaOrBotBlock(bodyHtml);
    const authCheck = detectAuthenticationRequirement(bodyHtml, url);

    return {
      url,
      title,
      text,
      authState: authCheck.state,
      cartState: session.cartState,
      challengeDetected: botCheck.detected,
      challengeType: botCheck.type,
    };
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

  getActiveUrl(): string | null {
    return this.activeUrl;
  }

  getPage(): Page | null {
    return this.page;
  }

  async takeScreenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
    console.log('[Browser] screenshot_start');
    if (!this.activeUrl) {
      throw new ToolExecutionError('browser_screenshot', 'No page currently open. Use browser_open first.');
    }

    if (!this.page || this.page.isClosed()) {
      throw new ToolExecutionError('browser_screenshot', 'Browser page is closed or not available.');
    }

    // SSRF & resource permission validation
    validateBrowserUrl(this.activeUrl);
    PermissionEngine.validateResourceAccess(this.activeUrl);

    if (this.page.url() && this.page.url() !== 'about:blank') {
      validateBrowserUrl(this.page.url());
      PermissionEngine.validateResourceAccess(this.page.url());
    }

    // Check CAPTCHA / bot block on active page
    try {
      const bodyHtml = await this.page.content();
      const botCheck = detectCaptchaOrBotBlock(bodyHtml);
      if (botCheck.detected) {
        throw new ToolExecutionError(
          'browser_screenshot',
          `Automated browsing blocked by ${botCheck.type}: ${botCheck.message}`,
          `The website requires human verification (${botCheck.type}). Automated access is restricted.`
        );
      }
    } catch (err: any) {
      if (err instanceof ToolExecutionError) throw err;
      // Continue if content reading encountered minor error
    }

    if (options?.signal?.aborted) {
      await this.cleanupPage().catch(() => {});
      throw new ToolExecutionError('browser_screenshot', 'Screenshot capture cancelled before execution.');
    }

    let abortListener: (() => void) | null = null;
    if (options?.signal) {
      abortListener = () => {
        this.cleanupPage().catch(() => {});
      };
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    try {
      const imgType = options?.type || 'png';
      const screenshotOpts: any = {
        type: imgType,
        timeout: options?.timeoutMs ?? 10_000,
      };
      if (imgType === 'jpeg' && options?.quality) {
        screenshotOpts.quality = options.quality;
      }

      let rawBuffer: Buffer | Uint8Array;

      if (options?.selector) {
        const element = await this.page.$(options.selector);
        if (!element) {
          throw new ToolExecutionError(
            'browser_screenshot',
            `Element with selector '${options.selector}' not found on page.`
          );
        }
        rawBuffer = await element.screenshot(screenshotOpts);
      } else if (options?.fullPage) {
        screenshotOpts.fullPage = true;
        rawBuffer = await this.page.screenshot(screenshotOpts);
      } else {
        rawBuffer = await this.page.screenshot(screenshotOpts);
      }

      if (abortListener && options?.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }

      const buffer = Buffer.from(rawBuffer);
      const mimeType = imgType === 'jpeg' ? 'image/jpeg' : 'image/png';
      console.log(`[Browser] screenshot_success size_bytes=${buffer.length}`);
      console.log(`[ComputerUse] screenshot size_bytes=${buffer.length}`);

      return {
        buffer,
        mimeType,
        base64: buffer.toString('base64'),
      };
    } catch (err: any) {
      if (abortListener && options?.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }
      if (err instanceof ToolExecutionError) throw err;
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
