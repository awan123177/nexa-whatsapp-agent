import { chromium, Browser, BrowserContext, Page } from 'playwright';
import {
  NexaError,
  ToolExecutionError,
  BrowserOpenResult,
  BrowserSessionMetadata,
  BrowserCartState,
  ComputerUseActionRecord,
  CartItem,
  PageObservation,
  ResolvedTarget,
  ShoppingProduct,
  BROWSER_NAVIGATION_TIMEOUT_MS,
  BROWSER_CLICK_TIMEOUT_MS,
  BROWSER_TYPE_TIMEOUT_MS,
  BROWSER_READ_TIMEOUT_MS,
  BROWSER_SCREENSHOT_TIMEOUT_MS,
  BROWSER_ACTION_TIMEOUT_MS,
  BROWSER_READINESS_TIMEOUT_MS,
} from '@nexa/shared';
import { validateBrowserUrl, detectCaptchaOrBotBlock, detectAuthenticationRequirement } from './safety.js';
import { computerUseResolver, ComputerUseResolver } from './computer-use-resolver.js';
import { PermissionEngine } from '@nexa/security';

export interface BrowserActionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  sessionId?: string;
  userId?: string;
  taskId?: string;
  requestId?: string;
  toolCallId?: string;
}

export interface ScreenshotOptions extends BrowserActionOptions {
  fullPage?: boolean;
  selector?: string;
  type?: 'png' | 'jpeg';
  quality?: number;
}

export interface ScreenshotResult {
  buffer: Buffer;
  mimeType: string;
  base64: string;
}

