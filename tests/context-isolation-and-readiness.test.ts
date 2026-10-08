import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';
import { PlaywrightBrowserService, ComputerUseResolver } from '../packages/browser/src/index.js';
import {
  classifyMessageIntent,
  isCancellationMessage,
  isContinuationMessage,
} from '../packages/agent/src/request-context.js';
import { TaskStateMachine } from '../packages/agent/src/task-state-machine.js';
import {
  TOTAL_AGENT_DEADLINE_MS,
  COMPUTER_USE_TASK_DEADLINE_MS,
  COMMERCE_TASK_DEADLINE_MS,
  BROWSER_READINESS_TIMEOUT_MS,
  REQUEST_MESSAGE_DEADLINE_MS,
  BaseTool,
  ToolExecutionContext,
  ToolResult,
} from '@nexa/shared';

describe('NEXA Context Isolation, Agent Deadline & Browser Readiness Suite', () => {
  let db: InMemoryRepository;
  let browserService: PlaywrightBrowserService;
  let toolRegistry: any;

  beforeEach(() => {
    db = new InMemoryRepository();
    browserService = new PlaywrightBrowserService();
    toolRegistry = createDefaultToolRegistry({ db, browserService });
  });

  // =========================================================================
  // 1. Bug 1 & 6: "Hello NEXA, what can you do?" -> intent CONVERSATION, 0 shopping tools
  // =========================================================================
  it('1. "Hello NEXA, what can you do?" classifies as CONVERSATION and receives 0 shopping tools', async () => {
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const userText = 'Hello NEXA, what can you do?';
    const intent = classifyMessageIntent(userText);
    expect(intent).toBe('CONVERSATION');

    let toolsPassedToGemini: any[] = [];
    const mockAi = new MockAIProvider(async (messages, options) => {
      toolsPassedToGemini = options?.tools || [];
      return {
        text: 'Hello! I am NEXA, your personal computer-use assistant. I can help you with shopping, research, bookings, and more.',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const result = await orchestrator.processMessage({
      phoneNumber: '+919999900001',
      name: 'Rohan',
      preferredName: 'Rohan',
      nameConfirmed: true,
      text: userText,
      channel: 'whatsapp',
    });

    consoleSpy.mockRestore();

    // Verify telemetry
    expect(logs.some((l) => l.includes('[Context] request_created'))).toBe(true);
    expect(logs.some((l) => l.includes('[Context] request_intent_classified intent=CONVERSATION'))).toBe(true);

    // Verify 0 tools were passed to Gemini
    expect(toolsPassedToGemini).toEqual([]);
    expect(toolsPassedToGemini.some((t) => t.name === 'shopping_search')).toBe(false);

    // Verify conversational response produced
    expect(result.replyText).toContain('NEXA');
    expect(result.stepsCount).toBeLessThanOrEqual(1); // 1 conversational turn without tool calls
  });

  // =========================================================================
  // 2. Bug 1: Previous shopping request in history -> new request "Hello" -> no commerce continuation
  // =========================================================================
  it('2. History containing old shopping request does not leak into "Hello" (no commerce continuation)', async () => {
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const user = await db.findOrCreateUserByPhone('+919999900002', 'Priya');
    user.preferred_name = 'Priya';
    user.name_confirmed = true;
    const conversation = await db.getOrCreateActiveConversation(user.id, 'whatsapp');

    // Seed prior commerce turn in history
    await db.saveMessage({
      conversation_id: conversation.id,
      sender_type: 'user',
      content: 'Order a Diet Coke from Instamart',
    });
    await db.saveMessage({
      conversation_id: conversation.id,
      sender_type: 'assistant',
      content: 'I am ready to proceed with your order on Swiggy Instamart.',
    });

    let toolsPassedToGemini: any[] = [];
    const mockAi = new MockAIProvider(async (messages, options) => {
      toolsPassedToGemini = options?.tools || [];
      return {
        text: 'Hello Priya! How can I help you today?',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const result = await orchestrator.processMessage({
      phoneNumber: '+919999900002',
      name: 'Priya',
      preferredName: 'Priya',
      nameConfirmed: true,
      text: 'Hello',
      channel: 'whatsapp',
    });

    consoleSpy.mockRestore();

    // Verify telemetry logs
    expect(logs.some((l) => l.includes('[Context] previous_task_not_resumed reason="no_explicit_continuation"'))).toBe(true);
    expect(logs.some((l) => l.includes('[Context] request_intent_classified intent=CONVERSATION'))).toBe(true);

    // Verify tools passed is empty (no shopping tools allowed)
    expect(toolsPassedToGemini).toEqual([]);

    // Verify assistant did NOT resurrect shopping
    expect(result.replyText).toBe('Hello Priya! How can I help you today?');
  });

  // =========================================================================
  // 3. Bug 1 & 6: Unrelated question ("What's the weather?") after commerce task -> NO shopping tools
  // =========================================================================
  it('3. Unrelated question ("What\'s the weather?") after commerce task classifies as RESEARCH and receives no shopping tools', async () => {
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const user = await db.findOrCreateUserByPhone('+919999900003', 'Anita');
    user.preferred_name = 'Anita';
    user.name_confirmed = true;
    const conversation = await db.getOrCreateActiveConversation(user.id, 'whatsapp');

    // Prior commerce history
    await db.saveMessage({
      conversation_id: conversation.id,
      sender_type: 'user',
      content: 'Order a Diet Coke from Instamart',
    });

    let toolsPassedToGemini: any[] = [];
    const mockAi = new MockAIProvider(async (messages, options) => {
      toolsPassedToGemini = options?.tools || [];
      return {
        text: 'The weather today is sunny and 28°C.',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const result = await orchestrator.processMessage({
      phoneNumber: '+919999900003',
      name: 'Anita',
      preferredName: 'Anita',
      nameConfirmed: true,
      text: "What's the weather?",
      channel: 'whatsapp',
    });

    consoleSpy.mockRestore();

    expect(logs.some((l) => l.includes('[Context] request_intent_classified intent=RESEARCH'))).toBe(true);
    expect(logs.some((l) => l.includes('[Context] previous_task_not_resumed reason="no_explicit_continuation"'))).toBe(true);

    // Tools must NOT include shopping_search or other shopping tools
    expect(toolsPassedToGemini.some((t) => t.name === 'shopping_search')).toBe(false);
    expect(toolsPassedToGemini.some((t) => t.name === 'shopping_checkout')).toBe(false);

    expect(result.replyText).toContain('28°C');
  });

  // =========================================================================
  // 4. Bug 1: Cancellation of previous task ("Actually, forget that. What can you do?")
  // =========================================================================
  it('4. Cancellation ("Actually, forget that. What can you do?") rejects stale context and responds conversationally', async () => {
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const text = 'Actually, forget that. What can you do?';
    expect(isCancellationMessage(text)).toBe(true);
    expect(classifyMessageIntent(text)).toBe('CONVERSATION');

    const user = await db.findOrCreateUserByPhone('+919999900004', 'Sam');
    user.preferred_name = 'Sam';
    user.name_confirmed = true;
    const conversation = await db.getOrCreateActiveConversation(user.id, 'whatsapp');

    await db.saveMessage({
      conversation_id: conversation.id,
      sender_type: 'user',
      content: 'Order a Diet Coke from Instamart',
    });

    let toolsPassed: any[] = [];
    const mockAi = new MockAIProvider(async (messages, options) => {
      toolsPassed = options?.tools || [];
      return {
        text: 'No problem, cancelled! I can help you with travel bookings, research, calendar, and more.',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const result = await orchestrator.processMessage({
      phoneNumber: '+919999900004',
      name: 'Sam',
      preferredName: 'Sam',
      nameConfirmed: true,
      text,
      channel: 'whatsapp',
    });

    consoleSpy.mockRestore();

    expect(logs.some((l) => l.includes('[Context] stale_context_rejected reason="user_cancelled"'))).toBe(true);
    expect(logs.some((l) => l.includes('[Context] previous_task_not_resumed reason="user_cancelled"'))).toBe(true);
    expect(toolsPassed).toEqual([]);
    expect(result.replyText).toContain('cancelled');
  });

  // =========================================================================
  // 5. Bug 1: Explicit continuation ("Continue" / "Go ahead") resumes previous task
  // =========================================================================
  it('5. Explicit continuation ("Continue") resumes previous commerce task', async () => {
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    expect(isContinuationMessage('Continue')).toBe(true);
    expect(isContinuationMessage('go ahead and order')).toBe(true);
    expect(isContinuationMessage('continue the order')).toBe(true);

    const user = await db.findOrCreateUserByPhone('+919999900005', 'Vikram');
    user.preferred_name = 'Vikram';
    user.name_confirmed = true;
    const conversation = await db.getOrCreateActiveConversation(user.id, 'whatsapp');

    await db.saveMessage({
      conversation_id: conversation.id,
      sender_type: 'user',
      content: 'Order a Diet Coke from Instamart',
    });

    const mockAi = new MockAIProvider(async () => {
      return {
        text: 'Continuing with your Swiggy Instamart order for Diet Coke.',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const result = await orchestrator.processMessage({
      phoneNumber: '+919999900005',
      name: 'Vikram',
      preferredName: 'Vikram',
      nameConfirmed: true,
      text: 'Continue',
      channel: 'whatsapp',
    });

    consoleSpy.mockRestore();

    // Verify task resumed
    expect(logs.some((l) => l.includes('taskId=task_') && l.includes('_resumed'))).toBe(true);
    expect(logs.some((l) => l.includes('[Context] previous_task_not_resumed'))).toBe(false);
    expect(result.replyText).toContain('Continuing');
  });

  // =========================================================================
  // 6. Bug 4: Google search box resolution (<textarea name="q"> / [name="q"])
  // =========================================================================
  it('6. Google search box resolves dynamically via textarea[name="q"] and tag-agnostic [name="q"]', async () => {
    const resolver = new ComputerUseResolver();

    // Mock page mimicking modern google.com DOM with <textarea name="q" ...>
    const mockGooglePage: any = {
      url: () => 'https://www.google.com',
      title: async () => 'Google',
      isClosed: () => false,
      evaluate: async (fn: any) => {
        return {
          textSummary: 'Google Search. About Store Gmail Images',
          searchInputs: [
            {
              selector: 'textarea[name="q"]',
              placeholder: '',
              name: 'q',
              ariaLabel: 'Search',
              confidence: 0.95,
            },
          ],
          actionButtons: [
            {
              selector: 'input[value="Google Search"]',
              text: 'Google Search',
              targetType: 'custom',
              confidence: 0.8,
            },
          ],
          products: [],
        };
      },
      $: async (selector: string) => {
        // Tag-agnostic [name="q"] matches
        if (selector === '[name="q"]' || selector === 'textarea[name="q"]') {
          return {
            evaluate: async () => true,
          };
        }
        return null;
      },
      getByRole: () => ({ count: async () => 0 }),
      getByPlaceholder: () => ({ count: async () => 0 }),
      getByText: () => ({ count: async () => 0 }),
    };

    // 1. Observe page finds textarea[name="q"]
    const observation = await resolver.observePage(mockGooglePage);
    expect(observation.searchInputs.length).toBeGreaterThan(0);
    expect(observation.searchInputs[0].selector).toBe('textarea[name="q"]');
    expect(observation.searchInputs[0].confidence).toBe(0.95);

    // 2. Resolve input[name="q"] dynamically maps to tag-agnostic [name="q"]
    const resolved = await resolver.resolveTarget(mockGooglePage, 'input[name="q"]');
    expect(resolved).toBeDefined();
    expect(resolved?.selector).toBe('[name="q"]');
    expect(resolved?.confidence).toBe(0.95);
  });

  // =========================================================================
  // 7. Bug 2: Slow browser_open does not starve next browser action
  // =========================================================================
  it('7. Computer-use budget (60s) decouples browser actions so slow browser_open (12s) does not starve browser_type', async () => {
    expect(COMPUTER_USE_TASK_DEADLINE_MS).toBe(60000);
    expect(REQUEST_MESSAGE_DEADLINE_MS).toBe(22000);

    let recordedTypeTimeout: number | undefined;

    // Custom tool registry with mock browser_type recording its effective timeout
    const customRegistry = createDefaultToolRegistry({ db, browserService });
    const mockTypeTool: BaseTool = {
      name: 'browser_type',
      description: 'Types text into selector',
      riskLevel: 'read_only',
      parametersSchema: z.object({ selector: z.string(), text: z.string() }),
      requiresApproval: () => ({ required: false }),
      execute: async (args: any, context: ToolExecutionContext): Promise<ToolResult> => {
        recordedTypeTimeout = context.timeoutMs;
        return { success: true, data: { success: true } };
      },
    };
    customRegistry.register(mockTypeTool);

    let step = 0;
    const mockAi = new MockAIProvider(async () => {
      step++;
      if (step === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'tc1', name: 'browser_type', arguments: { selector: '[name="q"]', text: 'NEXA AI' } }],
        };
      }
      return { text: 'Typed successfully' };
    });

    const orchestrator = new AgentOrchestrator(mockAi, customRegistry, db);

    // Simulate request start 12 seconds ago (mimicking a 12s browser_open)
    const simulatedReceivedAt = Date.now() - 12000;

    const result = await orchestrator.processMessage({
      phoneNumber: '+919999900007',
      name: 'DevUser',
      preferredName: 'DevUser',
      nameConfirmed: true,
      text: 'Search Google for NEXA AI',
      channel: 'whatsapp',
      receivedAt: simulatedReceivedAt,
    });

    expect(result.replyText).toBe('Typed successfully');

    // browser_type gets its full 12s budget because remaining in 60s budget is ~48s, NOT starved to ~2.9s!
    expect(recordedTypeTimeout).toBe(12000);
  });

  // =========================================================================
  // 8. Bug 3: Browser readiness polling detects interactive elements
  // =========================================================================
  it('8. waitForPageReady polls boundedly and returns ready when interactive elements appear', async () => {
    let evalCalls = 0;
    const mockPage: any = {
      url: () => 'https://example.com/loading',
      isClosed: () => false,
      waitForLoadState: async () => {},
      evaluate: async () => {
        evalCalls++;
        // Elements become available on 2nd poll
        if (evalCalls >= 2) {
          return 5;
        }
        return 0;
      },
    };

    const readiness = await browserService.waitForPageReady(mockPage, 4000);
    expect(readiness.ready).toBe(true);
    expect(readiness.elementsCount).toBe(5);
    expect(readiness.latencyMs).toBeLessThan(2000);
  });

  // =========================================================================
  // 9. Bug 1: Stale tool call rejection ([Context] stale_tool_call_rejected)
  // =========================================================================
  it('9. Stale tool calls with mismatched requestId or taskId are rejected', async () => {
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    let turn = 0;
    const mockAi = new MockAIProvider(async () => {
      turn++;
      if (turn === 1) {
        // Return a stale tool call stamped with a previous request ID
        const staleToolCall: any = {
          id: 'stale_call_1',
          name: 'shopping_search',
          arguments: { query: 'Diet Coke', merchant: 'Swiggy Instamart' },
          requestId: 'req_stale_old_123',
          taskId: 'task_stale_old_456',
        };
        return {
          text: '',
          toolCalls: [staleToolCall],
        };
      }
      return { text: 'Recovered from stale tool call' };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const result = await orchestrator.processMessage({
      phoneNumber: '+919999900009',
      name: 'StaleTestUser',
      preferredName: 'StaleTestUser',
      nameConfirmed: true,
      text: 'Order a Diet Coke from Instamart',
      channel: 'whatsapp',
    });

    consoleSpy.mockRestore();

    expect(logs.some((l) => l.includes('[Context] stale_tool_call_rejected tool=shopping_search tool_call_id=stale_call_1'))).toBe(true);
    expect(result.replyText).toBe('Recovered from stale tool call');
  });

  // =========================================================================
  // 10. Bug 5: deadline_approaching transitions to FAILED and NEVER logs task_completed
  // =========================================================================
  it('10. deadline_approaching transitions to FAILED and never logs task_completed', async () => {
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const mockAi = new MockAIProvider(async () => {
      return { text: 'Some text' };
    });

    // Provide an orchestrator where deadline has already elapsed (simulating remainingMs <= 3000)
    const simulatedReceivedAt = Date.now() - 25000; // 25s elapsed on a 22s deadline

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db, 5, undefined, 7000, 22000);
    const result = await orchestrator.processMessage({
      phoneNumber: '+919999900010',
      name: 'DeadlineTestUser',
      preferredName: 'DeadlineTestUser',
      nameConfirmed: true,
      text: 'Hello NEXA',
      channel: 'whatsapp',
      receivedAt: simulatedReceivedAt,
    });

    consoleSpy.mockRestore();

    expect(logs.some((l) => l.includes('[Agent] deadline_approaching'))).toBe(true);
    expect(logs.some((l) => l.includes('[Agent] task_failed reason="deadline_approaching"'))).toBe(true);

    // Strictly forbidden: task_completed must NEVER be logged when deadline exceeded!
    expect(logs.some((l) => l.includes('[Agent] task_completed'))).toBe(false);

    expect(result.replyText).toContain('time limit');
  });

  // =========================================================================
  // 11. Greeting after travel: User sends greeting after previous travel booking query -> CONVERSATION, 0 tools, no travel resumed
  // =========================================================================
  it('11. Greeting after previous travel booking query classifies as CONVERSATION and does not resume travel task', async () => {
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const user = await db.findOrCreateUserByPhone('+919999900011', 'Traveler');
    user.preferred_name = 'Traveler';
    user.name_confirmed = true;
    const conversation = await db.getOrCreateActiveConversation(user.id, 'whatsapp');

    // Prior travel history
    await db.saveMessage({
      conversation_id: conversation.id,
      sender_type: 'user',
      content: 'Book a flight to Mumbai tomorrow',
    });
    await db.saveMessage({
      conversation_id: conversation.id,
      sender_type: 'assistant',
      content: 'I found 3 flights to Mumbai.',
    });

    let toolsPassed: any[] = [];
    const mockAi = new MockAIProvider(async (messages, options) => {
      toolsPassed = options?.tools || [];
      return {
        text: 'Hello Traveler! How can I help you today?',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const result = await orchestrator.processMessage({
      phoneNumber: '+919999900011',
      name: 'Traveler',
      preferredName: 'Traveler',
      nameConfirmed: true,
      text: 'Hello NEXA',
      channel: 'whatsapp',
    });

    consoleSpy.mockRestore();

    expect(logs.some((l) => l.includes('[Context] previous_task_not_resumed reason="no_explicit_continuation"'))).toBe(true);
    expect(logs.some((l) => l.includes('[Context] request_intent_classified intent=CONVERSATION'))).toBe(true);
    expect(toolsPassed).toEqual([]);
    expect(result.replyText).toContain('Hello Traveler');
  });

  // =========================================================================
  // 12. Slow page load with 0 interactive elements -> waitForPageReady returns ready=false gracefully
  // =========================================================================
  it('12. waitForPageReady returns ready=false gracefully when timeout expires with 0 interactive elements', async () => {
    const mockBlankPage: any = {
      url: () => 'https://example.com/blank',
      isClosed: () => false,
      waitForLoadState: async () => {},
      evaluate: async () => 0,
    };

    const readiness = await browserService.waitForPageReady(mockBlankPage, 300);
    expect(readiness.ready).toBe(false);
    expect(readiness.elementsCount).toBe(0);
    expect(readiness.latencyMs).toBeGreaterThanOrEqual(250);
  });

  // =========================================================================
  // 13. Tool failure transitions to FAILED and NEVER logs [Agent] task_completed
  // =========================================================================
  it('13. Tool failure transitions task to FAILED and never logs task_completed', async () => {
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const failingRegistry = createDefaultToolRegistry({ db, browserService });
    const mockFailTool: BaseTool = {
      name: 'browser_failing_tool',
      description: 'A tool that fails',
      riskLevel: 'read_only',
      parametersSchema: z.object({ query: z.string() }),
      requiresApproval: () => ({ required: false }),
      execute: async () => {
        return { success: false, error: 'Database connection failed' };
      },
    };
    failingRegistry.register(mockFailTool);

    let step = 0;
    const mockAi = new MockAIProvider(async () => {
      step++;
      if (step === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'fail_tc1', name: 'browser_failing_tool', arguments: { query: 'test' } }],
        };
      }
      return { text: 'I noticed the action failed and could not be completed.' };
    });

    const orchestrator = new AgentOrchestrator(mockAi, failingRegistry, db);
    const result = await orchestrator.processMessage({
      phoneNumber: '+919999900013',
      name: 'FailUser',
      preferredName: 'FailUser',
      nameConfirmed: true,
      text: 'Execute failing action',
      channel: 'whatsapp',
    });

    consoleSpy.mockRestore();

    expect(logs.some((l) => l.includes('[Agent] task_failed reason="action_execution_failed"'))).toBe(true);
    expect(logs.some((l) => l.includes('[Agent] task_completed'))).toBe(false);
    expect(result.replyText).toContain('failed');
  });

  // =========================================================================
  // 14. Terminal state guarantees: TaskStateMachine forbids illegal transitions
  // =========================================================================
  it('14. TaskStateMachine strictly enforces terminal state boundaries (FAILED/CANCELLED/COMPLETED)', () => {
    // 1. FAILED cannot transition to COMPLETED or CANCELLED
    const failedSm = new TaskStateMachine('FAILED');
    expect(failedSm.isTerminal()).toBe(true);
    expect(failedSm.canTransitionTo('COMPLETED')).toBe(false);
    expect(failedSm.canTransitionTo('CANCELLED')).toBe(false);
    expect(() => failedSm.transitionTo('COMPLETED')).toThrow(/Illegal task state transition: FAILED -> COMPLETED/);

    // 2. CANCELLED cannot transition to COMPLETED or FAILED
    const cancelledSm = new TaskStateMachine('CANCELLED');
    expect(cancelledSm.isTerminal()).toBe(true);
    expect(cancelledSm.canTransitionTo('COMPLETED')).toBe(false);
    expect(cancelledSm.canTransitionTo('FAILED')).toBe(false);
    expect(() => cancelledSm.transitionTo('COMPLETED')).toThrow(/Illegal task state transition: CANCELLED -> COMPLETED/);

    // 3. COMPLETED cannot transition to FAILED or CANCELLED
    const completedSm = new TaskStateMachine('COMPLETED');
    expect(completedSm.isTerminal()).toBe(true);
    expect(completedSm.canTransitionTo('FAILED')).toBe(false);
    expect(completedSm.canTransitionTo('CANCELLED')).toBe(false);
    expect(() => completedSm.transitionTo('FAILED')).toThrow(/Illegal task state transition: COMPLETED -> FAILED/);

    // 4. Active state can transition to CANCELLED
    const activeSm = new TaskStateMachine('EXECUTING');
    expect(activeSm.isTerminal()).toBe(false);
    expect(activeSm.canTransitionTo('CANCELLED')).toBe(true);
    activeSm.transitionTo('CANCELLED');
    expect(activeSm.getState()).toBe('CANCELLED');
    expect(activeSm.isTerminal()).toBe(true);
  });

  // =========================================================================
  // 15. Intent Tool Gate: CONVERSATION intent receives strictly zero tool declarations
  // =========================================================================
  it('15. CONVERSATION intent provides strictly empty toolDeclarations to Gemini', async () => {
    let toolsPassed: any[] = [];
    const mockAi = new MockAIProvider(async (messages, options) => {
      toolsPassed = options?.tools || [];
      return { text: 'I am doing great, thank you!' };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    await orchestrator.processMessage({
      phoneNumber: '+919999900015',
      name: 'ChatUser',
      preferredName: 'ChatUser',
      nameConfirmed: true,
      text: 'How are you doing today?',
      channel: 'whatsapp',
    });

    expect(toolsPassed).toHaveLength(0);
  });

  // =========================================================================
  // 16. Intent Tool Gate: SHOPPING intent filters out travel and email tools
  // =========================================================================
  it('16. SHOPPING intent provides commerce tools and excludes travel booking / email tools', async () => {
    let toolsPassed: any[] = [];
    const mockAi = new MockAIProvider(async (messages, options) => {
      toolsPassed = options?.tools || [];
      return { text: 'Looking up products...' };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    await orchestrator.processMessage({
      phoneNumber: '+919999900016',
      name: 'ShopUser',
      preferredName: 'ShopUser',
      nameConfirmed: true,
      text: 'Order groceries on Blinkit',
      channel: 'whatsapp',
    });

    expect(toolsPassed.length).toBeGreaterThan(0);
    expect(toolsPassed.some((t) => t.name.startsWith('book_'))).toBe(false);
    expect(toolsPassed.some((t) => t.name === 'send_email')).toBe(false);
  });

  // =========================================================================
  // 17. Intent Tool Gate: RESEARCH intent excludes commerce and wallet tools
  // =========================================================================
  it('17. RESEARCH intent excludes shopping, wallet, and booking tools', async () => {
    let toolsPassed: any[] = [];
    const mockAi = new MockAIProvider(async (messages, options) => {
      toolsPassed = options?.tools || [];
      return { text: 'Searching information...' };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    await orchestrator.processMessage({
      phoneNumber: '+919999900017',
      name: 'ResearchUser',
      preferredName: 'ResearchUser',
      nameConfirmed: true,
      text: 'What is the capital of France and its history?',
      channel: 'whatsapp',
    });

    expect(toolsPassed.length).toBeGreaterThan(0);
    expect(toolsPassed.some((t) => t.name.startsWith('shopping_'))).toBe(false);
    expect(toolsPassed.some((t) => t.name.startsWith('wallet_'))).toBe(false);
    expect(toolsPassed.some((t) => t.name.startsWith('book_'))).toBe(false);
  });

  // =========================================================================
  // 18. User rejection of pending approval transitions to CANCELLED and logs task_cancelled
  // =========================================================================
  it('18. Rejection of pending approval transitions to CANCELLED and never logs task_completed', async () => {
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const user = await db.findOrCreateUserByPhone('+919999900018', 'RejectUser');
    user.preferred_name = 'RejectUser';
    user.name_confirmed = true;
    const conversation = await db.getOrCreateActiveConversation(user.id, 'whatsapp');

    // Create pending approval
    await db.createApproval({
      conversation_id: conversation.id,
      user_id: user.id,
      tool_name: 'wallet_pay',
      arguments: { amount_minor: 50000, recipient: 'Merchant' },
      summary: 'Payment of ₹500 to Merchant',
      impact_level: 'critical',
      status: 'pending',
      expires_at: new Date(Date.now() + 60000).toISOString(),
      metadata: {},
    });

    const mockAi = new MockAIProvider(async () => ({ text: '' }));
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const result = await orchestrator.processMessage({
      phoneNumber: '+919999900018',
      name: 'RejectUser',
      preferredName: 'RejectUser',
      nameConfirmed: true,
      text: 'No, cancel it',
      channel: 'whatsapp',
    });

    consoleSpy.mockRestore();

    expect(logs.some((l) => l.includes('[Agent] task_cancelled reason="user_rejected"'))).toBe(true);
    expect(logs.some((l) => l.includes('[Agent] task_completed'))).toBe(false);
    expect(result.replyText).toContain('cancelled that action');
  });

  // =========================================================================
  // 19. Confirmed action failure transitions to FAILED and never logs task_completed
  // =========================================================================
  it('19. Confirmed action failure transitions to FAILED and never logs task_completed', async () => {
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const user = await db.findOrCreateUserByPhone('+919999900019', 'ConfirmFailUser');
    user.preferred_name = 'ConfirmFailUser';
    user.name_confirmed = true;
    const conversation = await db.getOrCreateActiveConversation(user.id, 'whatsapp');

    // Register a tool that fails when confirmed
    const customRegistry = createDefaultToolRegistry({ db, browserService });
    const mockFailingPaymentTool: BaseTool = {
      name: 'failing_action_tool',
      description: 'Fails upon confirmation',
      riskLevel: 'critical',
      parametersSchema: z.object({ amount: z.number() }),
      requiresApproval: () => ({ required: true, summary: 'Action' }),
      execute: async () => {
        return { success: false, error: 'Insufficient funds in payment gateway' };
      },
    };
    customRegistry.register(mockFailingPaymentTool);

    await db.createApproval({
      conversation_id: conversation.id,
      user_id: user.id,
      tool_name: 'failing_action_tool',
      arguments: { amount: 100 },
      summary: 'Action for ₹100',
      impact_level: 'critical',
      status: 'pending',
      expires_at: new Date(Date.now() + 60000).toISOString(),
      metadata: {},
    });

    const mockAi = new MockAIProvider(async () => ({ text: '' }));
    const orchestrator = new AgentOrchestrator(mockAi, customRegistry, db);
    await orchestrator.processMessage({
      phoneNumber: '+919999900019',
      name: 'ConfirmFailUser',
      preferredName: 'ConfirmFailUser',
      nameConfirmed: true,
      text: 'Yes, proceed',
      channel: 'whatsapp',
    });

    consoleSpy.mockRestore();

    expect(logs.some((l) => l.includes('[Agent] task_failed reason="confirmed_action_failed"'))).toBe(true);
    expect(logs.some((l) => l.includes('[Agent] task_completed'))).toBe(false);
  });
});
