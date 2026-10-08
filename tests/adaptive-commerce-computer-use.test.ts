import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';
import { PlaywrightBrowserService, ComputerUseResolver } from '../packages/browser/src/index.js';
import {
  merchantResolver,
  createShoppingTools,
} from '../packages/tools/src/index.js';
import { ShoppingStateMachine } from '../packages/agent/src/shopping-state-machine.js';
import { ApprovalRequiredError } from '@nexa/shared';

describe('NEXA Adaptive Computer-Use & Commerce Execution Suite', () => {
  let db: InMemoryRepository;
  let browserService: PlaywrightBrowserService;
  let toolRegistry: any;

  beforeEach(() => {
    db = new InMemoryRepository();
    browserService = new PlaywrightBrowserService();
    toolRegistry = createDefaultToolRegistry({ db, browserService });
  });

  // ==========================================================================
  // 1. Exact Merchant Enforcement: Instamart
  // ==========================================================================
  it('1. Exact Merchant Enforcement - "Order a Diet Coke from Instamart" resolves to Swiggy Instamart', () => {
    const resolved = merchantResolver.resolve('Order a Diet Coke from Instamart.');
    expect(resolved).toBeDefined();
    expect(resolved?.merchantId).toBe('instamart');
    expect(resolved?.name).toBe('Swiggy Instamart');
    expect(resolved?.canonicalUrl).toBe('https://www.swiggy.com/instamart');
    expect(resolved?.shoppingCapability).toBe(true);

    // Exact isolation check: never confused with Blinkit or Amazon
    expect(resolved?.name).not.toBe('Blinkit');
    expect(resolved?.name).not.toBe('Amazon');
  });

  // ==========================================================================
  // 2. Adaptive ComputerUseResolver: Dynamic Element Discovery
  // ==========================================================================
  it('2. ComputerUseResolver discovers search input without brittle selector', async () => {
    const resolver = new ComputerUseResolver();

    // Mock page with an input that has aria-label="Search for products"
    const mockPage: any = {
      url: () => 'https://www.swiggy.com/instamart',
      title: async () => 'Swiggy Instamart - Online Grocery',
      isClosed: () => false,
      evaluate: async (fn: any) => {
        // Return structured discovery matching browser DOM
        return {
          textSummary: 'Swiggy Instamart. Search for groceries and drinks.',
          searchInputs: [
            {
              selector: 'input[aria-label="Search for items"]',
              placeholder: 'Search for groceries, cold drinks...',
              ariaLabel: 'Search for items',
              confidence: 0.95,
            },
          ],
          actionButtons: [
            {
              selector: 'button:has-text("Add to Cart")',
              text: 'Add to Cart',
              targetType: 'add_to_cart',
              confidence: 0.95,
            },
            {
              selector: 'button:has-text("Checkout")',
              text: 'Checkout',
              targetType: 'checkout',
              confidence: 0.95,
            },
          ],
          products: [
            {
              title: 'Diet Coke Can 300ml',
              price: '₹40',
              rawPrice: 40,
            },
          ],
          cartSummary: { itemCount: 1, totalText: '₹40' },
        };
      },
    };

    const observation = await resolver.observePage(mockPage);
    expect(observation.url).toBe('https://www.swiggy.com/instamart');
    expect(observation.searchInputs.length).toBeGreaterThan(0);
    expect(observation.searchInputs[0].targetType).toBe('search_box');
    expect(observation.searchInputs[0].confidence).toBeGreaterThanOrEqual(0.9);

    expect(observation.actionButtons.some((b) => b.targetType === 'add_to_cart')).toBe(true);
    expect(observation.actionButtons.some((b) => b.targetType === 'checkout')).toBe(true);
    expect(observation.products.length).toBe(1);
    expect(observation.products[0].title).toBe('Diet Coke Can 300ml');
  });

  it('3. ComputerUseResolver resolves target by semantic intent', async () => {
    const resolver = new ComputerUseResolver();

    const mockPage: any = {
      url: () => 'https://www.swiggy.com/instamart',
      title: async () => 'Swiggy Instamart',
      isClosed: () => false,
      $: async () => null, // CSS selector fails!
      getByRole: () => ({ count: async () => 0 }),
      getByPlaceholder: () => ({ count: async () => 0 }),
      getByText: () => ({ count: async () => 0 }),
      evaluate: async () => ({
        textSummary: 'Grocery shop',
        searchInputs: [
          {
            selector: 'input#main-search',
            placeholder: 'Search store',
            confidence: 0.9,
          },
        ],
        actionButtons: [
          {
            selector: 'button.btn-add',
            text: 'Add to Cart',
            targetType: 'add_to_cart',
            confidence: 0.95,
          },
        ],
        products: [],
      }),
    };

    const searchTarget = await resolver.resolveTarget(mockPage, 'search', 'search_box');
    expect(searchTarget).toBeDefined();
    expect(searchTarget?.targetType).toBe('search_box');
    expect(searchTarget?.selector).toBe('input#main-search');

    const addTarget = await resolver.resolveTarget(mockPage, 'add', 'add_to_cart');
    expect(addTarget).toBeDefined();
    expect(addTarget?.targetType).toBe('add_to_cart');
    expect(addTarget?.selector).toBe('button.btn-add');
  });

  // ==========================================================================
  // 3. Robust Browser Read: Never crashes on missing selector
  // ==========================================================================
  it('4. browser_read falls back cleanly with page text and observation when selector is missing', async () => {
    (browserService as any).activeUrl = 'https://www.swiggy.com/instamart';
    (browserService as any).ensurePage = async () => ({
      url: () => 'https://www.swiggy.com/instamart',
      title: async () => 'Instamart Grocery',
      isClosed: () => false,
      $: async () => null, // Element not found
      getByRole: () => ({ count: async () => 0 }),
      getByPlaceholder: () => ({ count: async () => 0 }),
      getByText: () => ({ count: async () => 0 }),
      evaluate: async () => 'Fresh groceries delivered in 10 minutes. Diet Coke in stock.',
    });

    const result = await browserService.readPage('input#completely-nonexistent-selector');
    expect(result).toBeDefined();
    expect(result.url).toBe('https://www.swiggy.com/instamart');
    expect(result.text).toContain('Fresh groceries delivered');
    expect(result.text).toContain('Diet Coke');
  });

  // ==========================================================================
  // 4. Shopping State Machine
  // ==========================================================================
  it('5. ShoppingStateMachine enforces legal transitions and rejects skipped steps', () => {
    const sm = new ShoppingStateMachine('INITIAL');

    // 1. Initial -> Searching
    sm.transitionTo('SEARCHING');
    expect(sm.getState()).toBe('SEARCHING');

    // 2. Searching -> Product Found
    sm.transitionTo('PRODUCT_FOUND');
    expect(sm.getState()).toBe('PRODUCT_FOUND');

    // 3. Product Found -> Product Selected
    sm.transitionTo('PRODUCT_SELECTED');
    expect(sm.getState()).toBe('PRODUCT_SELECTED');

    // 4. Product Selected -> Cart Updated
    sm.transitionTo('CART_UPDATED');
    expect(sm.getState()).toBe('CART_UPDATED');

    // 5. Cart Updated -> Cart Verified
    sm.transitionTo('CART_VERIFIED');
    expect(sm.getState()).toBe('CART_VERIFIED');

    // 6. Cart Verified -> Address Selected
    sm.transitionTo('ADDRESS_SELECTED');
    expect(sm.getState()).toBe('ADDRESS_SELECTED');

    // 7. Address Selected -> Checkout Ready
    sm.transitionTo('CHECKOUT_READY');
    expect(sm.getState()).toBe('CHECKOUT_READY');

    // 8. Checkout Ready -> Waiting Approval
    sm.transitionTo('WAITING_APPROVAL');
    expect(sm.getState()).toBe('WAITING_APPROVAL');

    // 9. Waiting Approval -> Checkout Executed
    sm.transitionTo('CHECKOUT_EXECUTED');
    expect(sm.getState()).toBe('CHECKOUT_EXECUTED');

    // 10. Checkout Executed -> Order Verified
    sm.transitionTo('ORDER_VERIFIED');
    expect(sm.getState()).toBe('ORDER_VERIFIED');

    // 11. Order Verified -> Completed
    sm.transitionTo('COMPLETED');
    expect(sm.getState()).toBe('COMPLETED');

    // Terminal: Completed cannot transition to anything
    expect(() => sm.transitionTo('SEARCHING')).toThrow();
  });

  it('6. ShoppingStateMachine verification failure sets FAILED and prevents COMPLETED', () => {
    const sm = new ShoppingStateMachine('CART_UPDATED');
    sm.recordVerificationFailure('Cart items do not match expected product');

    expect(sm.getState()).toBe('FAILED');
    expect(sm.getFailureReason()).toBe('Cart items do not match expected product');
    expect(() => sm.transitionTo('COMPLETED')).toThrow(/Illegal shopping state transition: FAILED -> COMPLETED/);
  });

  // ==========================================================================
  // 5. End-to-End Commerce Smoke Test: "Order a Diet Coke from Instamart"
  // ==========================================================================
  it('7. Full Smoke Test: "Order a Diet Coke from Instamart" (Steps A through L end-to-end)', async () => {
    const consoleSpy = vi.spyOn(console, 'log');

    // A. Open merchant (mock external network navigation for deterministic test execution)
    vi.spyOn(browserService, 'openPage').mockResolvedValue({
      success: true,
      finalUrl: 'https://www.swiggy.com/instamart',
      status: 200,
      title: 'Swiggy Instamart - Online Grocery',
      text: 'Swiggy Instamart home page with search bar for groceries and drinks',
    });
    const openRes = await browserService.openPage('https://www.swiggy.com/instamart');
    expect(openRes.success).toBe(true);

    // Save default address for user in DB
    const user = await db.findOrCreateUserByPhone('+919876543210', 'Awan');
    user.preferred_name = 'Awan';
    user.name_confirmed = true;
    user.name_source = 'USER_CONFIRMED';

    await db.saveUserAddress({
      userId: user.id,
      label: 'Home',
      addressLine1: 'Flat 402, Green Valley Apartments',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      isDefault: true,
    });

    const shoppingTools = createShoppingTools(undefined as any, db, browserService);
    const searchTool = shoppingTools.find((t) => t.name === 'shopping_search')!;
    const selectTool = shoppingTools.find((t) => t.name === 'shopping_select_product')!;
    const addCartTool = shoppingTools.find((t) => t.name === 'shopping_add_to_cart')!;
    const verifyCartTool = shoppingTools.find((t) => t.name === 'shopping_verify_cart')!;
    const getAddressTool = shoppingTools.find((t) => t.name === 'shopping_get_addresses')!;
    const selectAddressTool = shoppingTools.find((t) => t.name === 'shopping_select_address')!;
    const checkoutCalcTool = shoppingTools.find((t) => t.name === 'shopping_get_checkout')!;
    const checkoutTool = shoppingTools.find((t) => t.name === 'shopping_checkout')!;
    const verifyOrderTool = shoppingTools.find((t) => t.name === 'shopping_verify_order')!;

    const context: any = { user, recipientPhone: '+919876543210' };

    // B. Search product
    const searchRes = await searchTool.execute({ query: 'Diet Coke 300ml', merchant: 'Instamart' }, context);
    expect(searchRes.success).toBe(true);
    expect((searchRes.data as any).products.length).toBeGreaterThan(0);

    // C. Select product
    const selectRes = await selectTool.execute({
      productName: 'Diet Coke Can 300ml',
      price: 40,
      merchant: 'Swiggy Instamart',
    }, context);
    expect(selectRes.success).toBe(true);

    // D. Add to cart
    const addRes = await addCartTool.execute({
      productName: 'Diet Coke Can 300ml',
      price: 40,
      merchant: 'Swiggy Instamart',
      quantity: 1,
    }, context);
    expect(addRes.success).toBe(true);

    // E. Verify cart (minor units paise verification: ₹40 = 4000 paise)
    const verifyCartRes = await verifyCartTool.execute({
      expectedItem: 'Diet Coke Can 300ml',
      merchant: 'Swiggy Instamart',
    }, context);
    expect(verifyCartRes.success).toBe(true);
    expect((verifyCartRes.data as any).verified).toBe(true);
    expect((verifyCartRes.data as any).subtotalMinor).toBe(4000);

    // F. Retrieve saved address
    const getAddrRes = await getAddressTool.execute({}, context);
    expect(getAddrRes.success).toBe(true);
    expect((getAddrRes.data as any).addresses.length).toBe(1);

    // G. Select address
    const selectAddrRes = await selectAddressTool.execute({ addressLabel: 'Home' }, context);
    expect(selectAddrRes.success).toBe(true);

    // H. Calculate checkout
    const checkoutCalcRes = await checkoutCalcTool.execute({ merchant: 'Swiggy Instamart' }, context);
    expect(checkoutCalcRes.success).toBe(true);
    expect((checkoutCalcRes.data as any).totalMinor).toBe(6500); // 4000 + 2500 delivery fee

    // I. Ask approval (Unconfirmed checkout MUST throw ApprovalRequiredError)
    await expect(checkoutTool.execute({ merchant: 'Swiggy Instamart' }, { ...context, isUserConfirmed: false }))
      .rejects.toThrow(ApprovalRequiredError);

    // J. Verify approval prompt details
    try {
      await checkoutTool.execute({ merchant: 'Swiggy Instamart' }, { ...context, isUserConfirmed: false });
    } catch (err: any) {
      expect(err.prompt).toContain('Swiggy Instamart');
      expect(err.prompt).toContain('Diet Coke Can 300ml');
      expect(err.prompt).toContain('₹65.00');
    }

    // K. Execute confirmed checkout
    const checkoutConfirmedRes = await checkoutTool.execute(
      { merchant: 'Swiggy Instamart' },
      { ...context, isUserConfirmed: true }
    );
    expect(checkoutConfirmedRes.success).toBe(true);
    const orderId = (checkoutConfirmedRes.data as any).orderId;
    expect(orderId).toBeDefined();

    // L. Verify external order confirmation
    const verifyOrderRes = await verifyOrderTool.execute({ orderId }, context);
    expect(verifyOrderRes.success).toBe(true);
    expect((verifyOrderRes.data as any).status).toBe('confirmed');
    expect((verifyOrderRes.data as any).merchant).toBe('Swiggy Instamart');

    consoleSpy.mockRestore();
  });
});