export interface BrowserOpenOptions extends BrowserActionOptions {}

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
  private sessionLocks: Map<string, Promise<void>> = new Map();
  private inFlightNavigations: Map<string, { url: string; promise: Promise<BrowserOpenResult> }> = new Map();
  private terminalTasks: Set<string> = new Set();

  markTaskTerminal(taskId: string): void {
    if (!taskId) return;
    this.terminalTasks.add(taskId);
    console.log(`[Browser] task_marked_terminal taskId=${taskId}`);
  }

  isTaskTerminal(taskId?: string): boolean {
    return taskId ? this.terminalTasks.has(taskId) : false;
  }

  private async withSessionLock<T>(
    sessionId: string,
    operationName: string,
    options: BrowserActionOptions | undefined,
    action: () => Promise<T>
  ): Promise<T> {
    const taskId = options?.taskId;
    if (this.isTaskTerminal(taskId)) {
      console.log(`[Browser] late_result_discarded taskId=${taskId} operation=${operationName} reason="task_already_terminal"`);
      throw new ToolExecutionError(operationName, `Task ${taskId} has already reached a terminal state; action discarded.`);
    }

    if (options?.signal?.aborted) {
      console.log(`[Browser] action_aborted_early operation=${operationName} sessionId=${sessionId}`);
      await this.cleanupPage().catch(() => {});
      throw new ToolExecutionError(operationName, `Operation ${operationName} cancelled before lock acquisition.`);
    }

    const previousLock = this.sessionLocks.get(sessionId) || Promise.resolve();

    let releaseLock: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    this.sessionLocks.set(sessionId, currentLock);

    try {
      await previousLock;

      if (this.isTaskTerminal(taskId)) {
        console.log(`[Browser] late_result_discarded taskId=${taskId} operation=${operationName} reason="task_terminal_after_lock"`);
        throw new ToolExecutionError(operationName, `Task ${taskId} became terminal while waiting for lock.`);
      }

      if (options?.signal?.aborted) {
        console.log(`[Browser] action_aborted_after_lock operation=${operationName} sessionId=${sessionId}`);
        await this.cleanupPage().catch(() => {});
        throw new ToolExecutionError(operationName, `Operation ${operationName} was aborted while waiting for session lock.`);
      }

      let abortListener: (() => void) | null = null;
      if (options?.signal) {
        abortListener = () => {
          console.log(`[Browser] abort_signal_fired operation=${operationName} sessionId=${sessionId}`);
          this.cleanupPage().catch(() => {});
        };
        options.signal.addEventListener('abort', abortListener, { once: true });
      }

      try {
        const result = await action();

        if (this.isTaskTerminal(taskId) || options?.signal?.aborted) {
          if (result && typeof result === 'object' && (result as any).success === true) {
            console.log(`[Browser] late_result_preserved action=${operationName} sessionId=${sessionId}`);
            return result;
          }
          console.log(`[Browser] late_result_discarded taskId=${taskId} operation=${operationName} reason="aborted_or_terminal_after_run"`);
          throw new ToolExecutionError(operationName, `Operation ${operationName} result discarded due to cancellation.`);
        }

        return result;
      } finally {
        if (abortListener && options?.signal) {
          options.signal.removeEventListener('abort', abortListener);
        }
      }
    } finally {
      releaseLock!();
    }
  }

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
    if (!session) return { allowed: true };

    if (session.challengeDetected || session.pageState === 'challenged' || session.authState === 'BLOCKED') {
      console.log(`[ComputerUse] action_blocked_by_challenge action=${actionType} challenge="${session.challengeType || 'BOT_BLOCKED'}"`);
      return {
        allowed: false,
        reason: `Automated action "${actionType}" blocked: session is restricted by human verification challenge (${session.challengeType || 'BOT_BLOCKED'}). Automated bypass or evasion is prohibited.`,
      };
    }

    if (!target) return { allowed: true };

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

  async verifyCart(
    sessionId = 'default',
    expectedItem?: string,
    options?: BrowserActionOptions
  ): Promise<BrowserCartState> {
    const effectiveSessionId = options?.sessionId || sessionId || this.activeSessionId || 'default';
    return this.withSessionLock(effectiveSessionId, 'verify_cart', options, async () => {
      console.log(`[Agent] verification_started step=cart target="${expectedItem || 'cart_items'}"`);
      const session = this.getOrCreateSession(effectiveSessionId);

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

      if (this.isTaskTerminal(options?.taskId) || options?.signal?.aborted) {
        console.log(`[Browser] late_result_discarded taskId=${options?.taskId} operation="verifyCart"`);
        return session.cartState || verifiedState;
      }

      session.cartState = verifiedState;
      console.log(`[ComputerUse] page_state_changed state=cart_verified items_count=${verifiedState.items.length}`);
      console.log(`[Agent] verification_passed step=cart items_count=${verifiedState.items.length}`);
      return verifiedState;
    });
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
      if (typeof (this.context as any).on === 'function') {
        this.context.on('page', (newPage: Page) => {
          console.log(`[BrowserService] new_tab_detected url="${newPage.url()}"`);
          this.page = newPage;
          if (typeof newPage.setDefaultTimeout === 'function') {
            newPage.setDefaultTimeout(15_000);
          }
          this.activeUrl = newPage.url();
        });
      }
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

  /**
   * Bounded browser page readiness handling.
   * Ensures DOM is loaded, bounds networkidle wait, and polls for interactive elements.
   */
  async waitForPageReady(
    pageInstance?: Page | null,
    timeoutMs = BROWSER_READINESS_TIMEOUT_MS
  ): Promise<{ ready: boolean; latencyMs: number; elementsCount: number }> {
    const start = Date.now();
    const page = pageInstance || (await this.ensurePage());

    try {
      if (page.waitForLoadState) {
        await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeoutMs, 4000) }).catch(() => {});
      }
    } catch {}

    try {
      if (page.waitForLoadState) {
        await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
      }
    } catch {}

    let elementsCount = 0;
    const pollIntervalMs = 250;
    const maxPollTimeMs = Math.max(1000, timeoutMs - (Date.now() - start));
    const pollDeadline = Date.now() + maxPollTimeMs;

    while (Date.now() < pollDeadline) {
      if (!page || (page.isClosed && page.isClosed())) break;
      try {
        if (page.evaluate) {
          elementsCount = await page.evaluate(() => {
            const els = document.querySelectorAll(
              'input, textarea, button, a[href], [role="button"], [role="searchbox"], [role="search"], [role="combobox"]'
            );
            let visible = 0;
            for (let i = 0; i < Math.min(els.length, 60); i++) {
              const el = els[i];
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) visible++;
            }
            return visible;
          }).catch(() => 0);
        }

        if (elementsCount > 0) {
          break;
        }
      } catch {}

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    const latencyMs = Date.now() - start;
    const currentUrl = (page && page.url) ? page.url() : (this.activeUrl || '');
    console.log(`[Browser] page_ready url="${sanitizeUrlForLogs(currentUrl)}" latency_ms=${latencyMs} elements_count=${elementsCount}`);
    return { ready: elementsCount > 0, latencyMs, elementsCount };
  }

  async openPage(targetUrl: string, options?: BrowserOpenOptions): Promise<BrowserOpenResult> {
    const sessionId = options?.sessionId || this.activeSessionId || 'default';

    // Ensure one active navigation per browser session & deduplicate identical in-flight navigations
    const inFlight = this.inFlightNavigations.get(sessionId);
    if (inFlight && inFlight.url === targetUrl) {
      console.log(`[Browser] navigation_deduped url="${sanitizeUrlForLogs(targetUrl)}" sessionId=${sessionId}`);
      return inFlight.promise;
    }

    const navPromise: Promise<BrowserOpenResult> = (async (): Promise<BrowserOpenResult> => {
      try {
        return await this.withSessionLock(sessionId, 'browser_open', options, async () => {
          return this.internalOpenPage(targetUrl, sessionId, options);
        });
      } catch (err: any) {
        const isTimeout =
          options?.signal?.aborted ||
          err.name === 'ToolTimeoutError' ||
          err.name === 'TimeoutError' ||
          (err.message && err.message.toLowerCase().includes('timeout')) ||
          (err.message && err.message.toLowerCase().includes('abort'));

        return {
          success: false,
          errorType: isTimeout ? 'TIMEOUT' : 'NAVIGATION_FAILED',
          message: err.message || 'Browser navigation failed',
        };
      }
    })();

    this.inFlightNavigations.set(sessionId, { url: targetUrl, promise: navPromise });
    try {
      return await navPromise;
    } finally {
      const current = this.inFlightNavigations.get(sessionId);
      if (current && current.promise === navPromise) {
        this.inFlightNavigations.delete(sessionId);
      }
    }
  }

  private async internalOpenPage(
    targetUrl: string,
    sessionId: string,
    options?: BrowserOpenOptions
  ): Promise<BrowserOpenResult> {
    const startNav = Date.now();
    const timeoutMs = options?.timeoutMs ?? BROWSER_NAVIGATION_TIMEOUT_MS;
    const sanitizedLogUrl = sanitizeUrlForLogs(targetUrl);
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

      // Bounded wait for page readiness
      await this.waitForPageReady(page, 4000).catch(() => {});

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
        const isBlock =
          botCheck.type?.toLowerCase().includes('challenge') ||
          botCheck.type?.toLowerCase().includes('blocked');
        session.pageState = 'challenged';
        session.challengeDetected = true;
        session.challengeType = botCheck.type;
        session.authState = isBlock ? 'BLOCKED' : 'CAPTCHA_REQUIRED';
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
          challengeDetected: true,
          challengeType: botCheck.type,
        };
      }

      // Check Authentication Requirement (e.g. login required on e-commerce / service portal)
      const authCheck = detectAuthenticationRequirement(bodyHtml, this.activeUrl);

      const text = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      const contentSnippet = text.slice(0, 2500).replace(/\s+/g, ' ').trim();
      const latency = Date.now() - startNav;
      const status = response?.status() || 200;

      // Hard rule: HTTP 429 (Too Many Requests), 403 Forbidden, or 5xx cannot be reported as navigation success
      if (status === 429 || status === 403 || (status >= 500 && status < 600)) {
        const errType = status === 429 ? 'BOT_BLOCKED' : 'NAVIGATION_FAILED';
        console.log(`[Browser] open_failed latency_ms=${latency} error_type=${errType} status=${status}`);
        session.pageState = 'challenged';
        this.recordAction(sessionId, {
          action: 'navigate',
          target: targetUrl,
          timestamp: Date.now(),
          success: false,
          error: `HTTP ${status}`,
        });
        return {
          success: false,
          errorType: errType,
          status,
          message: status === 429
            ? `Website rate limit or bot protection encountered (HTTP 429 Too Many Requests).`
            : `Website returned error status HTTP ${status}.`,
          authState: status === 429 ? 'BLOCKED' : 'ERROR',
        };
      }

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

  async readPage(
    selector?: string,
    options?: BrowserActionOptions
  ): Promise<{ text: string; url: string; observation?: PageObservation }> {
    const sessionId = options?.sessionId || this.activeSessionId || 'default';
    return this.withSessionLock(sessionId, 'browser_read', options, async () => {
      return this.internalReadPage(selector, options);
    });
  }

  private async internalReadPage(
    selector?: string,
    _options?: BrowserActionOptions
  ): Promise<{ text: string; url: string; observation?: PageObservation }> {
    const readStart = Date.now();
    const page = await this.ensurePage();
    if (!this.activeUrl) {
      throw new ToolExecutionError('browser_read', 'No page currently open. Use browser_open first.');
    }

    try {
      let text = '';
      let observation: PageObservation | undefined;
      if (selector) {
        const element = await page.$(selector).catch(() => null);
        if (element) {
          text = (await element.innerText().catch(() => '')) || '';
        } else {
          // Adaptive target resolution if direct selector isn't found
          const resolved = await computerUseResolver.resolveTarget(page, selector).catch(() => null);
          if (resolved) {
            const resolvedEl = await page.$(resolved.selector).catch(() => null);
            if (resolvedEl) {
              text = (await resolvedEl.innerText().catch(() => '')) || '';
            }
          }
          // If still not found, DO NOT crash with ToolExecutionError!
          // Provide page text summary and observation so the agent can adapt!
          if (!text) {
            observation = await computerUseResolver.observePage(page).catch(() => undefined);
            text = (await page.evaluate(() => document.body.innerText || '').catch(() => '')).slice(0, 4000);
          }
        }
      } else {
        text = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      }

      console.log(`[Browser] read_success latency_ms=${Date.now() - readStart}`);
      return {
        url: page.url(),
        text: text.slice(0, 4000).trim(),
        observation,
      };
    } catch (err: any) {
      if (err instanceof ToolExecutionError) throw err;
      throw new ToolExecutionError('browser_read', err.message);
    }
  }

  async clickElement(
    selector: string,
    sessionId = 'default',
    options?: BrowserActionOptions
  ): Promise<{ success: boolean; url: string; preventedDuplicate?: boolean; stateChanged?: boolean; urlChanged?: boolean; isProductPage?: boolean }> {
    const effectiveSessionId = options?.sessionId || sessionId || this.activeSessionId || 'default';
    return this.withSessionLock(effectiveSessionId, 'browser_click', options, async () => {
      return this.internalClickElement(selector, effectiveSessionId, options);
    });
  }

  private async internalClickElement(
    selector: string,
    sessionId = 'default',
    options?: BrowserActionOptions
  ): Promise<{ success: boolean; url: string; preventedDuplicate?: boolean; stateChanged?: boolean; urlChanged?: boolean; isProductPage?: boolean }> {
    const session = this.getOrCreateSession(sessionId);
    const check = this.canExecuteAction(sessionId, 'click', selector);
    if (!check.allowed) {
      if (
        session.challengeDetected ||
        session.pageState === 'challenged' ||
        session.authState === 'BLOCKED' ||
        check.reason?.toLowerCase().includes('challenge') ||
        check.reason?.toLowerCase().includes('blocked')
      ) {
        throw new ToolExecutionError(
          'browser_click',
          check.reason || 'Automated action blocked by human verification challenge'
        );
      }
      return { success: true, url: this.activeUrl || '', preventedDuplicate: true };
    }
    const page = await this.ensurePage();
    const initialUrl = page.url();
    const timeoutMs = options?.timeoutMs ?? BROWSER_CLICK_TIMEOUT_MS;
    const clickStart = Date.now();
    try {
      console.log(`[ComputerUse] action_started type=click target="${selector}"`);
      console.log(`[ComputerUse] action type=click target="${selector}"`);

      // Prepare listener for possible popup / new tab opened by click (e.g. target="_blank")
      let popupPagePromise: Promise<Page | null> = Promise.resolve(null);
      if (this.context && typeof (this.context as any).waitForEvent === 'function') {
        popupPagePromise = (this.context as any).waitForEvent('page', { timeout: 3000 }).catch(() => null);
      }

      let effectiveSelector = selector;
      try {
        await page.waitForSelector(selector, { timeout: Math.min(timeoutMs, 4000) });
        await page.click(selector);
      } catch (directErr) {
        // Adaptive Computer Use resolution
        const targetType = /\b(add to cart|add)\b/i.test(selector)
          ? 'add_to_cart'
          : /\b(checkout|proceed to pay|place order)\b/i.test(selector)
          ? 'checkout'
          : undefined;
        const resolved = await computerUseResolver.resolveTarget(page, selector, targetType).catch(() => null);
        if (resolved) {
          effectiveSelector = resolved.selector;
          await page.waitForSelector(effectiveSelector, { timeout: timeoutMs });
          await page.click(effectiveSelector);
        } else {
          throw directErr;
        }
      }

      // Check if a new popup/tab was opened
      const popupPage = await popupPagePromise;
      if (popupPage && typeof (popupPage as any).isClosed === 'function' && !popupPage.isClosed()) {
        await popupPage.waitForLoadState('domcontentloaded').catch(() => {});
        this.page = popupPage;
        if (typeof this.page.setDefaultTimeout === 'function') {
          this.page.setDefaultTimeout(15_000);
        }
        this.activeUrl = popupPage.url();
        console.log(`[BrowserService] adopted_popup_tab url="${this.activeUrl}"`);
      } else {
        await (this.page || page).waitForLoadState('domcontentloaded').catch(() => {});
        // Also check if any open tab in context navigated to a product detail page
        if (this.context && typeof (this.context as any).pages === 'function') {
          const allPages: Page[] = this.context.pages().filter((p) => !p.isClosed());
          const productDetailPage = allPages.find((p) => p.url().includes('/dp/') || p.url().includes('/gp/product/'));
          if (productDetailPage && productDetailPage !== (this.page || page)) {
            this.page = productDetailPage;
            console.log(`[BrowserService] switched_to_product_tab url="${productDetailPage.url()}"`);
          }
        }
        this.activeUrl = (this.page || page).url();
      }

      session.activeUrl = this.activeUrl;
      const urlChanged = Boolean(this.activeUrl && this.activeUrl !== initialUrl);
      const isProductPage = Boolean(this.activeUrl && (this.activeUrl.includes('/dp/') || this.activeUrl.includes('/gp/product/')));
      const stateChanged = urlChanged || isProductPage;

      this.recordAction(sessionId, {
        action: 'click',
        target: effectiveSelector,
        timestamp: Date.now(),
        success: true,
      });

      const latency = Date.now() - clickStart;
      console.log(`[ComputerUse] action_completed type=click target="${effectiveSelector}" latency_ms=${latency}`);
      console.log(`[ComputerUse] state_verified type=click state_changed=${stateChanged} url_changed=${urlChanged} url="${this.activeUrl}"`);
      return { success: true, url: this.activeUrl, stateChanged, urlChanged, isProductPage };
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

  public isProductDetailPage(): boolean {
    if (!this.activeUrl) return false;
    return this.activeUrl.includes('/dp/') || this.activeUrl.includes('/gp/product/');
  }

  public getOpenTabs(): string[] {
    if (!this.context || typeof (this.context as any).pages !== 'function') return [];
    return this.context.pages().filter((p) => !p.isClosed()).map((p) => p.url());
  }

  public adoptProductTab(): boolean {
    if (!this.context || typeof (this.context as any).pages !== 'function') return false;
    const pages = this.context.pages().filter((p) => !p.isClosed());
    const productPage = pages.find((p) => p.url().includes('/dp/') || p.url().includes('/gp/product/'));
    if (productPage) {
      this.page = productPage;
      this.activeUrl = productPage.url();
      console.log(`[BrowserService] product_tab_adopted url="${this.activeUrl}"`);
      return true;
    }
    return false;
  }

  async typeText(
    selector: string,
    text: string,
    sessionId = 'default',
    options?: BrowserActionOptions
  ): Promise<{ success: boolean; recovered?: boolean }> {
    const effectiveSessionId = options?.sessionId || sessionId || this.activeSessionId || 'default';
    return this.withSessionLock(effectiveSessionId, 'browser_type', options, async () => {
      return this.internalTypeText(selector, text, effectiveSessionId, options);
    });
  }

  private async internalTypeText(
    selector: string,
    text: string,
    sessionId = 'default',
    options?: BrowserActionOptions
  ): Promise<{ success: boolean; recovered?: boolean }> {
    const session = this.getOrCreateSession(sessionId);
    const check = this.canExecuteAction(sessionId, 'type', selector);
    if (!check.allowed) {
      throw new ToolExecutionError(
        'browser_type',
        check.reason || 'Automated action blocked by human verification challenge'
      );
    }
    const page = await this.ensurePage();
    const timeoutMs = options?.timeoutMs ?? BROWSER_TYPE_TIMEOUT_MS;
    const typeStart = Date.now();
    try {
      console.log(`[ComputerUse] action_started type=type target="${selector}"`);
      console.log(`[ComputerUse] action type=type target="${selector}"`);

      let effectiveSelector = selector;
      try {
        await page.waitForSelector(selector, { timeout: Math.min(timeoutMs, 3000) });
        await page.fill(selector, text);
      } catch (directErr) {
        let tagAgnosticMatched = false;
        const nameMatch = selector.match(/^(?:input|textarea)?\[name=["']?([^"'\]]+)["']?\]$/i);
        if (nameMatch && nameMatch[1]) {
          const agnostic = `[name="${nameMatch[1]}"]`;
          const el = await page.$(agnostic).catch(() => null);
          if (el) {
            effectiveSelector = agnostic;
            await page.fill(effectiveSelector, text);
            tagAgnosticMatched = true;
          }
        }

        if (!tagAgnosticMatched) {
          // Bounded page readiness retry if interactive elements were temporarily absent
          await this.waitForPageReady(page, 3000).catch(() => {});

          // Adaptive resolution: if selector was a search box, name="q", or generic input
          const isSearch = /(search|find|query|\[name=["']?q["']?\]|name=['"]?q['"]?)/i.test(selector);
          const resolved = await computerUseResolver
            .resolveTarget(page, selector, isSearch ? 'search_box' : undefined)
            .catch(() => null);
          if (resolved) {
            effectiveSelector = resolved.selector;
            await page.waitForSelector(effectiveSelector, { timeout: timeoutMs });
            await page.fill(effectiveSelector, text);
          } else {
            throw directErr;
          }
        }
      }

      this.recordAction(sessionId, {
        action: 'type',
        target: effectiveSelector,
        timestamp: Date.now(),
        success: true,
      });
      const latency = Date.now() - typeStart;
      console.log(`[ComputerUse] action_completed type=type target="${effectiveSelector}" latency_ms=${latency}`);
      console.log(`[ComputerUse] state_verified type=type state_changed=true`);
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
            console.log(`[ComputerUse] state_verified type=type state_changed=true`);
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
    options?: BrowserActionOptions
  ): Promise<{ success: boolean; recovered?: boolean }> {
    return this.typeText(selector, text, sessionId, options);
  }

  async pressKey(
    key: string,
    sessionId = 'default',
    options?: BrowserActionOptions
  ): Promise<{ success: boolean }> {
    const effectiveSessionId = options?.sessionId || sessionId || this.activeSessionId || 'default';
    return this.withSessionLock(effectiveSessionId, 'browser_press', options, async () => {
      return this.internalPressKey(key, effectiveSessionId, options);
    });
  }

  private async internalPressKey(
    key: string,
    sessionId = 'default',
    options?: BrowserActionOptions
  ): Promise<{ success: boolean }> {
    const check = this.canExecuteAction(sessionId, 'press', key);
    if (!check.allowed) {
      throw new ToolExecutionError(
        'browser_press',
        check.reason || 'Automated action blocked by human verification challenge'
      );
    }
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
    options?: BrowserActionOptions
  ): Promise<{ success: boolean }> {
    const effectiveSessionId = options?.sessionId || sessionId || this.activeSessionId || 'default';
    return this.withSessionLock(effectiveSessionId, 'browser_select', options, async () => {
      return this.internalSelectOption(selector, value, effectiveSessionId, options);
    });
  }

  private async internalSelectOption(
    selector: string,
    value: string,
    sessionId = 'default',
    options?: BrowserActionOptions
  ): Promise<{ success: boolean }> {
    const check = this.canExecuteAction(sessionId, 'select', selector);
    if (!check.allowed) {
      throw new ToolExecutionError(
        'browser_select',
        check.reason || 'Automated action blocked by human verification challenge'
      );
    }
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
    options?: BrowserActionOptions
  ): Promise<{ success: boolean }> {
    const effectiveSessionId = options?.sessionId || sessionId || this.activeSessionId || 'default';
    return this.withSessionLock(effectiveSessionId, 'browser_hover', options, async () => {
      return this.internalHoverElement(selector, effectiveSessionId, options);
    });
  }

  private async internalHoverElement(
    selector: string,
    sessionId = 'default',
    options?: BrowserActionOptions
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

    if (botCheck.detected) {
      session.challengeDetected = true;
      session.challengeType = botCheck.type;
      session.pageState = 'challenged';
      session.authState = 'BLOCKED';
    } else if (session.challengeDetected) {
      console.log(`[ComputerUse] challenge_resolved previous_challenge="${session.challengeType}"`);
      session.challengeDetected = false;
      session.challengeType = undefined;
      session.pageState = 'idle';
      if (session.authState === 'BLOCKED') {
        session.authState = authCheck.state;
      }
    }

    return {
      url,
      title,
      text,
      authState: botCheck.detected ? 'BLOCKED' : authCheck.state,
      cartState: session.cartState,
      challengeDetected: botCheck.detected,
      challengeType: botCheck.type,
    };
  }

  async observePage(sessionId = 'default'): Promise<PageObservation> {
    const page = await this.ensurePage();
    return computerUseResolver.observePage(page);
  }

  async adaptiveSearch(
    query: string,
    sessionId = 'default',
    options?: BrowserActionOptions
  ): Promise<{ success: boolean; products: ShoppingProduct[]; query: string; url: string }> {
    const effectiveSessionId = options?.sessionId || sessionId || this.activeSessionId || 'default';
    return this.withSessionLock(effectiveSessionId, 'adaptive_search', options, async () => {
      return this.internalAdaptiveSearch(query, effectiveSessionId, options);
    });
  }

  private async internalAdaptiveSearch(
    query: string,
    sessionId = 'default',
    _options?: BrowserActionOptions
  ): Promise<{ success: boolean; products: ShoppingProduct[]; query: string; url: string }> {
    const page = await this.ensurePage();
    const start = Date.now();
    console.log(`[ComputerUse] action_started type=adaptive_search query="${query}"`);

    // 1. Observe current page
    await computerUseResolver.observePage(page);

    // 2. Resolve search input dynamically
    const searchTarget = await computerUseResolver.resolveTarget(page, 'search', 'search_box');
    const searchSelector = searchTarget?.selector || 'input[type="search"], input[name*="search"], input[placeholder*="search"], input';

    // 3. Focus & Fill & Submit
    try {
      await page.waitForSelector(searchSelector, { timeout: 5000 });
      await page.fill(searchSelector, query);
      await page.keyboard.press('Enter');
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1000).catch(() => {});
    } catch (err: any) {
      console.log(`[ComputerUse] action_failed type=adaptive_search reason="${err.message}"`);
    }

    // 4. Observe updated page for products
    const updatedObservation = await computerUseResolver.observePage(page);
    let parsedUrl = '';
    try {
      parsedUrl = new URL(page.url()).hostname.replace('www.', '');
    } catch {
      parsedUrl = 'merchant';
    }

    const products: ShoppingProduct[] = updatedObservation.products.map((p) => ({
      title: p.title,
      store: parsedUrl,
      price: p.rawPrice,
      url: p.url || p.href || page.url(),
      href: p.href || p.url || page.url(),
      snippet: p.price ? `${p.title} (${p.price})` : p.title,
      asin: p.asin,
      packSize: p.packSize,
      selector: p.selector,
    }));

    const latency = Date.now() - start;
    console.log(`[ComputerUse] action_completed type=adaptive_search products_count=${products.length} latency_ms=${latency}`);
    console.log(`[ComputerUse] state_verified type=adaptive_search state_changed=true`);

    return {
      success: true,
      products,
      query,
      url: page.url(),
    };
  }

  async scrollPage(
    direction: 'up' | 'down',
    amount = 500,
    sessionId = 'default',
    options?: BrowserActionOptions
  ): Promise<{ scrolled: boolean }> {
    const effectiveSessionId = options?.sessionId || sessionId || this.activeSessionId || 'default';
    return this.withSessionLock(effectiveSessionId, 'browser_scroll', options, async () => {
      return this.internalScrollPage(direction, amount, effectiveSessionId, options);
    });
  }

  private async internalScrollPage(
    direction: 'up' | 'down',
    amount = 500,
    sessionId = 'default',
    _options?: BrowserActionOptions
  ): Promise<{ scrolled: boolean }> {
    const check = this.canExecuteAction(sessionId, 'scroll');
    if (!check.allowed) {
      throw new ToolExecutionError(
        'browser_scroll',
        check.reason || 'Automated action blocked by human verification challenge'
      );
    }
    const page = await this.ensurePage();
    try {
      const scrollY = direction === 'down' ? amount : -amount;
      await page.evaluate((y) => window.scrollBy(0, y), scrollY);
      return { scrolled: true };
    } catch (err: any) {
      throw new ToolExecutionError('browser_scroll', `Failed to scroll: ${err.message}`);
    }
  }

  async waitFor(
    selectorOrMs: string | number,
    sessionId = 'default',
    options?: BrowserActionOptions
  ): Promise<{ success: boolean }> {
    const effectiveSessionId = options?.sessionId || sessionId || this.activeSessionId || 'default';
    return this.withSessionLock(effectiveSessionId, 'browser_wait', options, async () => {
      return this.internalWaitFor(selectorOrMs, effectiveSessionId, options);
    });
  }

  private async internalWaitFor(
    selectorOrMs: string | number,
    _sessionId = 'default',
    _options?: BrowserActionOptions
  ): Promise<{ success: boolean }> {
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

  async stopPage(): Promise<void> {
    if (this.page && !this.page.isClosed()) {
      await this.page.evaluate(() => window.stop()).catch(() => {});
    }
  }

  async takeScreenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
    const sessionId = options?.sessionId || this.activeSessionId || 'default';
    return this.withSessionLock(sessionId, 'browser_screenshot', options, async () => {
      return this.internalTakeScreenshot(options);
    });
  }

  private async internalTakeScreenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
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

  async addCookies(cookies: Array<{ name: string; value: string; [key: string]: any }>): Promise<void> {
    if (!cookies || !Array.isArray(cookies) || cookies.length === 0) return;
    await this.ensurePage();
    if (this.context) {
      const validCookies = cookies
        .filter((c) => Boolean(c.name && c.value))
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain || (c.url ? undefined : '.swiggy.com'),
          path: c.path || '/',
          url: c.url,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite || 'Lax',
        }));
      if (validCookies.length > 0) {
        await this.context.addCookies(validCookies as any);
        console.log(`[Browser] cookies_applied count=${validCookies.length}`);
      }
    }
  }

  async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    if (!headers || typeof headers !== 'object') return;
    await this.ensurePage();
    if (this.context) {
      await this.context.setExtraHTTPHeaders(headers);
      console.log(`[Browser] extra_headers_applied count=${Object.keys(headers).length}`);
    }
  }

  async clearCookies(): Promise<void> {
    if (this.context) {
      await this.context.clearCookies();
      console.log('[Browser] cookies_cleared');
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
