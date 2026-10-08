import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';
import { PlaywrightBrowserService, detectCaptchaOrBotBlock } from '../packages/browser/src/index.js';
import { createBrowserTools } from '../packages/tools/src/tools/browser-tools.js';
import { createShoppingTools } from '../packages/tools/src/tools/shopping-tools.js';
import { createWalletTools } from '../packages/tools/src/tools/wallet-tools.js';
import { createTravelTools } from '../packages/tools/src/tools/travel-tools.js';
import { WalletService } from '../packages/tools/src/wallet/wallet-service.js';
import { ApprovalRequiredError } from '@nexa/shared';
import { IdentityManager } from '../packages/agent/src/identity.js';

describe('Autonomous Computer-Use & Agent Capability Suite (All 16 Scenarios)', () => {
  let db: InMemoryRepository;
  let browserService: PlaywrightBrowserService;
  let toolRegistry: any;

  beforeEach(() => {
    db = new InMemoryRepository();
    browserService = new PlaywrightBrowserService();
    toolRegistry = createDefaultToolRegistry({ db, browserService });
  });

  // --------------------------------------------------------------------------
  // Scenario 1: Simple Execution (Single Turn Direct Reply Without Tool Loops)
  // --------------------------------------------------------------------------
  it('Scenario 1: Simple execution - direct conversational reply without tool loops', async () => {
    const mockAi = new MockAIProvider(async (_messages) => {
      return {
        text: 'Hello! How are you doing today?',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const result = await orchestrator.processMessage({
      phoneNumber: '+15551000001',
      name: 'Rohan',
      nameConfirmed: true,
      text: 'Hello NEXA',
    });

    expect(result.replyText).toBe('Hello! How are you doing today?');
    expect(result.stepsCount).toBe(1);
    expect(result.requiresApproval).toBeFalsy();
  });

  // --------------------------------------------------------------------------
  // Scenario 2: Multi-Step Execution (Plan -> Search -> Select -> Synthesize)
  // --------------------------------------------------------------------------
  it('Scenario 2: Multi-step execution - plan, execute tools, synthesize result across turns', async () => {
    let turn = 0;
    const mockAi = new MockAIProvider(async (_messages) => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_search',
              name: 'web_search',
              arguments: { query: 'best laptops under 60000 INR' },
            },
          ],
        };
      }
      return {
        text: 'Based on the search, here are top 3 laptops under ₹60,000...',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const result = await orchestrator.processMessage({
      phoneNumber: '+15551000002',
      name: 'Priya',
      nameConfirmed: true,
      text: 'Find me the best laptops under 60000',
    });

    expect(result.stepsCount).toBe(2);
    expect(result.replyText).toContain('top 3 laptops under ₹60,000');
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Tool Selection (Appropriate Tool Selection by Intent)
  // --------------------------------------------------------------------------
  it('Scenario 3: Tool selection - selects shopping tools for product requests and browser for navigation', async () => {
    let capturedTool = '';
    const mockAi = new MockAIProvider(async (messages) => {
      const last = messages[messages.length - 1];
      if (last.content.includes('milk')) {
        capturedTool = 'search_products';
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_prod',
              name: 'search_products',
              arguments: { query: 'Amul Taaza Milk 1L' },
            },
          ],
        };
      }
      return { text: 'Product search complete.' };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    await orchestrator.processMessage({
      phoneNumber: '+15551000003',
      name: 'Karan',
      nameConfirmed: true,
      text: 'Search for Amul Taaza milk',
    });

    expect(capturedTool).toBe('search_products');
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Browser Session Persistence
  // --------------------------------------------------------------------------
  it('Scenario 4: Browser session persistence - persists session metadata and cart across operations', async () => {
    const sessionId = 'session_test_user_4';
    const session = browserService.getOrCreateSession(sessionId, 'user_4');

    expect(session.sessionId).toBe(sessionId);
    expect(session.userId).toBe('user_4');
    expect(session.cartState?.items).toEqual([]);

    // Update session state
    browserService.updateSessionState(sessionId, {
      activeUrl: 'https://blinkit.com/cart',
      cartState: {
        items: [{ name: 'Bread', quantity: 2, priceMinor: 8000 }],
        totalPriceMinor: 8000,
        currency: 'INR',
      },
    });

    const retrieved = browserService.getSessionMetadata(sessionId);
    expect(retrieved?.activeUrl).toBe('https://blinkit.com/cart');
    expect(retrieved?.cartState?.items.length).toBe(1);
    expect(retrieved?.cartState?.totalPriceMinor).toBe(8000);
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Task Recovery (Restore Session and Verify Cart)
  // --------------------------------------------------------------------------
  it('Scenario 5: Task recovery - restores session and verifies cart after interruption', async () => {
    const sessionId = 'session_recovery_5';
    browserService.getOrCreateSession(sessionId);
    browserService.updateSessionState(sessionId, {
      activeUrl: 'https://example.com/checkout',
      cartState: {
        items: [{ name: 'Coffee Beans 500g', quantity: 1, priceMinor: 45000 }],
        totalPriceMinor: 45000,
        currency: 'INR',
      },
    });

    // Mock openPage for restoreSession reconnection
    vi.spyOn(browserService, 'openPage').mockResolvedValueOnce({
      success: true,
      finalUrl: 'https://example.com/checkout',
      status: 200,
      title: 'Checkout Page',
      text: 'Items in your cart: Coffee Beans 500g Quantity: 1 Price: Rs 450',
    });

    const restoreResult = await browserService.restoreSession(sessionId);
    expect(restoreResult.success).toBe(true);
    expect(restoreResult.reconnectedUrl).toBe('https://example.com/checkout');
    expect(restoreResult.verifiedCart).toBeDefined();
    expect(restoreResult.verifiedCart?.items.length).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Duplicate-Action Prevention
  // --------------------------------------------------------------------------
  it('Scenario 6: Duplicate-action prevention - blocks consecutive clicks on cart/checkout within 10s', () => {
    const sessionId = 'session_dup_6';
    browserService.getOrCreateSession(sessionId);

    // First click is permitted
    const check1 = browserService.canExecuteAction(sessionId, 'click', 'button.add-to-cart');
    expect(check1.allowed).toBe(true);

    // Record the first action
    browserService.recordAction(sessionId, {
      action: 'click',
      target: 'button.add-to-cart',
      timestamp: Date.now(),
      success: true,
    });

    // Second immediate click on same button is blocked
    const check2 = browserService.canExecuteAction(sessionId, 'click', 'button.add-to-cart');
    expect(check2.allowed).toBe(false);
    expect(check2.reason).toContain('Duplicate click');
  });

  // --------------------------------------------------------------------------
  // Scenario 7: Screenshot Understanding & Delivery
  // --------------------------------------------------------------------------
  it('Scenario 7: Screenshot understanding - captures viewport and delivers image', async () => {
    const mockSender = {
      sendImage: vi.fn().mockResolvedValue(true),
      uploadMedia: vi.fn().mockResolvedValue({ mediaId: 'media_screenshot_123' }),
      sendImageMessage: vi.fn().mockResolvedValue(true),
    };

    const tools = createBrowserTools(browserService, mockSender);
    const screenshotTool = tools.find((t) => t.name === 'browser_screenshot');
    expect(screenshotTool).toBeDefined();

    // Mock browserService takeScreenshot
    vi.spyOn(browserService, 'takeScreenshot').mockResolvedValueOnce({
      buffer: Buffer.from('fake_image_png'),
      mimeType: 'image/png',
      base64: Buffer.from('fake_image_png').toString('base64'),
    } as any);

    const res = await screenshotTool!.execute(
      { caption: 'Webpage preview' },
      {
        user: { id: 'user_7', phone_number: '+15551000007' } as any,
        whatsappClient: mockSender,
      } as any
    );

    expect(res.success).toBe(true);
    expect(mockSender.uploadMedia).toHaveBeenCalled();
    expect(mockSender.sendImageMessage).toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Scenario 8: Voice Input Processing
  // --------------------------------------------------------------------------
  it('Scenario 8: Voice input - multimodal voice note input processed gracefully', async () => {
    const mockAi = new MockAIProvider(async (messages) => {
      const last = messages[messages.length - 1];
      expect(last.media).toBeDefined();
      expect(last.media?.mimeType).toBe('audio/ogg; codecs=opus');
      return {
        text: 'I heard your voice message asking for the weather.',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const result = await orchestrator.processMessage({
      phoneNumber: '+15551000008',
      name: 'Sameer',
      nameConfirmed: true,
      text: '',
      audioBuffer: Buffer.from('simulated_voice_note_bytes'),
      audioMimeType: 'audio/ogg; codecs=opus',
    });

    expect(result.replyText).toContain('I heard your voice message');
    expect(result.stepsCount).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Scenario 9: Approval Workflows for Consequential Actions
  // --------------------------------------------------------------------------
  it('Scenario 9: Approval workflows - consequential action pauses and requires explicit approval', async () => {
    let turn = 0;
    const mockAi = new MockAIProvider(async (_messages) => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_checkout',
              name: 'shopping_checkout',
              arguments: { store: 'Blinkit', amount: 549, itemSummary: 'Milk, Bread, Eggs' },
            },
          ],
        };
      }
      return {
        text: "Understood. The order is on hold until you confirm.",
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const userPhone = '+15551000009';

    // Step A: First request triggers approval requirement
    const result1 = await orchestrator.processMessage({
      phoneNumber: userPhone,
      name: 'Aditi',
      nameConfirmed: true,
      text: 'Place the order on Blinkit',
    });

    expect(result1.requiresApproval).toBe(true);
    expect(result1.replyText).toContain('*Action*: Place Purchase Order');
    expect(result1.replyText).toContain('Blinkit');

    // Step B: Casual comment does NOT approve
    const casualResult = await orchestrator.processMessage({
      phoneNumber: userPhone,
      name: 'Aditi',
      nameConfirmed: true,
      text: 'That sounds cool',
    });
    // Still not executed, casual comment does not approve
    expect(casualResult.requiresApproval).toBeFalsy();

    // Step C: Explicit user confirmation completes the action
    const confirmResult = await orchestrator.processMessage({
      phoneNumber: userPhone,
      name: 'Aditi',
      nameConfirmed: true,
      text: 'Yes, proceed',
    });

    expect(confirmResult.replyText).toContain('Order placed successfully');
  });

  // --------------------------------------------------------------------------
  // Scenario 10: Real-World Action Verification (PLAN -> EXECUTE -> VERIFY -> REPORT)
  // --------------------------------------------------------------------------
  it('Scenario 10: Real-world action verification - verifies items and prices before completion', async () => {
    const shoppingTools = createShoppingTools();
    const addTool = shoppingTools.find((t) => t.name === 'shopping_add_to_cart')!;
    const verifyTool = shoppingTools.find((t) => t.name === 'shopping_verify_cart')!;

    const userCtx = {
      user: { id: 'user_10', phone_number: '+15551000010' } as any,
    } as any;

    // Execute item addition
    await addTool.execute(
      { productName: 'Amul Butter 500g', price: 275, quantity: 2, store: 'Blinkit' },
      userCtx
    );

    // Verify cart contents and calculated price
    const verifyResult = await verifyTool.execute(
      { expectedItem: 'Amul Butter 500g' },
      userCtx
    );

    expect(verifyResult.success).toBe(true);
    const cartData = verifyResult.data as any;
    expect(cartData.itemCount).toBe(1);
    expect(cartData.items[0].quantity).toBe(2);
    expect(cartData.totalMinor).toBe(55000);
    expect(cartData.verified).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Scenario 11: Payment Safety (Integer minor units, positive ledger, confirmation)
  // --------------------------------------------------------------------------
  it('Scenario 11: Payment safety - requires explicit approval, checks balance in integer paise', async () => {
    const walletService = new WalletService(db);
    const walletTools = createWalletTools(walletService);
    const payTool = walletTools.find((t) => t.name === 'wallet_transfer_or_pay')!;

    const user = await db.findOrCreateUserByPhone('+15551000011', 'Rahul');

    // Unconfirmed call must throw ApprovalRequiredError
    await expect(
      payTool.execute(
        { amount: 200, recipient: 'Merchant X', reason: 'Grocery' },
        { user, isUserConfirmed: false } as any
      )
    ).rejects.toThrow(ApprovalRequiredError);

    // Insufficient balance on confirmed call must reject safely
    await expect(
      payTool.execute(
        { amount: 500, recipient: 'Merchant X', reason: 'Grocery' },
        { user, isUserConfirmed: true } as any
      )
    ).rejects.toThrow(/Insufficient/);
  });

  // --------------------------------------------------------------------------
  // Scenario 12: Booking Safety (No fabricated confirmation IDs)
  // --------------------------------------------------------------------------
  it('Scenario 12: Booking safety - itinerary confirmation required and no fabricated PNRs', async () => {
    const travelTools = createTravelTools();
    const bookFlight = travelTools.find((t) => t.name === 'book_flight')!;

    const userCtx = {
      user: { id: 'user_12', phone_number: '+15551000012' } as any,
    } as any;

    // 1. Unconfirmed booking throws ApprovalRequiredError
    await expect(
      bookFlight.execute(
        {
          origin: 'DEL',
          destination: 'BOM',
          departureDate: '2026-11-01',
          flightNumber: '6E-201',
          passengerName: 'Awan',
          price: 4500,
        },
        userCtx
      )
    ).rejects.toThrow(ApprovalRequiredError);

    // 2. Confirmed booking when provider credentials not set clearly indicates manual completion
    const res = await bookFlight.execute(
      {
        origin: 'DEL',
        destination: 'BOM',
        departureDate: '2026-11-01',
        flightNumber: '6E-201',
        passengerName: 'Awan',
        price: 4500,
      },
      { ...userCtx, isUserConfirmed: true }
    );

    expect(res.success).toBe(false);
    expect((res.data as any).bookingReference).toBeUndefined();
    expect(res.userFacingMessage).toContain('airline ticketing is not connected');
  });

  // --------------------------------------------------------------------------
  // Scenario 13: Challenge Detection (Turnstile, reCAPTCHA, Bot Protections)
  // --------------------------------------------------------------------------
  it('Scenario 13: Challenge detection - detects Cloudflare, Turnstile, reCAPTCHA, and bot challenges', () => {
    const turnstileHtml = '<div class="challenges.cloudflare.com turnstile">Just a moment... cloudflare</div>';
    const checkTurnstile = detectCaptchaOrBotBlock(turnstileHtml);
    expect(checkTurnstile.detected).toBe(true);
    expect(checkTurnstile.type).toBe('Cloudflare Challenge');

    const humanVerifyHtml = '<div>Please verify that you are human to continue.</div>';
    const checkHuman = detectCaptchaOrBotBlock(humanVerifyHtml);
    expect(checkHuman.detected).toBe(true);
    expect(checkHuman.type).toBe('Human Verification Challenge');

    const normalHtml = '<div>Welcome to our online store! Enjoy shopping.</div>';
    const checkNormal = detectCaptchaOrBotBlock(normalHtml);
    expect(checkNormal.detected).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Scenario 14: Permanent Creator Identity (Awan Warsi)
  // --------------------------------------------------------------------------
  it('Scenario 14: Permanent creator identity - identifies Awan Warsi as creator across queries', async () => {
    const mockAi = new MockAIProvider(async (_messages) => {
      return {
        text: 'I was built by Awan Warsi — he is the creator behind NEXA.',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const queries = [
      'Who built you?',
      'Who created you?',
      'Who is your developer?',
      'Who developed NEXA?',
    ];

    for (const q of queries) {
      const res = await orchestrator.processMessage({
        phoneNumber: '+15551000014',
        name: 'User 14',
        nameConfirmed: true,
        text: q,
      });
      expect(res.replyText).toContain('Awan Warsi');
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 15: Per-User Persistent Memory & Preferred Titles
  // --------------------------------------------------------------------------
  it('Scenario 15: Persistent memory - preferred title "Boss" is strictly per-user and persists', async () => {
    // User A sets title "Boss"
    const userA = await db.findOrCreateUserByPhone('+15551000015', 'User A');
    const resultA = await IdentityManager.handleInboundMessage({
      user: userA,
      text: 'Call me boss',
      conversationHistory: [],
      db,
    });

    expect(resultA.handled).toBe(true);
    expect(resultA.replyText).toContain('Boss');
    expect(resultA.user.preferred_title).toBe('Boss');
    expect(resultA.user.title_confirmed).toBe(true);

    // User B is independent and not called "Boss"
    const userB = await db.findOrCreateUserByPhone('+15551000016', 'User B');
    expect(userB.preferred_title).toBeFalsy();
    expect(userB.title_confirmed).toBeFalsy();
  });

  // --------------------------------------------------------------------------
  // Scenario 16: End-to-End Shopping Workflow
  // --------------------------------------------------------------------------
  it('Scenario 16: End-to-end shopping workflow - search -> cart -> verify -> approval -> checkout', async () => {
    let step = 0;
    const userPhone = '+15551000017';

    const mockAi = new MockAIProvider(async (_messages) => {
      step++;
      if (step === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_search_prod',
              name: 'search_products',
              arguments: { query: 'Basmati Rice 5kg' },
            },
          ],
        };
      } else if (step === 2) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_add_cart',
              name: 'shopping_add_to_cart',
              arguments: { productName: 'Daawat Basmati Rice 5kg', price: 650, quantity: 1, store: 'Blinkit' },
            },
          ],
        };
      } else if (step === 3) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_verify_cart',
              name: 'shopping_verify_cart',
              arguments: { expectedItem: 'Daawat Basmati Rice 5kg' },
            },
          ],
        };
      } else if (step === 4) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_checkout_final',
              name: 'shopping_checkout',
              arguments: { store: 'Blinkit', amount: 650, itemSummary: 'Daawat Basmati Rice 5kg' },
            },
          ],
        };
      }
      return {
        text: 'Order placed and verified successfully!',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // 1. Initial shopping command
    const res = await orchestrator.processMessage({
      phoneNumber: userPhone,
      name: 'Simran',
      nameConfirmed: true,
      text: 'Order 5kg Daawat Basmati Rice on Blinkit',
    });

    // The workflow executes search -> add -> verify -> checkout, which pauses for approval
    expect(res.requiresApproval).toBe(true);
    expect(res.replyText).toContain('*Action*: Place Purchase Order');
    expect(res.replyText).toContain('₹650.00');

    // 2. User confirms checkout
    const confirmRes = await orchestrator.processMessage({
      phoneNumber: userPhone,
      name: 'Simran',
      nameConfirmed: true,
      text: 'Yes, place order',
    });

    expect(confirmRes.replyText).toContain('Order placed successfully');
    expect(confirmRes.stepsCount).toBe(1);
  });
});
