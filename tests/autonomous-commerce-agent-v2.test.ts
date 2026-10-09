import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';
import { PlaywrightBrowserService } from '../packages/browser/src/index.js';
import {
  merchantResolver,
  MerchantResolver,
  ConnectedAccountManager,
} from '../packages/tools/src/index.js';
import { credentialVault } from '../packages/security/src/index.js';
import { TaskStateMachine } from '../packages/agent/src/task-state-machine.js';
import {
  ApprovalRequiredError,
  ToolExecutionError,
} from '@nexa/shared';

describe('NEXA Autonomous Account + Commerce Agent V2 Suite', () => {
  let db: InMemoryRepository;
  let browserService: PlaywrightBrowserService;
  let toolRegistry: any;

  beforeEach(() => {
    db = new InMemoryRepository();
    browserService = new PlaywrightBrowserService();
    toolRegistry = createDefaultToolRegistry({ db, browserService });
  });

  // ==========================================================================
  // 1. Exact Merchant Routing
  // ==========================================================================
  it('1. Exact merchant routing - resolves Blinkit, Zepto, and Amazon correctly', () => {
    const blinkitMatch = merchantResolver.resolve('Order a Diet Coke from Blinkit');
    expect(blinkitMatch).toBeDefined();
    expect(blinkitMatch?.merchantId).toBe('blinkit');
    expect(blinkitMatch?.name).toBe('Blinkit');
    expect(blinkitMatch?.canonicalUrl).toBe('https://blinkit.com');
    expect(blinkitMatch?.shoppingCapability).toBe(true);

    const zeptoMatch = merchantResolver.resolve('order groceries on zepto');
    expect(zeptoMatch).toBeDefined();
    expect(zeptoMatch?.merchantId).toBe('zepto');
    expect(zeptoMatch?.name).toBe('Zepto');

    const amazonMatch = merchantResolver.resolve('buy wireless headphones from amazon');
    expect(amazonMatch).toBeDefined();
    expect(amazonMatch?.merchantId).toBe('amazon');
    expect(amazonMatch?.name).toBe('Amazon');
  });

  it('2. Wrong merchant prevention - Blinkit request never routes to other merchants', () => {
    const blinkitReq = 'Order a Diet Coke from Blinkit';
    const resolved = merchantResolver.resolve(blinkitReq);
    expect(resolved?.name).toBe('Blinkit');
    expect(resolved?.name).not.toBe('Amazon');
    expect(resolved?.name).not.toBe('Zepto');
  });

  // ==========================================================================
  // 2. Action Recovery & Inspection
  // ==========================================================================
  it('3. Browser action recovery - recovers typeText when value already present in input', async () => {
    const consoleSpy = vi.spyOn(console, 'log');

    // Mock page with an input where value matches
    (browserService as any).ensurePage = async () => ({
      waitForSelector: async () => {},
      fill: async () => {
        throw new Error('Timeout 12000ms exceeded');
      },
      isClosed: () => false,
      $eval: async (_sel: string, _fn: any) => 'Diet Coke 300ml',
    });

    const result = await browserService.typeText('input[name="search"]', 'Diet Coke');
    expect(result.success).toBe(true);
    expect(result.recovered).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ComputerUse] action_recovered type target="input[name="search"]"')
    );
    consoleSpy.mockRestore();
  });

  // ==========================================================================
  // 3. Failed Actions Cannot Produce task_completed
  // ==========================================================================
  it('4. Failed browser_type cannot produce task_completed', async () => {
    const consoleSpy = vi.spyOn(console, 'log');

    const mockAi = new MockAIProvider(async (_messages) => {
      return {
        text: '',
        toolCalls: [
          {
            id: 'call_type',
            name: 'browser_type',
            arguments: { selector: 'input#nonexistent', text: 'Diet Coke' },
          },
        ],
      };
    });

    // Mock ensurePage throwing error
    (browserService as any).ensurePage = async () => ({
      waitForSelector: async () => {
        throw new Error('Element not found');
      },
      fill: async () => {},
      isClosed: () => false,
      $eval: async () => '',
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db, 1);
    const result = await orchestrator.processMessage({
      phoneNumber: '+15552000001',
      name: 'Rahul',
      nameConfirmed: true,
      text: 'Order a Diet Coke from Blinkit',
    });

    // Verify task_failed was logged and task_completed was NEVER logged
    const logs = consoleSpy.mock.calls.map((c) => c.join(' '));
    const hasTaskFailed = logs.some((l) => l.includes('[Agent] task_failed'));
    const hasTaskCompleted = logs.some((l) => l.includes('[Agent] task_completed'));

    expect(hasTaskFailed).toBe(true);
    expect(hasTaskCompleted).toBe(false);
    expect(result.replyText).not.toContain('I have gathered the information for your request');
    consoleSpy.mockRestore();
  });

  it('5. Failed browser_click cannot produce task_completed', async () => {
    const consoleSpy = vi.spyOn(console, 'log');

    const mockAi = new MockAIProvider(async (_messages) => {
      return {
        text: '',
        toolCalls: [
          {
            id: 'call_click',
            name: 'browser_click',
            arguments: { selector: 'button#missing' },
          },
        ],
      };
    });

    (browserService as any).ensurePage = async () => ({
      waitForSelector: async () => {
        throw new Error('Timeout waiting for selector');
      },
      click: async () => {},
      isClosed: () => false,
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db, 1);
    await orchestrator.processMessage({
      phoneNumber: '+15552000002',
      name: 'Rahul',
      nameConfirmed: true,
      text: 'Click the buy button',
    });

    const logs = consoleSpy.mock.calls.map((c) => c.join(' '));
    expect(logs.some((l) => l.includes('[Agent] task_failed'))).toBe(true);
    expect(logs.some((l) => l.includes('[Agent] task_completed'))).toBe(false);
    consoleSpy.mockRestore();
  });

  it('6. Failed checkout cannot produce task_completed', async () => {
    const consoleSpy = vi.spyOn(console, 'log');

    // Tool throws error during confirmed checkout
    toolRegistry.register({
      name: 'shopping_checkout',
      description: 'Checkout',
      riskLevel: 'high_risk',
      parametersSchema: { shape: {} } as any,
      requiresApproval: () => ({ required: false }),
      execute: async () => {
        throw new Error('Payment gateway unavailable');
      },
    });

    const mockAi = new MockAIProvider(async (_messages) => {
      return {
        text: '',
        toolCalls: [
          {
            id: 'call_checkout',
            name: 'shopping_checkout',
            arguments: { store: 'Blinkit', amount: 65, itemSummary: '1x Diet Coke' },
          },
        ],
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db, 1);
    await orchestrator.processMessage({
      phoneNumber: '+15552000003',
      name: 'Rahul',
      nameConfirmed: true,
      text: 'Confirm checkout for Blinkit',
    });

    const logs = consoleSpy.mock.calls.map((c) => c.join(' '));
    expect(logs.some((l) => l.includes('[Agent] task_failed'))).toBe(true);
    expect(logs.some((l) => l.includes('[Agent] task_completed'))).toBe(false);
    consoleSpy.mockRestore();
  });

  // ==========================================================================
  // 4. Secure Connected Account System & Credential Vault
  // ==========================================================================
  it('7. Secure connected account - encrypted storage and in-memory decryption only', async () => {
    const accountManager = new ConnectedAccountManager(db);
    const userId = 'usr_test_123';

    await accountManager.connectAccount({
      userId,
      merchant: 'Blinkit',
      accountId: 'blinkit_user_99',
      credentials: {
        phone: '+919876543210',
        sessionToken: 'secret_session_token_xyz',
      },
    });

    // Verify in database: credentials are encrypted and NOT in plaintext!
    const stored = await db.getConnectedAccount(userId, 'blinkit');
    expect(stored).toBeDefined();
    expect(stored?.token_data.sessionToken).not.toBe('secret_session_token_xyz');
    expect(String(stored?.token_data.sessionToken)).toContain('aes256gcm:');

    // Decrypt strictly in-memory
    const decrypted = await accountManager.getDecryptedCredentials<any>(userId, 'Blinkit');
    expect(decrypted?.sessionToken).toBe('secret_session_token_xyz');
    expect(decrypted?.phone).toBe('+919876543210');
  });

  it('8. Authentication expiry handling - marks session expired and restores when active', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const accountManager = new ConnectedAccountManager(db);
    const userId = 'usr_test_456';

    await accountManager.updateSessionState(userId, 'Blinkit', 'AUTHENTICATED');
    let session = await accountManager.getSessionState(userId, 'Blinkit');
    expect(session?.authState).toBe('AUTHENTICATED');

    // Mark expired
    await accountManager.markSessionExpired(userId, 'Blinkit');
    session = await accountManager.getSessionState(userId, 'Blinkit');
    expect(session?.authState).toBe('AUTH_EXPIRED');

    const logs = consoleSpy.mock.calls.map((c) => c.join(' '));
    expect(logs.some((l) => l.includes('[Account] session_expired merchant=Blinkit'))).toBe(true);
    consoleSpy.mockRestore();
  });

  // ==========================================================================
  // 5. Saved Address Handling
  // ==========================================================================
  it('9. Saved address handling - retrieves saved addresses and selects delivery address', async () => {
    const user = await db.findOrCreateUserByPhone('+15553000001', 'Rahul');
    await db.saveUserAddress({
      userId: user.id,
      merchant: 'Blinkit',
      label: 'Home',
      addressLine1: 'Flat 101, Palm Grove, Bandra West',
      city: 'Mumbai',
      pincode: '400050',
      isDefault: true,
    });

    const getAddrTool = toolRegistry.getTool('shopping_get_addresses');
    const res = await getAddrTool.execute({ merchant: 'Blinkit' }, {
      user,
      conversation: { id: 'c1' } as any,
      sourceChannel: 'whatsapp',
    });

    expect(res.success).toBe(true);
    expect(res.data.count).toBe(1);
    expect(res.data.defaultAddress.addressLine1).toContain('Palm Grove');

    const selectAddrTool = toolRegistry.getTool('shopping_select_address');
    const selRes = await selectAddrTool.execute({ addressLabel: 'Home', merchant: 'Blinkit' }, {
      user,
      conversation: { id: 'c1' } as any,
      sourceChannel: 'whatsapp',
    });
    expect(selRes.success).toBe(true);
  });

  // ==========================================================================
  // 6. Commerce Workflow: Search -> Select -> Add to Cart -> Verify Cart
  // ==========================================================================
  it('10. Shopping workflow - add to cart and verify cart in paise minor units', async () => {
    const user = await db.findOrCreateUserByPhone('+15553000002', 'Rahul');
    const context = {
      user,
      conversation: { id: 'c2' } as any,
      sourceChannel: 'whatsapp',
    };

    const addTool = toolRegistry.getTool('shopping_add_to_cart');
    const addRes = await addTool.execute(
      { productName: 'Diet Coke 300ml', price: 40, store: 'Blinkit', quantity: 1, currency: 'INR' },
      context
    );

    expect(addRes.success).toBe(true);
    expect(addRes.data.cartTotalMinor).toBe(4000); // 4000 paise = ₹40

    const verifyTool = toolRegistry.getTool('shopping_verify_cart');
    const verifyRes = await verifyTool.execute({ expectedItem: 'Diet Coke' }, context);

    expect(verifyRes.success).toBe(true);
    expect(verifyRes.data.verified).toBe(true);
    expect(verifyRes.data.itemCount).toBe(1);
    expect(verifyRes.data.totalMinor).toBe(4000);
  });

  // ==========================================================================
  // 7. Checkout Approval & Order Verification
  // ==========================================================================
  it('11. Checkout requires explicit approval and formats detailed prompt', async () => {
    const user = await db.findOrCreateUserByPhone('+15553000003', 'Rahul');
    const context = {
      user,
      conversation: { id: 'c3' } as any,
      sourceChannel: 'whatsapp',
      isUserConfirmed: false,
    };

    const checkoutTool = toolRegistry.getTool('shopping_checkout');
    await expect(
      checkoutTool.execute(
        {
          store: 'Blinkit',
          amount: 65,
          itemSummary: '1x Diet Coke 300ml',
          deliveryAddress: 'Flat 101, Palm Grove, Bandra West, Mumbai',
        },
        context
      )
    ).rejects.toThrow(ApprovalRequiredError);
  });

  it('12. Order verification - confirms actual order after approved checkout', async () => {
    const user = await db.findOrCreateUserByPhone('+15553000004', 'Rahul');
    const context = {
      user,
      conversation: { id: 'c4' } as any,
      sourceChannel: 'whatsapp',
      isUserConfirmed: true,
    };

    await db.createApproval({
      conversation_id: 'c4',
      user_id: user.id,
      tool_name: 'shopping_checkout',
      arguments: { store: 'Blinkit', amount: 65 },
      summary: 'Blinkit order',
      impact_level: 'high',
      status: 'approved',
      expires_at: new Date(Date.now() + 60000).toISOString(),
      metadata: {},
    });

    const checkoutTool = toolRegistry.getTool('shopping_checkout');
    const checkoutRes = await checkoutTool.execute(
      {
        store: 'Blinkit',
        amount: 65,
        itemSummary: '1x Diet Coke 300ml',
        deliveryAddress: 'Flat 101, Palm Grove',
      },
      context
    );

    expect(checkoutRes.success).toBe(true);
    const orderId = checkoutRes.data.orderId;
    expect(orderId).toBeDefined();

    // Verify order with merchant
    const verifyOrderTool = toolRegistry.getTool('shopping_verify_order');
    const verifyRes = await verifyOrderTool.execute({ orderId, merchant: 'Blinkit' }, context);

    expect(verifyRes.success).toBe(true);
    expect(verifyRes.data.status).toBe('confirmed');
    expect(verifyRes.data.orderId).toBe(orderId);

    // Unverified/fake order ID must fail
    const fakeRes = await verifyOrderTool.execute({ orderId: 'fake_order_999' }, context);
    expect(fakeRes.success).toBe(false);
  });

  // ==========================================================================
  // 8. Payment Approval Safety: Casual Words Are Not Approval
  // ==========================================================================
  it('13. Payment approval safety - casual words without pending approval are not treated as approval', async () => {
    const mockAi = new MockAIProvider(async (_messages) => {
      return { text: 'How can I help you today?' };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const result = await orchestrator.processMessage({
      phoneNumber: '+15553000005',
      name: 'Rahul',
      nameConfirmed: true,
      text: 'okay cool',
    });

    expect(result.replyText).toBe('How can I help you today?');
    expect(result.requiresApproval).toBeFalsy();
  });

  // ==========================================================================
  // 9. Task State Machine Transitions
  // ==========================================================================
  it('14. TaskStateMachine - rejects illegal transition FAILED -> COMPLETED', () => {
    const sm = new TaskStateMachine('CREATED');
    sm.transitionTo('PLANNING');
    sm.transitionTo('EXECUTING');
    sm.transitionTo('FAILED');

    expect(sm.getState()).toBe('FAILED');
    expect(() => sm.transitionTo('COMPLETED')).toThrow(/Illegal task state transition: FAILED -> COMPLETED/);
  });

  // ==========================================================================
  // 10. Duplicate Action Prevention
  // ==========================================================================
  it('15. Duplicate action prevention - blocks duplicate consequential click within 10s', () => {
    const consoleSpy = vi.spyOn(console, 'log');
    browserService.getOrCreateSession('s1');

    browserService.recordAction('s1', {
      action: 'click',
      target: 'button.checkout-btn',
      timestamp: Date.now(),
      success: true,
    });

    const check = browserService.canExecuteAction('s1', 'click', 'button.checkout-btn');
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('Duplicate click');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ComputerUse] duplicate_action_prevented')
    );
    consoleSpy.mockRestore();
  });

  // ==========================================================================
  // 11. Acceptance Test: "Order a Diet Coke from Blinkit"
  // ==========================================================================
  it('16. Acceptance Test: "Order a Diet Coke from Blinkit" enters execution mode with Blinkit plan', async () => {
    const consoleSpy = vi.spyOn(console, 'log');

    let step = 0;
    const mockAi = new MockAIProvider(async (_messages) => {
      step++;
      if (step === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_search',
              name: 'shopping_search',
              arguments: { query: 'Diet Coke 300ml', merchant: 'Blinkit' },
            },
          ],
        };
      }
      return {
        text: 'Found Diet Coke 300ml for ₹40 on Blinkit. Adding to cart and verifying.',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const result = await orchestrator.processMessage({
      phoneNumber: '+15553000006',
      name: 'Rahul',
      nameConfirmed: true,
      text: 'Order a Diet Coke from Blinkit.',
    });

    const logs = consoleSpy.mock.calls.map((c) => c.join(' '));

    // Verify merchant resolved
    expect(logs.some((l) => l.includes('[Merchant] requested merchant="blinkit"'))).toBe(true);
    expect(logs.some((l) => l.includes('[Merchant] resolved merchant=Blinkit'))).toBe(true);
    expect(logs.some((l) => l.includes('[Merchant] canonical_url url=https://blinkit.com'))).toBe(true);

    // Verify plan created for commerce
    expect(logs.some((l) => l.includes('[Agent] plan_created plan="commerce_order_blinkit"'))).toBe(true);

    // Verify response is active execution, NOT "I gathered information..."
    expect(result.replyText).not.toContain('I have gathered the information for your request');
    expect(result.replyText).toContain('Blinkit');
    expect(result.stepsCount).toBe(2);

    consoleSpy.mockRestore();
  });
});
