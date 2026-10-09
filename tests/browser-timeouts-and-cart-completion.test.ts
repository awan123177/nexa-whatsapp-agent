import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlaywrightBrowserService } from '../packages/browser/src/index.js';
import { createBrowserTools } from '../packages/tools/src/tools/browser-tools.js';
import {
  createShoppingTools,
  clearUserCart,
  getUserCart,
} from '../packages/tools/src/tools/shopping-tools.js';
import { DuckDuckGoSearchProvider } from '../packages/tools/src/tools/web-search.js';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { AgentOrchestrator, classifyMessageIntent } from '../packages/agent/src/index.js';
import {
  AIProvider,
  AIMessage,
  AIResponse,
  ToolExecutionContext,
} from '../packages/shared/src/index.js';

describe('NEXA YOLO — Browser Timeouts, Cancellation Races, Cart Completion & Memory Persistence Suite', () => {
  let browserService: PlaywrightBrowserService;
  let db: InMemoryRepository;

  beforeEach(() => {
    browserService = new PlaywrightBrowserService();
    db = new InMemoryRepository();
  });

  afterEach(async () => {
    if (browserService) {
      await browserService.close();
    }
  });

  // =========================================================================
  // BUG 1 & BUG 2: BROWSER TIMEOUTS, CANCELLATION, MUTEX LOCK & RECOVERY
  // =========================================================================
  describe('BUG 1 & BUG 2: Browser Timeouts, In-Flight Cancellation & Session Locking', () => {
    it('underlying browser action stops and cleans up upon timeout or AbortSignal', async () => {
      const controller = new AbortController();
      const sessionId = 'test-session-abort';

      // Simulate an action that takes 500ms
      let wasPageCleanedUp = false;
      const cleanupSpy = vi.spyOn(browserService, 'cleanupPage').mockImplementation(async () => {
        wasPageCleanedUp = true;
      });

      // Abort after 20ms
      setTimeout(() => controller.abort(), 20);

      const actionPromise = (browserService as any).withSessionLock(
        sessionId,
        'test_slow_nav',
        { signal: controller.signal, timeoutMs: 5000, sessionId },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { done: true };
        }
      );

      await expect(actionPromise).rejects.toThrow();
      expect(wasPageCleanedUp).toBe(true);
      cleanupSpy.mockRestore();
    });

    it('late action result after task failure is discarded and cannot mutate state', async () => {
      const taskId = 'task_timed_out_999';
      const sessionId = 'test-session-late';

      // Mark the task terminal (FAILED) before/during action
      browserService.markTaskTerminal(taskId);

      const actionPromise = (browserService as any).withSessionLock(
        sessionId,
        'test_late_search',
        { taskId, sessionId, timeoutMs: 5000 },
        async () => {
          return { products: ['Fake late item'] };
        }
      );

      await expect(actionPromise).rejects.toThrow(
        /Task task_timed_out_999 has already reached a terminal state/
      );
    });

    it('two actions attempting to use the same browser page concurrently are serialized via session lock', async () => {
      const sessionId = 'test-session-concurrent';
      const executionOrder: string[] = [];

      const action1 = (browserService as any).withSessionLock(
        sessionId,
        'action_one',
        { sessionId, timeoutMs: 5000 },
        async () => {
          executionOrder.push('action1_start');
          await new Promise((resolve) => setTimeout(resolve, 50));
          executionOrder.push('action1_end');
          return 'result1';
        }
      );

      const action2 = (browserService as any).withSessionLock(
        sessionId,
        'action_two',
        { sessionId, timeoutMs: 5000 },
        async () => {
          executionOrder.push('action2_start');
          await new Promise((resolve) => setTimeout(resolve, 20));
          executionOrder.push('action2_end');
          return 'result2';
        }
      );

      const [res1, res2] = await Promise.all([action1, action2]);
      expect(res1).toBe('result1');
      expect(res2).toBe('result2');

      // Crucial: action1 must completely finish before action2 starts (no interleaved DOM races)
      expect(executionOrder).toEqual([
        'action1_start',
        'action1_end',
        'action2_start',
        'action2_end',
      ]);
    });

    it('timeout followed by distinct recovery records separate failed attempt and successful recovery', async () => {
      let callCount = 0;
      const mockAi: AIProvider = {
        name: 'mock-gemini',
        async generateResponse(): Promise<AIResponse> {
          callCount++;
          if (callCount === 1) {
            // First step calls browser_type which fails
            return {
              text: 'Attempting to type search query...',
              toolCalls: [
                {
                  id: 'call_type_1',
                  name: 'browser_type',
                  arguments: { selector: '#search-box', text: 'screen guard' },
                },
              ],
            };
          }
          if (callCount === 2) {
            // Second step: model recovers by using shopping_search instead
            return {
              text: 'Typing failed, using direct shopping search instead.',
              toolCalls: [
                {
                  id: 'call_search_2',
                  name: 'shopping_search',
                  arguments: { query: 'iPhone 16 Pro Max screen guard', merchant: 'Amazon' },
                },
              ],
            };
          }
          return {
            text: 'I recovered from the typing timeout and found the products on Amazon.',
          };
        },
      };

      const toolRegistry = createDefaultToolRegistry({ db, browserService });

      // Mock browser_type to fail
      const browserTypeTool = toolRegistry.getTool('browser_type');
      if (browserTypeTool) {
        vi.spyOn(browserTypeTool, 'execute').mockResolvedValueOnce({
          success: false,
          error: 'Element #search-box timed out after 12000ms',
          data: { timedOut: true },
        });
      }

      // Mock shopping_search to recover successfully
      const shoppingSearchTool = toolRegistry.getTool('shopping_search');
      if (shoppingSearchTool) {
        vi.spyOn(shoppingSearchTool, 'execute').mockResolvedValueOnce({
          success: true,
          data: {
            products: [
              {
                title: 'Spigen EZ FIT Tempered Glass for iPhone 16 Pro Max (Pack of 3)',
                price: 899,
                store: 'Amazon',
              },
            ],
          },
          userFacingMessage: 'Found Spigen EZ FIT (Pack of 3) on Amazon for ₹899.',
        });
      }

      const logSpy = vi.spyOn(console, 'log');
      const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

      const result = await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        name: 'Awan',
        nameConfirmed: true,
        text: 'Find iPhone 16 Pro Max screen guard on Amazon',
      });

      expect(result.stepsCount).toBeGreaterThanOrEqual(2);
      // Ensure failed browser_type logged step_failed
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('step_failed step=1 tool=browser_type')
      );
      // Ensure step_completed was NOT logged for the failed step
      expect(logSpy).not.toHaveBeenCalledWith('step_completed step=1');
      // Ensure recovery succeeded
      expect(result.replyText).toContain('Amazon');
      logSpy.mockRestore();
    });

    it('deadline expiry (< 3000ms) halts safely instead of launching a 1-second doomed action', async () => {
      const mockAi: AIProvider = {
        name: 'mock-gemini',
        async generateResponse(): Promise<AIResponse> {
          return {
            text: 'Opening browser...',
            toolCalls: [
              {
                id: 'call_nav_doomed',
                name: 'browser_open',
                arguments: { url: 'https://www.amazon.in' },
              },
            ],
          };
        },
      };

      const toolRegistry = createDefaultToolRegistry({ db, browserService });
      const browserOpenTool = toolRegistry.getTool('browser_open');
      const executeSpy = browserOpenTool ? vi.spyOn(browserOpenTool, 'execute') : null;

      // Initialize orchestrator with totalDeadlineMs = 2000ms (< 3000ms MIN_MEANINGFUL_TOOL_BUDGET_MS)
      const orchestrator = new AgentOrchestrator(
        mockAi,
        toolRegistry,
        db,
        5,
        undefined,
        10000,
        2000
      );

      const logSpy = vi.spyOn(console, 'log');
      const result = await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        name: 'Awan',
        nameConfirmed: true,
        text: 'Quick open test',
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('task_failed reason="deadline_approaching"')
      );
      if (executeSpy) {
        expect(executeSpy).not.toHaveBeenCalled();
      }
      expect(result.replyText).toContain('within the allocated time limit');
      logSpy.mockRestore();
    });
  });

  // =========================================================================
  // BUG 3: AMAZON SCREEN-GUARD WORKFLOW (3-PACK, BUDGET, VERIFIED CART, SCREENSHOT)
  // =========================================================================
  describe('BUG 3: Amazon Screen-Guard Workflow (3-Pack vs 3 Singles, Cart & Screenshot)', () => {
    it('classifies iPhone 16 Pro Max screen guard request as SHOPPING and resolves Amazon merchant', () => {
      const query = 'Find a set of three iPhone 16 Pro Max screen guards under ₹1,500 on Amazon and show me the cart screenshot';
      const intent = classifyMessageIntent(query);
      expect(intent).toBe('SHOPPING');
    });

    it('distinguishes a 3-pack from buying 3 single packs, enforces ₹1,500 budget, and verifies cart', async () => {
      const user = await db.findOrCreateUserByPhone('+919876543210');
      clearUserCart(user.id);

      const shoppingTools = createShoppingTools(new DuckDuckGoSearchProvider(), db, browserService);
      const addToCart = shoppingTools.find((t) => t.name === 'shopping_add_to_cart')!;
      const verifyCart = shoppingTools.find((t) => t.name === 'shopping_verify_cart')!;

      const context: ToolExecutionContext = {
        user,
        conversation: { id: 'conv-1', user_id: user.id, channel: 'whatsapp', status: 'active', created_at: '', updated_at: '', metadata: {} },
        messageId: 'msg-1',
        sourceChannel: 'whatsapp',
        taskId: 'task-amazon-sg',
      };

      // 1. Candidate A: Single Pack at ₹499 (If buying 3 singles, quantity must be 3 -> ₹1,497)
      // 2. Candidate B: 3-Pack Spigen EZ FIT at ₹899 (Pack size = 3, quantity = 1 -> ₹899)
      // Candidate B is far superior value and fits the "set of three" requirement directly!

      // Add Candidate B (3-Pack) to cart
      const addRes = await addToCart.execute(
        {
          productName: 'Spigen EZ FIT Tempered Glass Screen Protector for iPhone 16 Pro Max (Pack of 3)',
          price: 899,
          merchant: 'Amazon',
          quantity: 1,
          packSize: 3,
          currency: 'INR',
        },
        context
      );

      expect(addRes.success).toBe(true);
      const addData = addRes.data as any;
      expect(addData.packSize).toBe(3);
      expect(addData.totalUnits).toBe(3);
      expect(addData.subtotalMinor).toBe(89900); // ₹899.00

      // Verify cart meets ₹1,500 budget and minPackSize: 3
      const verifyRes = await verifyCart.execute(
        {
          expectedItem: 'Spigen EZ FIT Tempered Glass',
          merchant: 'Amazon',
          maxBudget: 1500,
          minPackSize: 3,
        },
        context
      );

      expect(verifyRes.success).toBe(true);
      const verifyData = verifyRes.data as any;
      expect(verifyData.verified).toBe(true);
      expect(verifyData.itemCount).toBe(1);
      expect(verifyData.formattedTotal).toBe('₹899.00');
    });

    it('rejects cart verification if total exceeds ₹1,500 budget or pack size is insufficient', async () => {
      const user = await db.findOrCreateUserByPhone('+919876543210');
      clearUserCart(user.id);

      const shoppingTools = createShoppingTools(new DuckDuckGoSearchProvider(), db, browserService);
      const addToCart = shoppingTools.find((t) => t.name === 'shopping_add_to_cart')!;
      const verifyCart = shoppingTools.find((t) => t.name === 'shopping_verify_cart')!;

      const context: ToolExecutionContext = {
        user,
        conversation: { id: 'conv-1', user_id: user.id, channel: 'whatsapp', status: 'active', created_at: '', updated_at: '', metadata: {} },
        messageId: 'msg-1',
        sourceChannel: 'whatsapp',
      };

      // Scenario 1: Expensive 3-pack over budget (₹1,899 > ₹1,500)
      await addToCart.execute(
        {
          productName: 'Ultra Armor Sapphire Screen Protector for iPhone 16 Pro Max 3-Pack',
          price: 1899,
          merchant: 'Amazon',
          quantity: 1,
          packSize: 3,
          currency: 'INR',
        },
        context
      );

      const overBudgetRes = await verifyCart.execute(
        {
          expectedItem: 'Ultra Armor',
          merchant: 'Amazon',
          maxBudget: 1500,
          minPackSize: 3,
        },
        context
      );

      expect(overBudgetRes.success).toBe(false);
      const overBudgetData = overBudgetRes.data as any;
      expect(overBudgetData.budgetExceeded).toBe(true);
      expect(overBudgetRes.error).toContain('exceeds budget limit of ₹1500');

      // Scenario 2: Single pack when 3-pack was requested
      clearUserCart(user.id);
      await addToCart.execute(
        {
          productName: 'Single Screen Protector for iPhone 16 Pro Max',
          price: 499,
          merchant: 'Amazon',
          quantity: 1,
          packSize: 1,
          currency: 'INR',
        },
        context
      );

      const insufficientPackRes = await verifyCart.execute(
        {
          expectedItem: 'Single Screen Protector',
          merchant: 'Amazon',
          maxBudget: 1500,
          minPackSize: 3,
        },
        context
      );

      expect(insufficientPackRes.success).toBe(false);
      const insufficientPackData = insufficientPackRes.data as any;
      expect(insufficientPackData.insufficientPackSize).toBe(true);
      expect(insufficientPackRes.error).toContain('does not satisfy required 3-pack size');
    });

    it('captures cart screenshot and delivers it via WhatsApp Cloud API', async () => {
      const mockWhatsAppClient = {
        sendTextMessage: vi.fn().mockResolvedValue({ messageId: 'wamid.123' }),
        sendImageMessage: vi.fn().mockResolvedValue({ messageId: 'wamid.img.456' }),
        uploadMedia: vi.fn().mockResolvedValue({ mediaId: 'media-amazon-cart-789' }),
        downloadMedia: vi.fn().mockResolvedValue(Buffer.from('fake-image-bytes')),
      };

      // Mock screenshot on browserService
      vi.spyOn(browserService, 'takeScreenshot').mockResolvedValue({
        buffer: Buffer.from('fake-screenshot-data'),
        base64: Buffer.from('fake-screenshot-data').toString('base64'),
        mimeType: 'image/jpeg',
      });

      const browserTools = createBrowserTools(browserService, mockWhatsAppClient as any);
      const screenshotTool = browserTools.find((t) => t.name === 'browser_screenshot')!;

      const user = await db.findOrCreateUserByPhone('+919876543210');
      const context: ToolExecutionContext = {
        user,
        conversation: { id: 'conv-1', user_id: user.id, channel: 'whatsapp', status: 'active', created_at: '', updated_at: '', metadata: {} },
        messageId: 'msg-1',
        sourceChannel: 'whatsapp',
      };

      const result = await screenshotTool.execute(
        {
          caption: 'Here is your Amazon cart with the Spigen 3-pack iPhone 16 Pro Max screen guard (₹899).',
          fullPage: false,
        },
        context
      );

      expect(result.success).toBe(true);
      const screenshotData = result.data as any;
      expect(screenshotData.deliveredToWhatsApp).toBe(true);
      expect(screenshotData.mediaId).toBe('media-amazon-cart-789');
      expect(mockWhatsAppClient.uploadMedia).toHaveBeenCalled();
      expect(mockWhatsAppClient.sendImageMessage).toHaveBeenCalledWith(
        '+919876543210',
        'media-amazon-cart-789',
        expect.stringContaining('Amazon cart with the Spigen 3-pack')
      );
    });

    it('strictly requires user confirmation before proceeding with checkout', async () => {
      const user = await db.findOrCreateUserByPhone('+919876543210');
      const shoppingTools = createShoppingTools(new DuckDuckGoSearchProvider(), db, browserService);
      const checkoutTool = shoppingTools.find((t) => t.name === 'shopping_checkout')!;

      const context: ToolExecutionContext = {
        user,
        conversation: { id: 'conv-1', user_id: user.id, channel: 'whatsapp', status: 'active', created_at: '', updated_at: '', metadata: {} },
        messageId: 'msg-1',
        sourceChannel: 'whatsapp',
        isUserConfirmed: false,
      };

      // Verify requiresApproval returns true for checkout
      const approvalCheck = await checkoutTool.requiresApproval({}, context);
      expect(approvalCheck.required).toBe(true);

      // Attempting checkout without isUserConfirmed: true must throw ApprovalRequiredError
      await expect(
        checkoutTool.execute({ merchant: 'Amazon' }, context)
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // BUG 4: PRODUCTION MEMORY SCHEMA CONTRACT & FALLBACK
  // =========================================================================
  describe('BUG 4: Production Memory Schema Contract & Robustness', () => {
    it('saves and retrieves memory with confirmed field preserved across operations', async () => {
      const user = await db.findOrCreateUserByPhone('+919876543210');

      const saved = await db.saveMemory({
        user_id: user.id,
        category: 'shopping_preferences',
        key: 'phone_model',
        value: 'iPhone 16 Pro Max',
        confidence: 1.0,
        confirmed: true,
        source: 'EXPLICIT_USER_STATEMENT',
        metadata: { preferredBrand: 'Spigen' },
      });

      expect(saved.key).toBe('phone_model');
      expect(saved.value).toBe('iPhone 16 Pro Max');
      expect(saved.confirmed).toBe(true);

      const retrieved = await db.getUserMemories(user.id, 'shopping_preferences');
      expect(retrieved.length).toBeGreaterThanOrEqual(1);
      const found = retrieved.find((m) => m.key === 'phone_model');
      expect(found).toBeDefined();
      expect(found?.confirmed).toBe(true);
      expect(found?.metadata?.preferredBrand).toBe('Spigen');
    });
  });
});
