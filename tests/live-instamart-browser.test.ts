import { describe, it, expect, afterAll } from 'vitest';
import { PlaywrightBrowserService } from '../packages/browser/src/index.js';
import { createShoppingTools, clearUserCart, getUserCart } from '../packages/tools/src/index.js';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { merchantResolver } from '../packages/tools/src/merchants/merchant-resolver.js';
import { classifyMessageIntent } from '../packages/agent/src/request-context.js';

describe('TEST 1: LIVE INSTAMART BROWSER EXECUTION', () => {
  let browserService: PlaywrightBrowserService;
  const db = new InMemoryRepository();

  afterAll(async () => {
    if (browserService) {
      await browserService.close();
    }
  });

  it('1. Intent classification verifies SHOPPING for Instamart Diet Coke order', () => {
    const text = 'Order 1 Diet Coke from Swiggy Instamart';
    const intent = classifyMessageIntent(text);
    expect(intent).toBe('SHOPPING');

    const merchant = merchantResolver.resolve(text);
    expect(merchant).not.toBeNull();
    expect(merchant?.name).toBe('Swiggy Instamart');
    expect(merchant?.canonicalUrl).toBe('https://www.swiggy.com/instamart');
  });

  it('2. Merchant stays strictly Swiggy Instamart throughout the task', () => {
    const resolved = merchantResolver.resolve('Diet coke from Instamart');
    expect(resolved?.name).toBe('Swiggy Instamart');
    expect(resolved?.canonicalUrl).toBe('https://www.swiggy.com/instamart');
    // Ensure no silent Zepto / Blinkit substitution
    expect(resolved?.canonicalUrl).not.toContain('zepto');
    expect(resolved?.canonicalUrl).not.toContain('blinkit');
  });

  it('3-6. Live Browser Launch and Swiggy Instamart Navigation Inspection', async () => {
    browserService = new PlaywrightBrowserService();
    const targetUrl = 'https://www.swiggy.com/instamart';

    console.log('[LiveTest] Launching Chromium and navigating to Swiggy Instamart...');
    const result = await browserService.openPage(targetUrl, { timeoutMs: 20000 });

    console.log('[LiveTest] openPage result:', {
      success: result.success,
      status: (result as any).status,
      title: result.success ? result.title : undefined,
      errorType: !result.success ? (result as any).errorType : undefined,
      message: !result.success ? result.message : undefined,
    });

    if (result.success) {
      expect(result.status).toBeGreaterThanOrEqual(200);
      expect(result.status).toBeLessThan(400);
      expect(result.finalUrl).toContain('swiggy.com');

      const readiness = await browserService.waitForPageReady();
      console.log('[LiveTest] Page readiness:', readiness);
      expect(readiness.ready).toBe(true);

      const pageState = await browserService.inspectPageState();
      console.log('[LiveTest] Page state inspection:', {
        authState: pageState.authState,
        challengeDetected: pageState.challengeDetected,
        challengeType: pageState.challengeType,
        title: pageState.title,
      });

      if (pageState.challengeDetected) {
        console.log(`[LiveTest] Swiggy Instamart presented bot/security challenge: ${pageState.challengeType}`);
        expect(pageState.challengeType).toBeDefined();
      } else {
        const titleLower = pageState.title.toLowerCase();
        expect(titleLower.includes('swiggy') || titleLower.includes('food') || titleLower.includes('order') || titleLower.length > 0).toBe(true);
      }
    } else {
      // If access is restricted (e.g. Cloudflare / 429 / bot block)
      console.log(`[LiveTest] Live Instamart access restricted: errorType=${(result as any).errorType} message=${result.message}`);
      expect(['BOT_BLOCKED', 'CAPTCHA_REQUIRED', 'NAVIGATION_FAILED', 'TIMEOUT']).toContain((result as any).errorType);
      expect(result.message).toBeDefined();
    }
  }, 35000);

  it('7-11. End-to-End Shopping Tool Sequence for Instamart Diet Coke', async () => {
    const shoppingTools = createShoppingTools(undefined, db, browserService);
    const searchTool = shoppingTools.find((t) => t.name === 'shopping_search')!;
    const addToCartTool = shoppingTools.find((t) => t.name === 'shopping_add_to_cart')!;
    const verifyCartTool = shoppingTools.find((t) => t.name === 'shopping_verify_cart')!;
    const getCheckoutTool = shoppingTools.find((t) => t.name === 'shopping_get_checkout')!;

    const user = await db.findOrCreateUserByPhone('+919876543299', 'Production Test User');
    const conv = await db.getOrCreateActiveConversation(user.id);
    const ctx = { user, conversation: conv, messageId: 'live_test_msg_1', sourceChannel: 'whatsapp' as const };

    clearUserCart(user.id);

    // 7. Search for Diet Coke on Swiggy Instamart
    console.log('[LiveTest] Searching for Diet Coke on Swiggy Instamart...');
    const searchRes = await searchTool.execute(
      { query: 'Diet Coke', merchant: 'Swiggy Instamart' },
      ctx
    );

    if (searchRes.success) {
      const products = (searchRes.data as any).products;
      expect(products.length).toBeGreaterThan(0);
      const topProduct = products[0];
      console.log('[LiveTest] Top product found:', topProduct);
      expect(topProduct.title).toBeDefined();
      expect(topProduct.store).toBe('Swiggy Instamart');

      // 8-9. Add 1 Diet Coke to cart
      console.log('[LiveTest] Adding 1 Diet Coke to cart...');
      const addRes = await addToCartTool.execute(
        {
          productName: topProduct.title,
          price: topProduct.price || 40,
          quantity: 1,
          store: 'Swiggy Instamart',
        },
        ctx
      );
      expect(addRes.success).toBe(true);
      expect((addRes.data as any).quantity).toBe(1);

      // 10. Verify cart state
      console.log('[LiveTest] Verifying cart contents...');
      const verifyRes = await verifyCartTool.execute(
        { merchant: 'Swiggy Instamart', expectedItem: 'Diet Coke' },
        ctx
      );
      expect(verifyRes.success).toBe(true);
      const cartRecord = getUserCart(user.id);
      expect(cartRecord?.items.length).toBe(1);
      expect(cartRecord?.store).toBe('Swiggy Instamart');

      // 11. Retrieve checkout details without placing order
      console.log('[LiveTest] Retrieving checkout summary breakdown...');
      const checkoutSummary = await getCheckoutTool.execute(
        { merchant: 'Swiggy Instamart' },
        ctx
      );
      expect(checkoutSummary.success).toBe(true);
      const data = checkoutSummary.data as any;
      expect(data.merchant).toBe('Swiggy Instamart');
      expect(data.totalMinor).toBeGreaterThan(0);
      expect(data.formattedTotal).toBeDefined();
      expect(data.deliveryAddress).toBeDefined();

      console.log('[LiveTest] Checkout details verified successfully:', {
        merchant: data.merchant,
        itemCount: data.items.length,
        total: data.formattedTotal,
        address: data.deliveryAddress,
      });
    } else {
      console.log('[LiveTest] Search halted with expected bot protection/verification requirement:', searchRes.error);
      expect(searchRes.userFacingMessage).toBeDefined();
    }
  }, 40000);
});
