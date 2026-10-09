import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';
import { PlaywrightBrowserService } from '../packages/browser/src/index.js';
import {
  merchantResolver,
  createShoppingTools,
  createApprovalTool,
  requestUserConfirmationParametersSchema,
  clearUserCart,
  getUserCart,
} from '../packages/tools/src/index.js';
import {
  isCancellationMessage,
  isPauseMessage,
  classifyMessageIntent,
  createRequestContext,
} from '../packages/agent/src/request-context.js';
import { TaskStateMachine } from '../packages/agent/src/task-state-machine.js';
import { ApprovalRequiredError } from '@nexa/shared';

describe('NEXA Instamart Browser Execution, Approvals & Safety Hardening Suite', () => {
  let db: InMemoryRepository;
  let browserService: PlaywrightBrowserService;
  let toolRegistry: any;

  beforeEach(() => {
    db = new InMemoryRepository();
    browserService = new PlaywrightBrowserService();
    toolRegistry = createDefaultToolRegistry({ db, browserService });
  });

  // ==========================================================================
  // BUG 1 — request_user_confirmation Typed Contract & Safe Normalization
  // ==========================================================================
  describe('BUG 1: request_user_confirmation Schema & Normalization', () => {
    it('generates Gemini JSON schema with type="object" for details field', () => {
      const approvalTool = createApprovalTool();
      const declarations = toolRegistry.getDeclarations();
      const approvalDecl = declarations.find((d: any) => d.name === 'request_user_confirmation');

      expect(approvalDecl).toBeDefined();
      expect(approvalDecl.parameters.properties.actionSummary.type).toBe('string');
      expect(approvalDecl.parameters.properties.impactLevel.type).toBe('string');
      // Must NOT be string — must be object!
      expect(approvalDecl.parameters.properties.details.type).toBe('object');
      expect(approvalDecl.parameters.required).toContain('actionSummary');
      // Optional/default parameters must not be in required
      expect(approvalDecl.parameters.required).not.toContain('details');
      expect(approvalDecl.parameters.required).not.toContain('impactLevel');
    });

    it('safely normalizes string JSON in details parameter into structured object', () => {
      const rawInput = {
        actionSummary: 'Place order for Diet Coke on Instamart',
        impactLevel: 'high',
        details: '{"merchant": "Swiggy Instamart", "total": 490, "items": ["Diet Coke"]}',
      };

      const parsed = requestUserConfirmationParametersSchema.parse(rawInput);
      expect(parsed.details).toEqual({
        merchant: 'Swiggy Instamart',
        total: 490,
        items: ['Diet Coke'],
      });
    });

    it('safely normalizes plain string in details parameter into { summary: text }', () => {
      const rawInput = {
        actionSummary: 'Place order for ₹490',
        details: 'Swiggy Instamart order for Diet Coke ₹490',
      };

      const parsed = requestUserConfirmationParametersSchema.parse(rawInput);
      expect(parsed.details).toEqual({
        summary: 'Swiggy Instamart order for Diet Coke ₹490',
      });
      expect(parsed.impactLevel).toBe('high'); // default applied
    });

    it('accepts valid object directly without modification', () => {
      const rawInput = {
        actionSummary: 'Order Diet Coke',
        details: { store: 'Instamart', price: 40 },
      };

      const parsed = requestUserConfirmationParametersSchema.parse(rawInput);
      expect(parsed.details).toEqual({ store: 'Instamart', price: 40 });
    });

    it('handles undefined or null details by defaulting to empty object', () => {
      const rawInput = {
        actionSummary: 'Confirm flight booking',
      };

      const parsed = requestUserConfirmationParametersSchema.parse(rawInput);
      expect(parsed.details).toEqual({});
    });

    it('throws ApprovalRequiredError with prompt when executed unconfirmed', async () => {
      const user = await db.findOrCreateUserByPhone('+919876543210', 'Test User');
      const conv = await db.getOrCreateActiveConversation(user.id);
      const context = {
        user,
        conversation: conv,
        messageId: 'msg_1',
        isUserConfirmed: false,
      };

      await expect(
        toolRegistry.executeTool(
          'request_user_confirmation',
          {
            actionSummary: 'Booking flight AI-101 for ₹18,450',
            details: { flight: 'AI-101', price: 18450 },
          },
          context
        )
      ).rejects.toThrow(ApprovalRequiredError);

      const pending = await db.getPendingApproval(conv.id);
      expect(pending).not.toBeNull();
      expect(pending?.tool_name).toBe('request_user_confirmation');
      expect(pending?.arguments.actionSummary).toBe('Booking flight AI-101 for ₹18,450');
      expect(pending?.arguments.details).toEqual({ flight: 'AI-101', price: 18450 });
    });
  });

  // ==========================================================================
  // BUG 2 — Server Boundary Approval Enforcement for shopping_checkout
  // ==========================================================================
  describe('BUG 2: Server Boundary Approval Verification', () => {
    it('shopping_checkout throws ApprovalRequiredError when unconfirmed', async () => {
      const user = await db.findOrCreateUserByPhone('+919876543210');
      const conv = await db.getOrCreateActiveConversation(user.id);
      const context = {
        user,
        conversation: conv,
        messageId: 'msg_1',
        isUserConfirmed: false,
      };

      await expect(
        toolRegistry.executeTool(
          'shopping_checkout',
          { store: 'Swiggy Instamart', amount: 490, itemSummary: '1x Diet Coke' },
          context
        )
      ).rejects.toThrow(ApprovalRequiredError);
    });

    it('shopping_checkout fails if isUserConfirmed=true but no DB approval record exists', async () => {
      const user = await db.findOrCreateUserByPhone('+919876543210');
      const conv = await db.getOrCreateActiveConversation(user.id);
      const context = {
        user,
        conversation: conv,
        messageId: 'msg_1',
        isUserConfirmed: true, // Spoofed confirmation flag
      };

      // No approval was ever created or approved in DB
      await expect(
        toolRegistry.executeTool(
          'shopping_checkout',
          { store: 'Swiggy Instamart', amount: 490, itemSummary: '1x Diet Coke' },
          context
        )
      ).rejects.toThrow(ApprovalRequiredError);
    });

    it('shopping_checkout fails if approval record in DB was for a different merchant', async () => {
      const user = await db.findOrCreateUserByPhone('+919876543210');
      const conv = await db.getOrCreateActiveConversation(user.id);

      // Create an approved record for Blinkit
      const approval = await db.createApproval({
        conversation_id: conv.id,
        user_id: user.id,
        tool_name: 'shopping_checkout',
        arguments: { store: 'Blinkit', amount: 490 },
        summary: 'Blinkit order',
        impact_level: 'high',
        status: 'approved',
        expires_at: new Date(Date.now() + 60000).toISOString(),
        metadata: {},
      });

      const context = {
        user,
        conversation: conv,
        messageId: 'msg_1',
        isUserConfirmed: true,
      };

      // Attempt checkout on Swiggy Instamart instead of Blinkit
      const res = await toolRegistry.executeTool(
        'shopping_checkout',
        { store: 'Swiggy Instamart', amount: 490, itemSummary: '1x Diet Coke' },
        context
      );
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Approval was for merchant "blinkit", but checkout was attempted for "Swiggy Instamart"/i);
    });

    it('shopping_checkout succeeds when matching DB approval exists and marks approval consumed', async () => {
      const user = await db.findOrCreateUserByPhone('+919876543210');
      const conv = await db.getOrCreateActiveConversation(user.id);

      // Add item to cart first
      await toolRegistry.executeTool(
        'shopping_add_to_cart',
        { productName: 'Diet Coke 300ml', price: 40, store: 'Swiggy Instamart' },
        { user, conversation: conv, messageId: 'msg_0' }
      );

      // Create approved approval in DB
      const approval = await db.createApproval({
        conversation_id: conv.id,
        user_id: user.id,
        tool_name: 'shopping_checkout',
        arguments: { store: 'Swiggy Instamart', amount: 40 },
        summary: 'Swiggy Instamart order',
        impact_level: 'high',
        status: 'approved',
        expires_at: new Date(Date.now() + 60000).toISOString(),
        metadata: {},
      });

      const context = {
        user,
        conversation: conv,
        messageId: 'msg_1',
        isUserConfirmed: true,
      };

      const res = await toolRegistry.executeTool(
        'shopping_checkout',
        { store: 'Swiggy Instamart', amount: 40, itemSummary: '1x Diet Coke 300ml' },
        context
      );

      expect(res.success).toBe(true);
      expect(res.data.status).toBe('confirmed');
      expect(res.data.store).toBe('Swiggy Instamart');

      // Verify approval record is now marked consumed
      const latest = await db.getLatestApproval(conv.id);
      expect(latest?.metadata?.consumed).toBe(true);

      // A second checkout attempt with the now-consumed approval MUST BE REJECTED!
      await expect(
        toolRegistry.executeTool(
          'shopping_checkout',
          { store: 'Swiggy Instamart', amount: 40, itemSummary: '1x Diet Coke 300ml' },
          context
        )
      ).rejects.toThrow(ApprovalRequiredError);
    });
  });

  // ==========================================================================
  // BUG 3 — Active Task Control with STOP and WAIT
  // ==========================================================================
  describe('BUG 3: Active Task Control with STOP and WAIT', () => {
    it('classifies standalone "stop", "cancel", "abort", "halt" as CONTROL_STOP or CONTROL_CANCEL, never OTHER', () => {
      expect(isCancellationMessage('stop')).toBe(true);
      expect(isCancellationMessage('cancel')).toBe(true);
      expect(isCancellationMessage('abort')).toBe(true);
      expect(isCancellationMessage('halt')).toBe(true);
      expect(isCancellationMessage('Stop!')).toBe(true);
      expect(isCancellationMessage('cancel that')).toBe(true);

      expect(classifyMessageIntent('stop')).toBe('CONTROL_STOP');
      expect(classifyMessageIntent('cancel')).toBe('CONTROL_CANCEL');
      expect(classifyMessageIntent('stop!')).toBe('CONTROL_STOP');
      expect(classifyMessageIntent('cancel order')).toBe('CONTROL_CANCEL');
      expect(classifyMessageIntent('actually, forget that')).toBe('CONTROL_CANCEL');
    });

    it('classifies standalone "wait", "pause", "hold on", "hang on" as CONTROL_WAIT, never OTHER', () => {
      expect(isPauseMessage('wait')).toBe(true);
      expect(isPauseMessage('pause')).toBe(true);
      expect(isPauseMessage('hold on')).toBe(true);
      expect(isPauseMessage('hang on')).toBe(true);
      expect(isPauseMessage('wait please')).toBe(true);

      expect(classifyMessageIntent('wait')).toBe('CONTROL_WAIT');
      expect(classifyMessageIntent('pause')).toBe('CONTROL_WAIT');
      expect(classifyMessageIntent('hold on')).toBe('CONTROL_WAIT');
      expect(classifyMessageIntent('wait a minute')).toBe('CONTROL_WAIT');
    });

    it('sending "stop" aborts active task, rejects pending approval, and clears cart', async () => {
      const user = await db.findOrCreateUserByPhone('+919876543210', 'Test User');
      await db.updateUser(user.id, { name_confirmed: true, preferred_name: 'Test' });
      const conv = await db.getOrCreateActiveConversation(user.id);

      // Add item to cart
      await toolRegistry.executeTool(
        'shopping_add_to_cart',
        { productName: 'Diet Coke', price: 40, store: 'Swiggy Instamart' },
        { user, conversation: conv, messageId: 'msg_0' }
      );
      expect(getUserCart(user.id)?.items.length).toBe(1);

      // Create a pending approval
      const approval = await db.createApproval({
        conversation_id: conv.id,
        user_id: user.id,
        tool_name: 'shopping_checkout',
        arguments: { store: 'Swiggy Instamart', amount: 40 },
        summary: 'Swiggy Instamart order',
        impact_level: 'high',
        status: 'pending',
        expires_at: new Date(Date.now() + 60000).toISOString(),
        metadata: {},
      });

      const aiProvider = new MockAIProvider(async () => ({
        text: 'This response should never be reached on cancel',
      }));

      const orchestrator = new AgentOrchestrator(aiProvider, toolRegistry, db);
      const res = await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        text: 'stop',
      });

      expect(res.stepsCount).toBe(0);
      expect(res.replyText).toContain('stopped and cancelled');

      // Verify cart was cleared
      expect(getUserCart(user.id)).toBeUndefined();

      // Verify pending approval in DB was rejected
      const latest = await db.getLatestApproval(conv.id);
      expect(latest?.status).toBe('rejected');
    });

    it('sending "wait" pauses active workflow without invoking any tools', async () => {
      const user = await db.findOrCreateUserByPhone('+919876543210', 'Test User');
      await db.updateUser(user.id, { name_confirmed: true, preferred_name: 'Test' });

      const aiProvider = new MockAIProvider(async () => ({
        text: 'Not needed',
      }));

      const orchestrator = new AgentOrchestrator(aiProvider, toolRegistry, db);
      const res = await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        text: 'wait',
      });

      expect(res.stepsCount).toBe(0);
      expect(res.replyText).toContain('Paused');
    });
  });

  // ==========================================================================
  // BUG 4 — Terminal State Protection & Race Condition Elimination
  // ==========================================================================
  describe('BUG 4: Terminal State Safety & Race Condition Prevention', () => {
    it('TaskStateMachine marks FAILED, COMPLETED, and CANCELLED as terminal', () => {
      const smCreated = new TaskStateMachine('CREATED');
      expect(smCreated.isTerminal()).toBe(false);

      const smExecuting = new TaskStateMachine('EXECUTING');
      expect(smExecuting.isTerminal()).toBe(false);

      const smFailed = new TaskStateMachine('FAILED');
      expect(smFailed.isTerminal()).toBe(true);
      expect(smFailed.canTransitionTo('COMPLETED')).toBe(false);

      const smCompleted = new TaskStateMachine('COMPLETED');
      expect(smCompleted.isTerminal()).toBe(true);

      const smCancelled = new TaskStateMachine('CANCELLED');
      expect(smCancelled.isTerminal()).toBe(true);
      expect(smCancelled.canTransitionTo('COMPLETED')).toBe(false);
    });

    it('orchestrator does not log tool_success or step_completed after task failure', async () => {
      const user = await db.findOrCreateUserByPhone('+919876543210', 'Test User');
      await db.updateUser(user.id, { name_confirmed: true, preferred_name: 'Test' });

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(' '));
        originalLog(...args);
      };

      try {
        // Mock provider that fails on second turn after tool call
        const aiProvider = new MockAIProvider(async () => ({
          text: '',
          toolCalls: [
            { id: 'call_1', name: 'browser_open', arguments: { url: 'https://www.swiggy.com/instamart' } },
          ],
        }));

        // Set total deadline to a small value to trigger deadline failure
        const orchestrator = new AgentOrchestrator(
          aiProvider,
          toolRegistry,
          db,
          3,
          undefined,
          7000,
          2500 // 2.5s total deadline ensures remainingMs <= 3000 triggers immediate failure
        );

        const res = await orchestrator.processMessage({
          phoneNumber: '+919876543210',
          text: 'search products on instamart',
        });

        const failedIdx = logs.findIndex((l) => l.includes('[Agent] task_failed'));
        expect(failedIdx).toBeGreaterThanOrEqual(0);

        // Verify that NO tool_success or step_completed log occurs after task_failed
        const logsAfterFailed = logs.slice(failedIdx + 1);
        const hasLateSuccess = logsAfterFailed.some((l) => l.includes('[Agent] tool_success'));
        const hasLateStepCompleted = logsAfterFailed.some((l) => l.includes('[Agent] step_completed'));
        const hasLateCompleted = logsAfterFailed.some((l) => l.includes('[Agent] task_completed'));

        expect(hasLateSuccess).toBe(false);
        expect(hasLateStepCompleted).toBe(false);
        expect(hasLateCompleted).toBe(false);
      } finally {
        console.log = originalLog;
      }
    });
  });

  // ==========================================================================
  // BUG 5 — Real Instamart Browser Execution Path
  // ==========================================================================
  describe('BUG 5: Swiggy Instamart Browser Session Path', () => {
    it('shopping_search opens canonical Instamart URL and runs adaptiveSearch when browserService is provided', async () => {
      const openSpy = vi.spyOn(browserService, 'openPage').mockResolvedValue({
        success: true,
        finalUrl: 'https://www.swiggy.com/instamart',
        status: 200,
        title: 'Swiggy Instamart',
        text: 'Swiggy Instamart online store',
      });

      const readySpy = vi.spyOn(browserService, 'waitForPageReady').mockResolvedValue({
        ready: true,
        latencyMs: 50,
        elementsCount: 15,
      });

      const inspectSpy = vi.spyOn(browserService, 'inspectPageState').mockResolvedValue({
        url: 'https://www.swiggy.com/instamart',
        title: 'Swiggy Instamart',
        text: 'Groceries delivered in 10 minutes',
        authState: 'authenticated',
        challengeDetected: false,
      });

      const adaptiveSpy = vi.spyOn(browserService, 'adaptiveSearch').mockResolvedValue({
        success: true,
        query: 'Diet Coke',
        url: 'https://www.swiggy.com/instamart/search?q=Diet+Coke',
        products: [
          {
            title: 'Coca-Cola Diet Coke Can 300 ml',
            store: 'swiggy.com',
            price: 40,
            url: 'https://www.swiggy.com/instamart/item/diet-coke-300',
            snippet: 'Coca-Cola Diet Coke Can 300 ml (₹40)',
          },
        ],
      });

      const user = await db.findOrCreateUserByPhone('+919876543210');
      const conv = await db.getOrCreateActiveConversation(user.id);

      const res = await toolRegistry.executeTool(
        'shopping_search',
        { query: 'Diet Coke', merchant: 'Swiggy Instamart' },
        { user, conversation: conv, messageId: 'msg_1' }
      );

      expect(res.success).toBe(true);
      expect(openSpy).toHaveBeenCalledWith('https://www.swiggy.com/instamart');
      expect(readySpy).toHaveBeenCalled();
      expect(inspectSpy).toHaveBeenCalled();
      expect(adaptiveSpy).toHaveBeenCalledWith('Diet Coke');
      expect(res.data.products.length).toBe(1);
      expect(res.data.products[0].title).toBe('Coca-Cola Diet Coke Can 300 ml');
      expect(res.data.products[0].price).toBe(40);
    });

    it('shopping_search halts gracefully and prompts human verification when CAPTCHA / bot challenge is detected', async () => {
      vi.spyOn(browserService, 'openPage').mockResolvedValue({
        success: true,
        finalUrl: 'https://www.swiggy.com/instamart',
        status: 200,
        title: 'Attention Required! | Cloudflare',
        text: 'Attention Required! | Cloudflare',
      });

      vi.spyOn(browserService, 'waitForPageReady').mockResolvedValue({
        ready: true,
        latencyMs: 30,
        elementsCount: 2,
      });

      vi.spyOn(browserService, 'inspectPageState').mockResolvedValue({
        url: 'https://www.swiggy.com/instamart',
        title: 'Attention Required! | Cloudflare',
        text: 'Please verify you are a human to continue',
        authState: 'anonymous',
        challengeDetected: true,
        challengeType: 'Cloudflare Challenge',
      });

      const user = await db.findOrCreateUserByPhone('+919876543210');
      const conv = await db.getOrCreateActiveConversation(user.id);

      const res = await toolRegistry.executeTool(
        'shopping_search',
        { query: 'Diet Coke', merchant: 'Swiggy Instamart' },
        { user, conversation: conv, messageId: 'msg_1' }
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('requires human verification');
      expect(res.userFacingMessage).toContain('verification check');
    });
  });

  // ==========================================================================
  // BUG 6 — shopping_add_to_cart Input Normalization and Validation
  // ==========================================================================
  describe('BUG 6: shopping_add_to_cart Input Normalization', () => {
    it('normalizes string quantity, float quantity, and string price', async () => {
      const user = await db.findOrCreateUserByPhone('+919876543210');
      const conv = await db.getOrCreateActiveConversation(user.id);

      const res = await toolRegistry.executeTool(
        'shopping_add_to_cart',
        {
          productName: 'Diet Coke Can',
          price: '₹40' as any,
          quantity: '2' as any,
          store: 'Swiggy Instamart',
        },
        { user, conversation: conv, messageId: 'msg_cart_1' }
      );

      expect(res.success).toBe(true);
      expect((res.data as any).quantity).toBe(2);
      expect((res.data as any).cartTotalMinor).toBe(8000); // 2 * 4000 paise
    });

    it('rejects invalid quantities outside 1-50', async () => {
      const user = await db.findOrCreateUserByPhone('+919876543210');
      const conv = await db.getOrCreateActiveConversation(user.id);

      await expect(
        toolRegistry.executeTool(
          'shopping_add_to_cart',
          {
            productName: 'Diet Coke Can',
            price: 40,
            quantity: 999,
            store: 'Swiggy Instamart',
          },
          { user, conversation: conv, messageId: 'msg_cart_2' }
        )
      ).rejects.toThrow(/Invalid tool arguments/);
    });
  });

  // ==========================================================================
  // BUG 7 — Capability Registry 4-Tier Architecture
  // ==========================================================================
  describe('BUG 7: Capability Registry 4-Tier Architecture', () => {
    it('correctly maps official API, adapter, and browser tiers', async () => {
      const { capabilityRegistry } = await import('../packages/tools/src/index.js');
      const services = capabilityRegistry.listServices();
      expect(services.length).toBeGreaterThan(3);

      const google = capabilityRegistry.getService('google_workspace');
      expect(google?.primaryTier).toBe('TIER_1_OFFICIAL_API');

      const swiggy = capabilityRegistry.getService('swiggy_instamart');
      expect(swiggy?.primaryTier).toBe('TIER_3_BROWSER_AUTOMATION');
      expect(swiggy?.fallbackTier).toBe('TIER_4_USER_ASSISTED');

      const path = capabilityRegistry.getExecutionPath('swiggy_instamart');
      expect(path).toEqual(['TIER_3_BROWSER_AUTOMATION', 'TIER_4_USER_ASSISTED']);
    });
  });
});
