import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  AgentOrchestrator,
  formatFriendlyFailureResponse,
  deduplicateAssistantResponse,
  buildSystemInstruction,
} from '@nexa/agent';
import {
  PlaywrightBrowserService,
  ToolExecutionError,
} from '@nexa/browser';
import {
  InMemoryRepository,
  MemoryService,
  User,
} from '@nexa/database';
import {
  ToolRegistry,
  BaseTool,
  createBrowserTools,
} from '@nexa/tools';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';

describe('NEXA Personality, Conversation Handling & False Success Prevention Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Politeness, Personality & System Prompt Standards', () => {
    it('generates system prompt with warm, friendly tone and humility guidelines', () => {
      const user: User = {
        id: 'u_alice',
        phone_number: '+919999900001',
        role: 'user',
        status: 'active',
        preferences: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const prompt = buildSystemInstruction(user, []);

      expect(prompt).toContain('Warm, Friendly Personal AI Companion & Honesty About AI Nature');
      expect(prompt).toContain('Consistently Polite, Respectful Tone & Admitting Mistakes Humbly');
      expect(prompt).toContain('Stop Repetitive Responses & Loop Prevention');
      expect(prompt).toContain('Friendly Failure-Response Standard');
      expect(prompt).toContain('Never claim or pretend to possess human emotions, consciousness');
      expect(prompt).toContain('Never sound robotic, bureaucratic, arrogant, sarcastic, aggressive');
    });

    it('addresses user as "Boss" when confirmed in memory preferences', () => {
      const user: User = {
        id: 'u_boss',
        phone_number: '+919999900002',
        role: 'user',
        status: 'active',
        preferences: { preferred_title: 'Boss' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const memories = [
        {
          id: 'mem_title',
          userId: user.id,
          category: 'user_preferences',
          key: 'preferred_title',
          value: 'Boss',
          source: 'EXPLICIT_USER_STATEMENT',
          confidenceScore: 1.0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      const prompt = buildSystemInstruction(user, memories);
      expect(prompt).toContain('Address the user as "Boss"');
    });

    it('does NOT address user as Boss when user explicitly avoids the title or has no title preference', () => {
      const userA: User = {
        id: 'u_no_boss',
        phone_number: '+919999900003',
        role: 'user',
        status: 'active',
        preferences: { avoid_title: 'Boss' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const memoriesA = [
        {
          id: 'mem_avoid',
          userId: userA.id,
          category: 'user_preferences',
          key: 'avoid_title',
          value: 'Boss',
          source: 'EXPLICIT_USER_STATEMENT',
          confidenceScore: 1.0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      const promptA = buildSystemInstruction(userA, memoriesA);
      expect(promptA).not.toContain('Address the user as "Boss"');

      // User B without any title preference
      const userB: User = {
        id: 'u_user_b',
        phone_number: '+919999900004',
        role: 'user',
        status: 'active',
        preferences: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const promptB = buildSystemInstruction(userB, []);
      expect(promptB).not.toContain('Address the user as "Boss"');
    });
  });

  describe('2. Friendly 4-Part Failure Response Formatting & Title Integration', () => {
    it('formats a 4-part constructive failure response with "Boss" title', () => {
      const response = formatFriendlyFailureResponse({
        userTitle: 'Boss',
        problem: "Flipkart isn't loading the product pages correctly right now",
        notCompletedState: "I haven't verified a product or added anything to your cart",
        nextStep: "You can share another product link, or we can try again later.",
      });

      expect(response).toBe(
        "Sorry, Boss — Flipkart isn't loading the product pages correctly right now. I haven't verified a product or added anything to your cart. You can share another product link, or we can try again later."
      );
    });

    it('formats a 4-part constructive failure response gracefully when no title exists', () => {
      const response = formatFriendlyFailureResponse({
        problem: "Flipkart isn't loading the product pages correctly right now",
        notCompletedState: "I haven't verified a product or added anything to your cart",
        nextStep: "You can share another product link, or we can try again later.",
      });

      expect(response).toBe(
        "Sorry — Flipkart isn't loading the product pages correctly right now. I haven't verified a product or added anything to your cart. You can share another product link, or we can try again later."
      );
    });
  });

  describe('3. Repetitive Response Prevention & Deduplication', () => {
    it('strips back-to-back duplicate greetings across assistant turns', () => {
      const history = [
        { sender_type: 'user', content: 'What time is it?' },
        { sender_type: 'assistant', content: 'Hello! It is 3:00 PM.' },
        { sender_type: 'user', content: 'And the weather?' },
      ];

      const newReply = 'Hello! It looks sunny and clear today.';
      const deduplicated = deduplicateAssistantResponse(newReply, history);

      expect(deduplicated).toBe('It looks sunny and clear today.');
      expect(deduplicated.startsWith('Hello!')).toBe(false);
    });

    it('varies phrasing when identical failure explanations are repeated', () => {
      const history = [
        { sender_type: 'user', content: 'Check Amazon again' },
        {
          sender_type: 'assistant',
          content: 'Sorry, Boss — Amazon is currently inaccessible due to a connection error. I haven\'t completed your search. Please try again later.',
        },
        { sender_type: 'user', content: 'Try one more time' },
      ];

      const duplicateReply =
        'Sorry, Boss — Amazon is currently inaccessible due to a connection error. I haven\'t completed your search. Please try again later.';
      const modified = deduplicateAssistantResponse(duplicateReply, history);

      expect(modified).not.toBe(duplicateReply);
      expect(modified).toContain('As mentioned earlier');
    });
  });

  describe('4. Preventing False Success on Challenge and Error', () => {
    it('throws ToolExecutionError when browser action is blocked by challenge and does not mark success', async () => {
      const browserService = new PlaywrightBrowserService();
      // Simulate session in challenged / BLOCKED state
      (browserService as any).sessions.set('test-user', {
        sessionId: 'test-user',
        pageState: 'challenged',
        challengeDetected: true,
        challengeType: 'Amazon Robot Check',
        authState: 'BLOCKED',
        actionHistory: [],
      });

      // Clicking must throw ToolExecutionError and not return success
      await expect(
        browserService.clickElement('button#submit', 'test-user')
      ).rejects.toThrow(ToolExecutionError);

      await expect(
        browserService.typeText('input#search', 'screen guard', 'test-user')
      ).rejects.toThrow(ToolExecutionError);
    });

    it('marks tool failure and prevents step_completed when calling a disabled tool', async () => {
      const db = new InMemoryRepository();
      const registry = new ToolRegistry();
      const logs: string[] = [];

      const origLog = console.log;
      console.log = vi.fn((...args: any[]) => {
        logs.push(args.join(' '));
        origLog(...args);
      });

      let callCount = 0;
      registry.register({
        name: 'failing_tool',
        description: 'Tool that fails repeatedly',
        riskLevel: 'read_only',
        parametersSchema: z.object({ query: z.string() }),
        requiresApproval: () => ({ required: false }),
        execute: async () => {
          callCount++;
          return { success: false, error: 'Network failure' };
        },
      });

      let geminiStep = 0;
      const mockAI = new MockAIProvider(async () => {
        geminiStep++;
        if (geminiStep <= 3) {
          // Attempt failing tool with distinct queries on steps 1 and 2 to reach max retries
          return {
            text: '',
            toolCalls: [
              { id: `call_${geminiStep}`, name: 'failing_tool', arguments: { query: `attempt_${geminiStep}` } },
            ],
          };
        }
        return { text: 'Giving up.', toolCalls: [] };
      });

      const orchestrator = new AgentOrchestrator(
        mockAI,
        registry,
        db,
        5,
        undefined,
        5000,
        30000,
        5,
        30000
      );

      await orchestrator.processMessage({
        phoneNumber: '+919876543299',
        text: 'Run the failing tool',
      });

      console.log = origLog;

      // Tool should have been disabled after 2 retries
      expect(logs.some((l) => l.includes('[Agent] tool_disabled name=failing_tool'))).toBe(true);

      // Verify step 3 was NOT logged as step_completed
      const step3Completed = logs.some((l) => l.includes('[Agent] step_completed step=3'));
      expect(step3Completed).toBe(false);
    });
  });

  describe('5. Flipkart HTTP 500 Product Page Failure Recovery & 4-Part Response', () => {
    it('intercepts repeated navigation to HTTP 500 URL and outputs friendly 4-part failure response addressing Boss', async () => {
      const db = new InMemoryRepository();
      const user = await db.findOrCreateUserByPhone('+919876543200', 'Boss User');
      await db.updateUser(user.id, {
        preferences: { preferred_title: 'Boss' },
      });
      const memoryService = new MemoryService(db);
      await memoryService.saveMemory({
        userId: user.id,
        category: 'user_preferences',
        key: 'preferred_title',
        value: 'Boss',
        source: 'EXPLICIT_USER_STATEMENT',
        confirmed: true,
      });

      const registry = new ToolRegistry();
      const failingFlipkartUrl = 'https://www.flipkart.com/broken-screen-guard/p/itm12345';
      let navigationAttempts = 0;

      registry.register({
        name: 'browser_open',
        description: 'Opens a webpage',
        riskLevel: 'read_only',
        parametersSchema: z.object({ url: z.string() }),
        requiresApproval: () => ({ required: false }),
        execute: async (args: { url: string }) => {
          navigationAttempts++;
          if (args.url === failingFlipkartUrl) {
            return {
              success: false,
              error: 'Server returned HTTP 500 Internal Server Error',
              data: { status: 500, url: args.url },
            };
          }
          return { success: true, data: { status: 200, url: args.url } };
        },
      });

      let turn = 0;
      const mockAI = new MockAIProvider(async () => {
        turn++;
        if (turn === 1) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'call_nav_1',
                name: 'browser_open',
                arguments: { url: failingFlipkartUrl },
              },
            ],
          };
        }
        if (turn === 2) {
          // AI tries navigating to the same broken URL
          return {
            text: '',
            toolCalls: [
              {
                id: 'call_nav_2',
                name: 'browser_open',
                arguments: { url: failingFlipkartUrl },
              },
            ],
          };
        }
        return {
          text: '',
          toolCalls: [],
        };
      });

      const orchestrator = new AgentOrchestrator(
        mockAI,
        registry,
        db,
        4,
        undefined,
        5000,
        30000,
        4,
        30000
      );

      const result = await orchestrator.processMessage({
        phoneNumber: '+919876543200',
        text: 'Buy screen guard on Flipkart',
        preferredTitle: 'Boss',
      });

      // Assertions:
      // 1. Navigation to the identical broken URL on turn 2 was intercepted before calling tool
      expect(navigationAttempts).toBe(1);

      // 2. Outbound response addresses the user as "Boss" and provides 4-part constructive failure
      expect(result.replyText).toContain('Sorry, Boss — ');
      expect(result.replyText).toContain("Flipkart isn't loading the product pages correctly right now");
      expect(result.replyText).toContain("I haven't verified a product or added anything to your cart");
      expect(result.replyText).toContain("You can share another product link, or we can try again later.");

      // 3. Does not falsely claim cart addition or product verification
      expect(result.replyText).not.toContain('cart verified');
      expect(result.replyText).not.toContain('item added');
    });
  });
});
