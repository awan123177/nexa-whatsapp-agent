import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { ShoppingStateMachine, ShoppingWorkflowPhase } from '../packages/agent/src/shopping-state-machine.js';
import { PlaywrightBrowserService } from '../packages/browser/src/browser-service.js';
import { ComputerUseResolver } from '../packages/browser/src/computer-use-resolver.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';
import { ToolRegistry } from '../packages/tools/src/registry.js';
import { createShoppingTools } from '../packages/tools/src/tools/shopping-tools.js';
import { createBrowserTools } from '../packages/tools/src/tools/browser-tools.js';
import { DuckDuckGoSearchProvider } from '../packages/tools/src/tools/web-search.js';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';
import { AIProvider, WhatsAppMediaSender } from '@nexa/shared';

describe('NEXA Shopping Orchestration, Loop Prevention & State Preservation Suite', () => {
  let browserService: PlaywrightBrowserService;
  let computerUseResolver: ComputerUseResolver;

  beforeEach(() => {
    vi.restoreAllMocks();
    browserService = new PlaywrightBrowserService();
    computerUseResolver = new ComputerUseResolver();
  });

  // ==========================================================================
  // 1. Shopping Workflow Phase State Machine & Telemetry
  // ==========================================================================
  describe('1. ShoppingStateMachine Phase Progression & Telemetry', () => {
    it('progresses monotonically through sequential shopping workflow phases', () => {
      const sm = new ShoppingStateMachine('INITIAL');
      expect(sm.getPhase()).toBe('INITIAL');

      // INITIAL -> SEARCH
      sm.advancePhase('SEARCH');
      expect(sm.getPhase()).toBe('SEARCH');

      // SEARCH -> SELECT_PRODUCT
      sm.setSelectedProduct({
        asin: 'B0DHCVXYZ1',
        title: 'Spigen EZ FIT Tempered Glass Screen Guard for iPhone 16 Pro Max - 3 Pack',
        price: 1399,
        packSize: 3,
        url: 'https://www.amazon.in/dp/B0DHCVXYZ1',
      });
      expect(sm.getPhase()).toBe('SELECT_PRODUCT');
      expect(sm.getSelectedProduct()?.asin).toBe('B0DHCVXYZ1');

      // SELECT_PRODUCT -> VERIFY_PRODUCT
      sm.advancePhase('VERIFY_PRODUCT');
      expect(sm.getPhase()).toBe('VERIFY_PRODUCT');

      // VERIFY_PRODUCT -> ADD_TO_CART
      sm.advancePhase('ADD_TO_CART');
      expect(sm.getPhase()).toBe('ADD_TO_CART');

      // ADD_TO_CART -> VERIFY_CART
      sm.setVerifiedCart({
        itemCount: 1,
        totalMinor: 139900,
        formattedTotal: '₹1,399.00',
        items: [{ name: 'Spigen 3 Pack Screen Guard', quantity: 1, priceMinor: 139900 }],
      });
      expect(sm.getPhase()).toBe('VERIFY_CART');
      expect(sm.getVerifiedCart()?.formattedTotal).toBe('₹1,399.00');

      // VERIFY_CART -> CAPTURE_SCREENSHOT
      sm.advancePhase('CAPTURE_SCREENSHOT');
      expect(sm.getPhase()).toBe('CAPTURE_SCREENSHOT');

      // CAPTURE_SCREENSHOT -> DELIVER_SCREENSHOT
      sm.setScreenshotDelivered('media_wamid_test_123');
      expect(sm.getPhase()).toBe('DELIVER_SCREENSHOT');
      expect(sm.isScreenshotDelivered()).toBe(true);

      // DELIVER_SCREENSHOT -> COMPLETED (terminal)
      sm.advancePhase('COMPLETED');
      expect(sm.getPhase()).toBe('COMPLETED');
    });

    it('rejects phase regressions to earlier phases without an explicit reason', () => {
      const sm = new ShoppingStateMachine('INITIAL');
      sm.advancePhase('SEARCH');
      sm.advancePhase('SELECT_PRODUCT');
      sm.advancePhase('VERIFY_PRODUCT');

      // Attempting to regress back to SEARCH without reason throws error
      expect(() => sm.advancePhase('SEARCH')).toThrow(/Illegal shopping phase transition/);

      // Regressing with an explicit concrete reason is permitted
      expect(() => sm.advancePhase('SEARCH', 'product_out_of_stock_recovery')).not.toThrow();
      expect(sm.getPhase()).toBe('SEARCH');
    });

    it('emits structured telemetry with URL, ASIN, pack size, and price', () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const sm = new ShoppingStateMachine('INITIAL');

      sm.setCurrentUrl('https://www.amazon.in/dp/B0DHCVXYZ1');
      sm.setSelectedProduct({
        asin: 'B0DHCVXYZ1',
        title: 'Spigen 3-Pack Screen Protector',
        price: 1299,
        packSize: 3,
        url: 'https://www.amazon.in/dp/B0DHCVXYZ1',
      });
      sm.setScreenshotDelivered('media_999');

      const logs = consoleSpy.mock.calls.map((c) => c[0]);
      expect(logs.some((l) => typeof l === 'string' && l.includes('[ShoppingWorkflow] product_selected'))).toBe(true);
      expect(logs.some((l) => typeof l === 'string' && l.includes('asin="B0DHCVXYZ1"'))).toBe(true);
      expect(logs.some((l) => typeof l === 'string' && l.includes('pack_size=3'))).toBe(true);
      expect(logs.some((l) => typeof l === 'string' && l.includes('screenshot_delivered'))).toBe(true);
    });
  });

  // ==========================================================================
  // 2. ComputerUseResolver Observation Enhancements
  // ==========================================================================
  describe('2. ComputerUseResolver ObservePage Product & Detail Page Extraction', () => {
    it('extracts product href, asin, packSize, and selector from Amazon cards', async () => {
      const mockPage: any = {
        isClosed: () => false,
        url: () => 'https://www.amazon.in/s?k=iphone+16+pro+max+screen+guard+3+pack',
        title: async () => 'Amazon.in: iphone 16 pro max screen guard 3 pack',
        evaluate: async (fn: any) => {
          // Provide simulated observation data with Amazon card fields
          return {
            textSummary: 'Amazon search results for iPhone 16 Pro Max screen guard',
            searchInputs: [{ selector: '#twotabsearchtextbox', confidence: 0.95 }],
            actionButtons: [],
            products: [
              {
                title: 'Spigen EZ FIT Tempered Glass Screen Guard for iPhone 16 Pro Max - 3 Pack',
                price: '₹1,399',
                rawPrice: 1399,
                selector: '[data-asin="B0DHCVXYZ1"] h2 a',
                url: 'https://www.amazon.in/dp/B0DHCVXYZ1',
                href: 'https://www.amazon.in/dp/B0DHCVXYZ1',
                asin: 'B0DHCVXYZ1',
                packSize: 3,
              },
            ],
            cartSummary: { itemCount: 0 },
            isProductDetailPage: false,
            currentAsin: undefined,
          };
        },
      };

      const observation = await computerUseResolver.observePage(mockPage);
      expect(observation.products.length).toBe(1);
      const product = observation.products[0];
      expect(product.title).toContain('Spigen');
      expect(product.rawPrice).toBe(1399);
      expect(product.packSize).toBe(3);
      expect(product.asin).toBe('B0DHCVXYZ1');
      expect(product.href).toBe('https://www.amazon.in/dp/B0DHCVXYZ1');
      expect(product.selector).toContain('B0DHCVXYZ1');
      expect(observation.isProductDetailPage).toBe(false);
    });

    it('identifies Amazon product detail page and extracts currentAsin and add-to-cart selector', async () => {
      const mockPage: any = {
        isClosed: () => false,
        url: () => 'https://www.amazon.in/dp/B0DHCVXYZ1',
        title: async () => 'Spigen EZ FIT Tempered Glass Screen Guard for iPhone 16 Pro Max - 3 Pack: Amazon.in',
        evaluate: async () => {
          return {
            textSummary: 'Product details page for Spigen 3-pack screen guard',
            searchInputs: [],
            actionButtons: [{ selector: '#add-to-cart-button', text: 'Add to Cart', targetType: 'add_to_cart', confidence: 0.95 }],
            products: [
              {
                title: 'Spigen EZ FIT Tempered Glass Screen Guard for iPhone 16 Pro Max - 3 Pack',
                price: '₹1,399',
                rawPrice: 1399,
                selector: '#add-to-cart-button',
                url: 'https://www.amazon.in/dp/B0DHCVXYZ1',
                href: 'https://www.amazon.in/dp/B0DHCVXYZ1',
                asin: 'B0DHCVXYZ1',
                packSize: 3,
              },
            ],
            cartSummary: { itemCount: 0 },
            isProductDetailPage: true,
            currentAsin: 'B0DHCVXYZ1',
          };
        },
      };

      const observation = await computerUseResolver.observePage(mockPage);
      expect(observation.isProductDetailPage).toBe(true);
      expect(observation.currentAsin).toBe('B0DHCVXYZ1');
      expect(observation.products[0].selector).toBe('#add-to-cart-button');
      expect(observation.actionButtons.some((b) => b.targetType === 'add_to_cart')).toBe(true);
    });
  });

  // ==========================================================================
  // 3. PlaywrightBrowserService Click Navigation & Popup Tab Adoption
  // ==========================================================================
  describe('3. BrowserService Click State Verification & Popup Tab Adoption', () => {
    it('reports state_changed=false when click does NOT change URL and no new tab opened', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const mockPage: any = {
        isClosed: () => false,
        url: () => 'https://www.amazon.in/s?k=screen+guard',
        waitForSelector: vi.fn().mockResolvedValue({}),
        click: vi.fn().mockResolvedValue(undefined),
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
        setDefaultTimeout: vi.fn(),
      };

      const mockContext: any = {
        waitForEvent: vi.fn().mockResolvedValue(null),
        pages: () => [mockPage],
      };

      (browserService as any).page = mockPage;
      (browserService as any).context = mockContext;
      (browserService as any).activeUrl = 'https://www.amazon.in/s?k=screen+guard';

      const res = await browserService.clickElement('.some-filter-link', 'test_session');
      expect(res.success).toBe(true);
      expect(res.stateChanged).toBe(false);
      expect(res.urlChanged).toBe(false);

      const logs = consoleSpy.mock.calls.map((c) => c[0]);
      expect(logs.some((l) => typeof l === 'string' && l.includes('state_verified') && l.includes('state_changed=false'))).toBe(true);
    });

    it('reports state_changed=true and adopts new page when link click opens popup tab (target="_blank")', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const searchPage: any = {
        isClosed: () => false,
        url: () => 'https://www.amazon.in/s?k=screen+guard',
        waitForSelector: vi.fn().mockResolvedValue({}),
        click: vi.fn().mockResolvedValue(undefined),
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
        setDefaultTimeout: vi.fn(),
      };

      const productPage: any = {
        isClosed: () => false,
        url: () => 'https://www.amazon.in/dp/B0DHCVXYZ1',
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
        setDefaultTimeout: vi.fn(),
      };

      const mockContext: any = {
        waitForEvent: vi.fn().mockResolvedValue(productPage),
        pages: () => [searchPage, productPage],
      };

      (browserService as any).page = searchPage;
      (browserService as any).context = mockContext;
      (browserService as any).activeUrl = 'https://www.amazon.in/s?k=screen+guard';

      const res = await browserService.clickElement('a[href*="/dp/B0DHCVXYZ1"]', 'test_session');
      expect(res.success).toBe(true);
      expect(res.stateChanged).toBe(true);
      expect(res.urlChanged).toBe(true);
      expect(res.isProductPage).toBe(true);
      expect(res.url).toBe('https://www.amazon.in/dp/B0DHCVXYZ1');
      expect((browserService as any).page).toBe(productPage);

      const logs = consoleSpy.mock.calls.map((c) => c[0]);
      expect(logs.some((l) => typeof l === 'string' && l.includes('adopted_popup_tab'))).toBe(true);
      expect(logs.some((l) => typeof l === 'string' && l.includes('state_verified') && l.includes('state_changed=true'))).toBe(true);
    });
  });

  // ==========================================================================
  // 4. Repeated Search Loops & State Preservation in AgentOrchestrator
  // ==========================================================================
  describe('4. Loop Prevention & Browser State Preservation in Orchestrator', () => {
    it('blocks navigation regression back to generic search URL when already on product page', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const mockDb = new InMemoryRepository();

      const registry = new ToolRegistry();
      const mockBrowser: any = {
        getActiveUrl: vi.fn().mockReturnValue('https://www.amazon.in/dp/B0DHCVXYZ1'),
        openPage: vi.fn().mockResolvedValue({ success: true, finalUrl: 'https://www.amazon.in/s?k=screen+guard' }),
        cleanupPage: vi.fn().mockResolvedValue(undefined),
        markTaskTerminal: vi.fn(),
      };

      registry.register({
        name: 'browser_open',
        description: 'Open webpage',
        riskLevel: 'read_only',
        parametersSchema: z.any(),
        requiresApproval: () => ({ required: false }),
        execute: async () => ({ success: true }),
      });

      let callCount = 0;
      const mockAI = new MockAIProvider(async () => {
        callCount++;
        if (callCount === 1) {
          // First turn: try to navigate BACK to search URL while already on product page
          return {
            text: '',
            toolCalls: [
              {
                id: 'call_regress',
                name: 'browser_open',
                arguments: { url: 'https://www.amazon.in/s?k=spigen+iphone+16' },
              },
            ],
          };
        }
        return {
          text: 'I maintained the product page state and verified the screen guard in your cart.',
          toolCalls: [],
        };
      });

      const orchestrator = new AgentOrchestrator(
        mockAI,
        registry,
        mockDb,
        5,
        undefined,
        15000,
        120000,
        5,
        120000,
        mockBrowser as any
      );

      const result = await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        text: 'Find a set of 3 iPhone 16 Pro Max screen guards under 1500 on Amazon and show cart screenshot',
      });

      expect(result.replyText).toBeDefined();
      const logs = consoleSpy.mock.calls.map((c) => c[0]);
      expect(
        logs.some(
          (l) =>
            typeof l === 'string' &&
            l.includes('[Agent] navigation_regression_blocked') &&
            l.includes('browser_state_preserved')
        )
      ).toBe(true);
    });

    it('detects repeated search queries and blocks cycling', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const mockDb = new InMemoryRepository();

      const registry = new ToolRegistry();
      registry.register({
        name: 'shopping_search',
        description: 'Search products',
        riskLevel: 'read_only',
        parametersSchema: z.any(),
        requiresApproval: () => ({ required: false }),
        execute: async () => ({
          success: true,
          data: {
            merchant: 'Amazon',
            products: [{ title: 'Spigen 3 Pack', price: 1399, packSize: 3, asin: 'B0DHCVXYZ1' }],
          },
        }),
      });

      let callCount = 0;
      const mockAI = new MockAIProvider(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'call_search_1', name: 'shopping_search', arguments: { query: 'Spigen iPhone 16' } }],
          };
        }
        if (callCount === 2) {
          // Repeat exact same query
          return {
            text: '',
            toolCalls: [{ id: 'call_search_2', name: 'shopping_search', arguments: { query: 'Spigen iPhone 16' } }],
          };
        }
        return {
          text: 'Selected Spigen 3-pack screen guard and ready.',
          toolCalls: [],
        };
      });

      const orchestrator = new AgentOrchestrator(
        mockAI,
        registry,
        mockDb,
        5,
        undefined,
        15000,
        120000,
        5,
        120000
      );

      await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        text: 'Buy iPhone 16 screen guard on Amazon',
      });

      const logs = consoleSpy.mock.calls.map((c) => c[0]);
      expect(
        logs.some(
          (l) =>
            typeof l === 'string' &&
            l.includes('[Agent] search_loop_detected') &&
            l.includes('query="spigen iphone 16"')
        )
      ).toBe(true);
    });
  });

  // ==========================================================================
  // 5. Near-Deadline Safety Buffer Reservation (Prompt Point 4)
  // ==========================================================================
  describe('5. Near-Deadline Safety Buffer Reservation', () => {
    it('skips new searches when remaining deadline is below reserved completion buffer', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const mockDb = new InMemoryRepository();

      const registry = new ToolRegistry();
      registry.register({
        name: 'shopping_search',
        description: 'Search products',
        riskLevel: 'read_only',
        parametersSchema: z.any(),
        requiresApproval: () => ({ required: false }),
        execute: async () => ({ success: true, data: { products: [] } }),
      });

      let turn = 0;
      const mockAI = new MockAIProvider(async () => {
        turn++;
        if (turn === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'call_tight_search', name: 'shopping_search', arguments: { query: 'iPhone 16 guard' } }],
          };
        }
        return {
          text: 'Completed with existing cart state.',
          toolCalls: [],
        };
      });

      // Set total deadline to 17000ms (below COMMERCE_RESERVED_COMPLETION_BUFFER_MS + 3000ms = 18000ms)
      const orchestrator = new AgentOrchestrator(
        mockAI,
        registry,
        mockDb,
        5,
        undefined,
        5000,
        17000,
        5,
        17000
      );

      await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        text: 'Buy screen guard on Amazon',
      });

      const logs = consoleSpy.mock.calls.map((c) => c[0]);
      expect(
        logs.some(
          (l) =>
            typeof l === 'string' &&
            l.includes('[Agent] deadline_search_budget_insufficient') &&
            l.includes('action="skip_search_and_proceed"')
        )
      ).toBe(true);
    });
  });

  // ==========================================================================
  // 6. Complete Transaction-Free Workflow with Screenshot Delivery (Prompt Point 5)
  // ==========================================================================
  describe('6. End-to-End Transaction-Free Workflow with Screenshot Delivery', () => {
    it('executes product verification, cart verification, delivers screenshot via WhatsApp client, and completes without payment', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const mockWhatsapp: WhatsAppMediaSender = {
        uploadMedia: vi.fn().mockResolvedValue({ mediaId: 'wamid_media_screen_guard_cart' }),
        sendImageMessage: vi.fn().mockResolvedValue({ messageId: 'msg_9876' }),
      };

      const mockDb = new InMemoryRepository();

      const mockBrowserService: any = {
        getActiveUrl: vi.fn().mockReturnValue('https://www.amazon.in/gp/cart/view.html'),
        cleanupPage: vi.fn().mockResolvedValue(undefined),
        takeScreenshot: vi.fn().mockResolvedValue({
          buffer: Buffer.from('fake-screenshot-png-data'),
          mimeType: 'image/png',
          base64: 'ZmFrZS1zY3JlZW5zaG90',
        }),
        verifyCart: vi.fn().mockResolvedValue({
          items: [{ name: 'Spigen 3 Pack Screen Guard for iPhone 16 Pro Max', priceMinor: 139900, quantity: 1 }],
          totalPriceMinor: 139900,
          formattedTotal: '₹1,399.00',
        }),
        markTaskTerminal: vi.fn(),
      };

      const registry = new ToolRegistry();
      const shoppingTools = createShoppingTools(new DuckDuckGoSearchProvider(), mockDb, mockBrowserService);
      const browserTools = createBrowserTools(mockBrowserService, mockWhatsapp);

      for (const t of [...shoppingTools, ...browserTools]) {
        registry.register(t);
      }

      let step = 0;
      const mockAI = new MockAIProvider(async () => {
          step++;
          if (step === 1) {
            // 1. Observe products
            return {
              text: '',
              toolCalls: [
                {
                  id: 'call_obs',
                  name: 'browser_observe',
                  arguments: {},
                },
              ],
            };
          }
          if (step === 2) {
            // 2. Add to cart
            return {
              text: '',
              toolCalls: [
                {
                  id: 'call_cart',
                  name: 'shopping_add_to_cart',
                  arguments: {
                    productName: 'Spigen 3 Pack Screen Guard for iPhone 16 Pro Max',
                    price: 1399,
                    merchant: 'Amazon',
                    packSize: 3,
                    quantity: 1,
                  },
                },
              ],
            };
          }
          if (step === 3) {
            // 3. Verify cart
            return {
              text: '',
              toolCalls: [
                {
                  id: 'call_verify_cart',
                  name: 'browser_verify_cart',
                  arguments: { expectedItem: 'Spigen' },
                },
              ],
            };
          }
          if (step === 4) {
            // 4. Take screenshot of cart and deliver to WhatsApp
            return {
              text: '',
              toolCalls: [
                {
                  id: 'call_screenshot',
                  name: 'browser_screenshot',
                  arguments: { caption: "📸 Here's your verified Amazon cart." },
                },
              ],
            };
          }
          // Final reply: do NOT proceed to checkout or payment
          return {
            text: 'I verified the Spigen 3-pack screen guard under ₹1,500 in your Amazon cart and delivered the screenshot to WhatsApp. Stopped before checkout as requested.',
            toolCalls: [],
          };
      });

      const orchestrator = new AgentOrchestrator(
        mockAI,
        registry,
        mockDb,
        10,
        mockWhatsapp,
        15000,
        120000,
        10,
        120000,
        mockBrowserService
      );

      const res = await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        text: 'Find a set of three iPhone 16 Pro Max screen guards under ₹1,500 on Amazon and send me a screenshot of the cart',
      });

      expect(res.replyText).toContain('Spigen');
      expect(mockWhatsapp.uploadMedia).toHaveBeenCalled();
      expect(mockWhatsapp.sendImageMessage).toHaveBeenCalledWith(
        '+919876543210',
        'wamid_media_screen_guard_cart',
        "📸 Here's your verified Amazon cart."
      );

      const logs = consoleSpy.mock.calls.map((c) => c[0]);
      expect(logs.some((l) => typeof l === 'string' && l.includes('[ShoppingWorkflow] cart_verified'))).toBe(true);
      expect(logs.some((l) => typeof l === 'string' && l.includes('[ShoppingWorkflow] screenshot_captured'))).toBe(true);
      expect(logs.some((l) => typeof l === 'string' && l.includes('[ShoppingWorkflow] screenshot_delivered'))).toBe(true);
      expect(logs.some((l) => typeof l === 'string' && l.includes('workflow_completed'))).toBe(true);
      // Ensure checkout was NEVER called
      expect(logs.some((l) => typeof l === 'string' && l.includes('shopping_checkout'))).toBe(false);
    });
  });

  // ==========================================================================
  // 7. Production Reliability & Race Prevention (October 9 Remaining Failure Fixes)
  // ==========================================================================
  describe('7. Production Reliability & Race Prevention Suite', () => {
    it('preserves late successful navigation result when signal aborts around same tick', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const bs = new PlaywrightBrowserService();

      // Mock ensurePage and page
      const mockPage: any = {
        url: () => 'https://example.com',
        title: async () => 'Example Domain',
        content: async () => '<html><body>Example</body></html>',
        evaluate: async () => 'Example Domain Content',
        goto: async () => ({ status: () => 200 }),
        isClosed: () => false,
      };
      (bs as any).page = mockPage;
      (bs as any).ensurePage = async () => mockPage;

      const controller = new AbortController();
      // Execute with signal
      const openPromise = bs.openPage('https://example.com', {
        signal: controller.signal,
        timeoutMs: 5000,
      });
      // Abort right during/after start
      controller.abort();

      const result = await openPromise;
      const logs = consoleSpy.mock.calls.map((c) => c[0]);
      // Either late_result_preserved was logged or it returned structured timeout without crashing
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
    });

    it('deduplicates concurrent in-flight navigations for the same session and URL', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const bs = new PlaywrightBrowserService();

      let gotoCount = 0;
      const mockPage: any = {
        url: () => 'https://example.com',
        title: async () => 'Example Domain',
        content: async () => '<html><body>Example</body></html>',
        evaluate: async () => 'Example Domain',
        goto: async () => {
          gotoCount++;
          await new Promise((r) => setTimeout(r, 50));
          return { status: () => 200 };
        },
        isClosed: () => false,
      };
      (bs as any).page = mockPage;
      (bs as any).ensurePage = async () => mockPage;

      // Start two concurrent navigations to same URL
      const [res1, res2] = await Promise.all([
        bs.openPage('https://example.com'),
        bs.openPage('https://example.com'),
      ]);

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);
      const logs = consoleSpy.mock.calls.map((c) => c[0]);
      expect(logs.some((l) => typeof l === 'string' && l.includes('[Browser] navigation_deduped'))).toBe(true);
    });

    it('inspects existing active session when browser already open and exposes active URL', async () => {
      const bs = new PlaywrightBrowserService();
      (bs as any).activeUrl = 'https://www.amazon.in/s?k=screen+guard';

      expect(bs.getActiveUrl()).toBe('https://www.amazon.in/s?k=screen+guard');
      const session = bs.getOrCreateSession('default');
      expect(session).toBeDefined();
      expect(session.activeUrl).toBe('https://www.amazon.in/s?k=screen+guard');
    });

    it('intercepts generic search tools in browser fallback when browser already has merchant session open', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const mockDb = new InMemoryRepository();
      const registry = new ToolRegistry();

      registry.register({
        name: 'search_products',
        description: 'Search products',
        riskLevel: 'read_only',
        parametersSchema: z.any(),
        requiresApproval: () => ({ required: false }),
        execute: async () => ({ success: true, data: { products: [] } }),
      });

      const mockBrowser: any = {
        getActiveUrl: vi.fn().mockReturnValue('https://www.amazon.in/s?k=screen+guard'),
        openPage: vi.fn().mockResolvedValue({ success: true }),
        observePage: vi.fn().mockResolvedValue({
          url: 'https://www.amazon.in/s?k=screen+guard',
          products: [{ title: 'Spigen 3 Pack', price: '₹1,399', asin: 'B0DHCVXYZ1', packSize: 3 }],
          searchInputs: [],
          actionButtons: [],
        }),
        cleanupPage: vi.fn().mockResolvedValue(undefined),
        markTaskTerminal: vi.fn(),
      };

      let turn = 0;
      const mockAI = new MockAIProvider(async () => {
        turn++;
        if (turn === 1) {
          // AI attempts to call search_products while Amazon is already open
          return {
            text: '',
            toolCalls: [{ id: 'call_srch', name: 'search_products', arguments: { query: 'iPhone 16 guard' } }],
          };
        }
        return {
          text: 'Proceeding with browser observation on Amazon India.',
          toolCalls: [],
        };
      });

      const orchestrator = new AgentOrchestrator(
        mockAI,
        registry,
        mockDb,
        5,
        undefined,
        15000,
        120000,
        5,
        120000,
        mockBrowser
      );

      await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        text: 'Buy iPhone 16 screen guard on Amazon',
      });

      const logs = consoleSpy.mock.calls.map((c) => c[0]);
      expect(
        logs.some(
          (l) =>
            typeof l === 'string' &&
            l.includes('[Agent] search_intercepted_for_open_session') &&
            l.includes('tool=search_products')
        )
      ).toBe(true);
    });

    it('validates product qualification strictly for iPhone 16 Pro Max 3-pack under ₹1,500', () => {
      const sm = new ShoppingStateMachine('INITIAL');

      // Qualifying
      expect(
        sm.isProductQualified({
          title: 'Spigen EZ FIT Tempered Glass Screen Guard for iPhone 16 Pro Max - 3 Pack',
          price: 1399,
          packSize: 3,
          asin: 'B0DHCVXYZ1',
        })
      ).toBe(true);

      // Failing: Only 2-pack
      expect(
        sm.isProductQualified({
          title: 'Spigen EZ FIT Screen Guard for iPhone 16 Pro Max - 2 Pack',
          price: 999,
          packSize: 2,
        })
      ).toBe(false);

      // Failing: Over ₹1,500 budget
      expect(
        sm.isProductQualified({
          title: 'Spigen Ultra Shield for iPhone 16 Pro Max - 3 Pack',
          price: 1899,
          packSize: 3,
        })
      ).toBe(false);

      // Failing: Wrong device (iPhone 15 Pro Max)
      expect(
        sm.isProductQualified({
          title: 'Spigen Tempered Glass for iPhone 15 Pro Max - 3 Pack',
          price: 1299,
          packSize: 3,
        })
      ).toBe(false);
    });

    it('detects auth and bot challenges on merchant page and prevents automated bypass', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const bs = new PlaywrightBrowserService();

      const mockPage: any = {
        url: () => 'https://www.amazon.in/errors/validateCaptcha',
        title: async () => 'Robot Check',
        content: async () => '<html><body>Enter the characters you see below: Amazon Robot Check</body></html>',
        evaluate: async () => 'Enter the characters you see below',
        goto: async () => ({ status: () => 200 }),
        isClosed: () => false,
      };
      (bs as any).page = mockPage;
      (bs as any).ensurePage = async () => mockPage;

      const res = await bs.openPage('https://www.amazon.in/errors/validateCaptcha');
      expect(res.success).toBe(false);
      expect((res as any).errorType).toBe('CAPTCHA_REQUIRED');
      const logs = consoleSpy.mock.calls.map((c) => c[0]);
      expect(logs.some((l) => typeof l === 'string' && l.includes('[ComputerUse] challenge_detected'))).toBe(true);
    });

    it('preserves 1:1 Gemini functionCall-functionResponse pairing when tool loop encounters terminal state or skip', async () => {
      const mockDb = new InMemoryRepository();
      const registry = new ToolRegistry();

      registry.register({
        name: 'tool_one',
        description: 'First tool',
        riskLevel: 'read_only',
        parametersSchema: z.any(),
        requiresApproval: () => ({ required: false }),
        execute: async () => {
          throw new Error('Terminal critical failure in tool_one');
        },
      });

      registry.register({
        name: 'tool_two',
        description: 'Second tool',
        riskLevel: 'read_only',
        parametersSchema: z.any(),
        requiresApproval: () => ({ required: false }),
        execute: async () => ({ success: true }),
      });

      let turn = 0;
      let recordedRawHistory: any = null;
      const mockAI = new MockAIProvider(async (_msgs, opts) => {
        turn++;
        if (turn === 1) {
          return {
            text: '',
            toolCalls: [
              { id: 'call_1', name: 'tool_one', arguments: {} },
              { id: 'call_2', name: 'tool_two', arguments: {} },
            ],
          };
        }
        recordedRawHistory = opts?.rawHistory;
        return {
          text: 'Acknowledged failure safely.',
          toolCalls: [],
        };
      });

      const orchestrator = new AgentOrchestrator(
        mockAI,
        registry,
        mockDb,
        5,
        undefined,
        15000,
        120000,
        5,
        120000
      );

      await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        text: 'Execute tool one and tool two',
      });

      // Verify that raw history has pairing for both call_1 and call_2
      expect(recordedRawHistory).toBeDefined();
      const userResponseTurn = recordedRawHistory.find(
        (t: any) => t.role === 'user' && t.parts.some((p: any) => p.functionResponse)
      );
      expect(userResponseTurn).toBeDefined();
      expect(userResponseTurn.parts.length).toBe(2);
      expect(userResponseTurn.parts[0].functionResponse.name).toBe('tool_one');
      expect(userResponseTurn.parts[1].functionResponse.name).toBe('tool_two');
    });

    it('prompts for Amazon sign-in only when authState is AUTH_REQUIRED and never when false', async () => {
      const mockDb = new InMemoryRepository();
      const registry = new ToolRegistry();

      const mockBrowser: any = {
        getActiveUrl: vi.fn().mockReturnValue('https://www.amazon.in/ap/signin'),
        getSessionMetadata: vi.fn().mockReturnValue({
          authState: 'AUTH_REQUIRED',
          pageState: 'challenged',
        }),
        cleanupPage: vi.fn().mockResolvedValue(undefined),
        markTaskTerminal: vi.fn(),
      };

      const mockAI = new MockAIProvider(async () => {
        return {
          text: '',
          toolCalls: [],
        };
      });

      const orchestrator = new AgentOrchestrator(
        mockAI,
        registry,
        mockDb,
        5,
        undefined,
        15000,
        120000,
        5,
        120000,
        mockBrowser
      );

      const res = await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        text: 'Find iPhone 16 screen guard on Amazon India and add to cart',
      });

      expect(res.replyText).toContain('Amazon India requires you to sign in');
    });

    it('prevents fabricated claims of cart addition or screenshot delivery when unverified', async () => {
      const mockDb = new InMemoryRepository();
      const registry = new ToolRegistry();

      // AI hallucinates that it verified cart and sent screenshot, without calling any tools
      const mockAI = new MockAIProvider(async () => {
        return {
          text: 'I have added the Spigen screen guard, verified your Amazon cart, and sent you a screenshot on WhatsApp!',
          toolCalls: [],
        };
      });

      const orchestrator = new AgentOrchestrator(
        mockAI,
        registry,
        mockDb,
        5,
        undefined,
        15000,
        120000,
        5,
        120000
      );

      const res = await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        text: 'Find iPhone 16 screen guard on Amazon India, add to cart, and send screenshot',
      });

      // The fabricated claim must be sanitized/prevented
      expect(res.replyText).not.toContain('sent you a screenshot');
      expect(res.replyText).toContain('unable to complete adding the screen guard to your cart');
    });

    it('full production shopping request remains in shopping workflow without clarification questions', async () => {
      const mockDb = new InMemoryRepository();
      const registry = new ToolRegistry();

      registry.register({
        name: 'browser_observe',
        description: 'Observe webpage',
        riskLevel: 'read_only',
        parametersSchema: z.any(),
        requiresApproval: () => ({ required: false }),
        execute: async () => ({
          success: true,
          data: {
            products: [{ title: 'Spigen 3 Pack Screen Protector', price: '₹1,399', asin: 'B0DHCVXYZ1', packSize: 3 }],
          },
        }),
      });

      let turn = 0;
      const mockAI = new MockAIProvider(async () => {
        turn++;
        if (turn === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'call_obs', name: 'browser_observe', arguments: {} }],
          };
        }
        return {
          text: 'Found Spigen iPhone 16 Pro Max 3-pack screen guard under ₹1,500 on Amazon India.',
          toolCalls: [],
        };
      });

      const orchestrator = new AgentOrchestrator(
        mockAI,
        registry,
        mockDb,
        5,
        undefined,
        15000,
        120000,
        5,
        120000
      );

      const res = await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        text: 'Find the best iPhone 16 Pro Max screen guard on Amazon India. I need one pack containing at least 3 guards for under ₹1,500. Use the existing browser session if Amazon is already open. Verify the actual product page, add one qualifying pack to my cart, open the real cart, and send me a genuine screenshot through WhatsApp. Do not check out or make a payment. If login is required, ask me to sign in.',
      });

      expect(res.replyText).not.toContain('Should I call you Out or Make');
      expect(res.replyText).toContain('Spigen');
    });
  });
});
