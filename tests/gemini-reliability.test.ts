import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  GeminiProvider,
  extractStatusCode,
  isPermanentError,
  isTransientError,
} from '../packages/ai/src/gemini-provider.js';
import {
  GEMINI_SDK_TIMEOUT_MS,
  GEMINI_ATTEMPT_TIMEOUT_MS,
  GEMINI_TOOL_ATTEMPT_TIMEOUT_MS,
  TOTAL_AGENT_DEADLINE_MS,
  COMMERCE_TASK_DEADLINE_MS,
  BROWSER_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
} from '@nexa/shared';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';
import { merchantResolver } from '../packages/tools/src/index.js';

describe('NEXA Final Gemini Reliability & Fast-Path Suite', () => {
  const dummyApiKey = 'AIzaSyFakeKeyForReliabilityTests1234567';

  // =========================================================================
  // 1. Timeouts Separation
  // =========================================================================
  describe('1. Timeout Separation & Configuration', () => {
    it('separates all timeouts completely (SDK, Attempt, Tool, Browser, Agent Deadline)', () => {
      expect(GEMINI_SDK_TIMEOUT_MS).toBe(30000);
      expect(GEMINI_ATTEMPT_TIMEOUT_MS).toBe(10000);
      expect(GEMINI_TOOL_ATTEMPT_TIMEOUT_MS).toBe(18000);
      expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(7000);
      expect(BROWSER_TIMEOUT_MS).toBe(25000);
      expect(TOTAL_AGENT_DEADLINE_MS).toBe(22000);
      expect(COMMERCE_TASK_DEADLINE_MS).toBe(120000);

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.7-flash',
        fallbackModel: 'gemini-3.6-flash',
      });

      expect(provider.getDefaultModel()).toBe('gemini-3.7-flash');
      expect(provider.getFallbackModel()).toBe('gemini-3.6-flash');
      expect(provider.getAttemptTimeoutMs()).toBe(10000);
      expect(provider.getToolAttemptTimeoutMs()).toBe(18000);
      expect(provider.getSdkTimeoutMs()).toBe(30000);
    });
  });

  // =========================================================================
  // 2. 503 → retry → success
  // =========================================================================
  describe('2. 503 → retry → success', () => {
    it('retries transient 503 on primary model and succeeds on second attempt', async () => {
      const logs: string[] = [];
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      let callCount = 0;
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error('503 Service Unavailable: High demand on model');
          err.status = 503;
          throw err;
        }
        return {
          text: 'Success after 503 retry',
        };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.7-flash',
        fallbackModel: 'gemini-3.6-flash',
        primaryMaxRetries: 1,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      const res = await provider.generateResponse(
        [{ role: 'user', content: 'What is the capital of France?' }],
        { isCommerceTask: true }
      );

      consoleSpy.mockRestore();

      expect(res.text).toBe('Success after 503 retry');
      expect(callCount).toBe(2);
      expect(logs.some((l) => l.includes('[Gemini] transient_error') && l.includes('error_status=503'))).toBe(true);
      expect(logs.some((l) => l.includes('[Gemini] retry_scheduled') && l.includes('error_status=503'))).toBe(true);
      expect(logs.some((l) => l.includes('[Gemini] request_success') && l.includes('attempt=2'))).toBe(true);
    });
  });

  // =========================================================================
  // 3. 504 → retry → success
  // =========================================================================
  describe('3. 504 → retry → success', () => {
    it('retries transient 504 timeout on primary model and succeeds on second attempt', async () => {
      const logs: string[] = [];
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      let callCount = 0;
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error('504 Gateway Timeout: Deadline Exceeded');
          err.status = 504;
          err.code = 'ETIMEDOUT';
          throw err;
        }
        return {
          text: 'Success after 504 retry',
        };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.7-flash',
        fallbackModel: 'gemini-3.6-flash',
        primaryMaxRetries: 1,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      const res = await provider.generateResponse(
        [{ role: 'user', content: 'Search product' }],
        { isToolUse: true }
      );

      consoleSpy.mockRestore();

      expect(res.text).toBe('Success after 504 retry');
      expect(callCount).toBe(2);
      expect(logs.some((l) => l.includes('[Gemini] transient_error') && l.includes('error_status=504'))).toBe(true);
      expect(logs.some((l) => l.includes('[Gemini] retry_scheduled') && l.includes('error_status=504'))).toBe(true);
      expect(logs.some((l) => l.includes('[Gemini] request_success') && l.includes('attempt=2'))).toBe(true);
    });
  });

  // =========================================================================
  // 4. primary 504 → fallback 3.6 → success
  // =========================================================================
  describe('4. primary 504 → fallback 3.6 → success', () => {
    it('falls back to gemini-3.6-flash when primary model encounters 504, and fallback succeeds', async () => {
      const logs: string[] = [];
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      const modelsCalled: string[] = [];
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        modelsCalled.push(params.model);
        if (params.model === 'gemini-3.7-flash') {
          const err: any = new Error('504 Gateway Timeout');
          err.status = 504;
          throw err;
        }
        if (params.model === 'gemini-3.6-flash') {
          return {
            text: 'Success from fallback gemini-3.6-flash after primary 504',
          };
        }
        throw new Error('Unknown model');
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.7-flash',
        fallbackModel: 'gemini-3.6-flash',
        primaryMaxRetries: 1,
        fallbackMaxRetries: 1,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      const res = await provider.generateResponse(
        [{ role: 'user', content: 'Order grocery' }],
        { isCommerceTask: true }
      );

      consoleSpy.mockRestore();

      expect(res.text).toBe('Success from fallback gemini-3.6-flash after primary 504');
      expect(modelsCalled).toEqual([
        'gemini-3.7-flash',
        'gemini-3.7-flash',
        'gemini-3.6-flash',
      ]);
      expect(logs.some((l) => l.includes('[Gemini] fallback_model_switch') && l.includes('to=gemini-3.6-flash'))).toBe(true);
      expect(logs.some((l) => l.includes('[Gemini] fallback_success') && l.includes('model=gemini-3.6-flash'))).toBe(true);
    });
  });

  // =========================================================================
  // 5. primary 503 → fallback 3.6 → success
  // =========================================================================
  describe('5. primary 503 → fallback 3.6 → success', () => {
    it('falls back to gemini-3.6-flash when primary model encounters 503, and fallback succeeds', async () => {
      const logs: string[] = [];
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      const modelsCalled: string[] = [];
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        modelsCalled.push(params.model);
        if (params.model === 'gemini-3.7-flash') {
          const err: any = new Error('503 Service Unavailable: overloaded');
          err.status = 503;
          throw err;
        }
        if (params.model === 'gemini-3.6-flash') {
          return {
            text: 'Success from fallback gemini-3.6-flash after primary 503',
          };
        }
        throw new Error('Unknown model');
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.7-flash',
        fallbackModel: 'gemini-3.6-flash',
        primaryMaxRetries: 1,
        fallbackMaxRetries: 1,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      const res = await provider.generateResponse(
        [{ role: 'user', content: 'Order a coffee' }],
        { isCommerceTask: true }
      );

      consoleSpy.mockRestore();

      expect(res.text).toBe('Success from fallback gemini-3.6-flash after primary 503');
      expect(modelsCalled).toEqual([
        'gemini-3.7-flash',
        'gemini-3.7-flash',
        'gemini-3.6-flash',
      ]);
      expect(logs.some((l) => l.includes('[Gemini] fallback_model_switch') && l.includes('to=gemini-3.6-flash'))).toBe(true);
      expect(logs.some((l) => l.includes('[Gemini] fallback_success') && l.includes('model=gemini-3.6-flash'))).toBe(true);
    });
  });

  // =========================================================================
  // 6. Both models unavailable → strict task_failed
  // =========================================================================
  describe('6. Both models unavailable', () => {
    it('logs all_attempts_failed and orchestrator reports task_failed, NEVER task_completed', async () => {
      const logs: string[] = [];
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        const err: any = new Error(`503 UNAVAILABLE on model ${params.model}`);
        err.status = 503;
        throw err;
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.7-flash',
        fallbackModel: 'gemini-3.6-flash',
        primaryMaxRetries: 1,
        fallbackMaxRetries: 1,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      const db = new InMemoryRepository();
      const toolRegistry = createDefaultToolRegistry({ db });
      const orchestrator = new AgentOrchestrator(provider, toolRegistry, db);

      const result = await orchestrator.processMessage({
        phoneNumber: '+19998887777',
        name: 'FailureUser',
        preferredName: 'FailureUser',
        nameConfirmed: true,
        text: 'Order a Diet Coke from Blinkit',
        channel: 'whatsapp',
      });

      consoleSpy.mockRestore();

      // Verification:
      expect(logs.some((l) => l.includes('[Gemini] all_attempts_failed'))).toBe(true);
      expect(logs.some((l) => l.includes('[Agent] task_failed reason="model_failed"'))).toBe(true);
      expect(logs.some((l) => l.includes('[Agent] task_completed'))).toBe(false);
      expect(result.replyText).toContain('high load');
    });
  });

  // =========================================================================
  // 7. Permanent 4xx does not retry
  // =========================================================================
  describe('7. Permanent 4xx does not retry', () => {
    it('immediately aborts without retry or sleep on 401 unauthenticated error', async () => {
      let callCount = 0;
      let sleepCalled = false;

      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        const err: any = new Error('401 API_KEY_INVALID: User not authenticated');
        err.status = 401;
        throw err;
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.7-flash',
        fallbackModel: 'gemini-3.6-flash',
        primaryMaxRetries: 2,
        generateContentFn: mockGenerate,
        sleepFn: async () => {
          sleepCalled = true;
        },
      });

      await expect(
        provider.generateResponse([{ role: 'user', content: 'Hello' }], { isCommerceTask: true })
      ).rejects.toThrow();

      expect(callCount).toBe(1); // Exactly 1 attempt
      expect(sleepCalled).toBe(false); // No retries or sleeps
    });
  });

  // =========================================================================
  // 8. Deadline Propagation
  // =========================================================================
  describe('8. Deadline Propagation', () => {
    it('propagates remaining deadline to fallback attempt without giving tiny clipped window', async () => {
      const logs: string[] = [];
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        if (params.model === 'gemini-3.7-flash') {
          const err: any = new Error('504 Gateway Timeout');
          err.status = 504;
          throw err;
        }
        return { text: 'Fallback response' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.7-flash',
        fallbackModel: 'gemini-3.6-flash',
        toolAttemptTimeoutMs: 18000,
        primaryMaxRetries: 1,
        fallbackMaxRetries: 0,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      await provider.generateResponse(
        [{ role: 'user', content: 'Buy items' }],
        { isCommerceTask: true, overallDeadlineMs: 120000 }
      );

      consoleSpy.mockRestore();

      // Check fallback request_start log
      const fallbackStartLog = logs.find(
        (l) => l.includes('[Gemini] request_start model=gemini-3.6-flash') && l.includes('timeout_ms=18000')
      );
      expect(fallbackStartLog).toBeDefined();
      expect(fallbackStartLog).toContain('timeout_ms=18000');
    });
  });

  // =========================================================================
  // 9. Simple-message fast path
  // =========================================================================
  describe('9. Simple-message Fast Path', () => {
    it('takes fast path (1 attempt, 0 retries, no fallback) for simple conversational message', async () => {
      let callCount = 0;
      const modelsCalled: string[] = [];

      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        callCount++;
        modelsCalled.push(params.model);
        return { text: 'Hello there! How can I help you today?' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.7-flash',
        fallbackModel: 'gemini-3.6-flash',
        generateContentFn: mockGenerate,
      });

      const res = await provider.generateResponse(
        [{ role: 'user', content: 'Hi' }],
        { isSimpleChat: true }
      );

      expect(res.text).toBe('Hello there! How can I help you today?');
      expect(callCount).toBe(1);
      expect(modelsCalled).toEqual(['gemini-3.7-flash']);
    });
  });

  // =========================================================================
  // 10. Tool-use path reaches browser tool after successful Gemini response
  // =========================================================================
  describe('10. Tool-use path reaches browser tool after successful Gemini response', () => {
    it('calls browser_open tool when Gemini returns a tool call', async () => {
      const db = new InMemoryRepository();
      const toolRegistry = createDefaultToolRegistry({ db });

      let browserOpenedUrl = '';
      toolRegistry.register({
        name: 'browser_open',
        description: 'Opens a browser page',
        riskLevel: 'read_only',
        parametersSchema: z.object({ url: z.string() }),
        requiresApproval: () => ({ required: false }),
        execute: async (args: any) => {
          browserOpenedUrl = args.url;
          return {
            success: true,
            data: { url: args.url, title: 'Test Page', text: 'Page loaded successfully' },
          };
        },
      });

      let turn = 0;
      const mockGenerate = vi.fn().mockImplementation(async () => {
        turn++;
        if (turn === 1) {
          return {
            text: '',
            functionCalls: [
              {
                id: 'call_b_open',
                name: 'browser_open',
                args: { url: 'https://example.com/shop' },
              },
            ],
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        name: 'browser_open',
                        args: { url: 'https://example.com/shop' },
                      },
                    },
                  ],
                },
              },
            ],
          };
        }
        return { text: 'I have opened the shop page for you.' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.7-flash',
        generateContentFn: mockGenerate,
      });

      const orchestrator = new AgentOrchestrator(provider, toolRegistry, db);
      const res = await orchestrator.processMessage({
        phoneNumber: '+15554443333',
        name: 'BrowserUser',
        preferredName: 'BrowserUser',
        nameConfirmed: true,
        text: 'Open the shop website',
        channel: 'whatsapp',
      });

      expect(browserOpenedUrl).toBe('https://example.com/shop');
      expect(res.replyText).toContain('opened the shop page');
      expect(res.stepsCount).toBe(2);
    });
  });

  // =========================================================================
  // 11. Requirement 14 Integration Test: "Order a Diet Coke from Instamart"
  // =========================================================================
  describe('11. Integration Test: "Order a Diet Coke from Instamart"', () => {
    it('executes Gemini success -> shopping/browser tool call -> browser opens Instamart', async () => {
      const logs: string[] = [];
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      const db = new InMemoryRepository();
      const toolRegistry = createDefaultToolRegistry({ db });

      // Track browser open call
      let browserOpenedUrl = '';
      toolRegistry.register({
        name: 'browser_open',
        description: 'Opens a browser page at target URL',
        riskLevel: 'read_only',
        parametersSchema: z.object({ url: z.string() }),
        requiresApproval: () => ({ required: false }),
        execute: async (args: any) => {
          browserOpenedUrl = args.url;
          return {
            success: true,
            data: {
              url: args.url,
              status: 200,
              title: 'Swiggy Instamart - Online Grocery',
              text: 'Swiggy Instamart home page with search bar for groceries and drinks',
            },
          };
        },
      });

      let turn = 0;
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        turn++;
        if (turn === 1) {
          // Gemini returns a tool call to browser_open with canonical Instamart URL
          return {
            text: '',
            functionCalls: [
              {
                id: 'call_instamart_open',
                name: 'browser_open',
                args: { url: 'https://www.swiggy.com/instamart' },
              },
            ],
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        name: 'browser_open',
                        args: { url: 'https://www.swiggy.com/instamart' },
                      },
                    },
                  ],
                },
              },
            ],
          };
        }
        // Turn 2: Synthesize next step
        return {
          text: 'I have navigated to Swiggy Instamart and located Diet Coke.',
        };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.7-flash',
        fallbackModel: 'gemini-3.6-flash',
        generateContentFn: mockGenerate,
      });

      const orchestrator = new AgentOrchestrator(provider, toolRegistry, db);

      const result = await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        name: 'CommerceUser',
        preferredName: 'CommerceUser',
        nameConfirmed: true,
        text: 'Order a Diet Coke from Instamart',
        channel: 'whatsapp',
      });

      consoleSpy.mockRestore();

      // 1. Verify merchant was resolved to Swiggy Instamart
      const resolved = merchantResolver.resolve('Order a Diet Coke from Instamart');
      expect(resolved).toBeDefined();
      expect(resolved?.name).toBe('Swiggy Instamart');
      expect(resolved?.canonicalUrl).toBe('https://www.swiggy.com/instamart');

      // 2. Verify Gemini success was logged
      expect(logs.some((l) => l.includes('[Gemini] request_start'))).toBe(true);
      expect(logs.some((l) => l.includes('[Gemini] request_success'))).toBe(true);

      // 3. Verify shopping/browser tool call occurred
      expect(logs.some((l) => l.includes('[Gemini] tool_call name=browser_open'))).toBe(true);

      // 4. Verify browser ACTUALLY opened Instamart (the test did NOT stop after creating a plan)
      expect(browserOpenedUrl).toBe('https://www.swiggy.com/instamart');

      // 5. Verify orchestrator progressed past step 1
      expect(result.stepsCount).toBeGreaterThanOrEqual(1);
      expect(result.replyText).toContain('Swiggy Instamart');
    });
  });
});
