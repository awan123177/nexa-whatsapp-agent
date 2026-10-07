import { describe, it, expect, vi } from 'vitest';
import {
  GeminiProvider,
  calculateRetryDelay,
  calculateFastRetryDelay,
  parseRetryAfter,
  extractRetryAfter,
  isPermanentError,
  isTransientError,
  extractStatusCode,
  validateGeminiConversation,
} from '../packages/ai/src/gemini-provider.js';
import { NexaError } from '../packages/shared/src/index.js';

describe('GeminiProvider Reliability & Transient Error Retry Suite', () => {
  const dummyApiKey = 'test-dummy-api-key';

  // =========================================================================
  // 1. Helper function unit tests
  // =========================================================================
  describe('Error Classification & Delay Calculations', () => {
    it('should classify 503, 429, 500, 502, 504 and network errors as transient', () => {
      expect(isTransientError({ status: 503, message: 'This model is currently experiencing high demand' })).toBe(true);
      expect(isTransientError({ status: 429, message: 'ResourceExhausted: Quota exceeded' })).toBe(true);
      expect(isTransientError({ status: 500, message: 'Internal Server Error' })).toBe(true);
      expect(isTransientError({ status: 502, message: 'Bad Gateway' })).toBe(true);
      expect(isTransientError({ status: 504, message: 'Gateway Timeout' })).toBe(true);
      expect(isTransientError({ code: 'ECONNRESET', message: 'socket hang up' })).toBe(true);
      expect(isTransientError({ code: 'ETIMEDOUT', message: 'connection timed out' })).toBe(true);
      expect(isTransientError(new Error('fetch failed'))).toBe(false); // unknown generic error without transient indicator
      expect(isTransientError(new Error('The service is temporarily unavailable (503)'))).toBe(true);
    });

    it('should classify 400, 401, 403, 404 as permanent client errors', () => {
      expect(isPermanentError({ status: 400, message: 'INVALID_ARGUMENT: malformed prompt' })).toBe(true);
      expect(isPermanentError({ status: 401, message: 'API_KEY_INVALID: Invalid API key' })).toBe(true);
      expect(isPermanentError({ status: 403, message: 'PERMISSION_DENIED: forbidden' })).toBe(true);
      expect(isPermanentError({ status: 404, message: 'NOT_FOUND: model not found' })).toBe(true);

      // Verify isTransientError returns false for all permanent errors
      expect(isTransientError({ status: 400, message: 'INVALID_ARGUMENT' })).toBe(false);
      expect(isTransientError({ status: 401, message: 'API_KEY_INVALID' })).toBe(false);
      expect(isTransientError({ status: 403, message: 'PERMISSION_DENIED' })).toBe(false);
      expect(isTransientError({ status: 404, message: 'NOT_FOUND' })).toBe(false);
    });

    it('should extract status codes from various error formats', () => {
      expect(extractStatusCode({ status: 503 })).toBe(503);
      expect(extractStatusCode({ statusCode: 429 })).toBe(429);
      expect(extractStatusCode({ response: { status: 500 } })).toBe(500);
      expect(extractStatusCode({ message: 'HTTP 502 Bad Gateway' })).toBe(502);
      expect(extractStatusCode({ message: 'Unknown error without numbers' })).toBeNull();
    });

    it('should calculate exponential backoff with jitter within expected bounds', () => {
      for (let i = 0; i < 20; i++) {
        // Attempt 1: 1–2 seconds (1000–2000ms)
        const delay1 = calculateRetryDelay(1);
        expect(delay1).toBeGreaterThanOrEqual(1000);
        expect(delay1).toBeLessThanOrEqual(2000);

        // Attempt 2: 2–4 seconds (2000–4000ms)
        const delay2 = calculateRetryDelay(2);
        expect(delay2).toBeGreaterThanOrEqual(2000);
        expect(delay2).toBeLessThanOrEqual(4000);

        // Attempt 3: 4–8 seconds (4000–8000ms)
        const delay3 = calculateRetryDelay(3);
        expect(delay3).toBeGreaterThanOrEqual(4000);
        expect(delay3).toBeLessThanOrEqual(8000);
      }
    });

    it('should parse and respect Retry-After header', () => {
      expect(parseRetryAfter(5)).toBe(5000);
      expect(parseRetryAfter('3')).toBe(3000);
      expect(parseRetryAfter('2.5')).toBe(2500);

      const errorWithHeader = { headers: { 'retry-after': '4' } };
      expect(extractRetryAfter(errorWithHeader)).toBe('4');

      const errorWithMessage = { message: 'Quota exceeded. Please retry-after: 6s' };
      expect(extractRetryAfter(errorWithMessage)).toBe(6);

      const delayWithRetryAfter = calculateRetryDelay(1, '5');
      // Should be 5000ms + small jitter (100-500ms)
      expect(delayWithRetryAfter).toBeGreaterThanOrEqual(5100);
      expect(delayWithRetryAfter).toBeLessThanOrEqual(5500);
    });

    it('should calculate fast exponential backoff with jitter within expected bounds', () => {
      for (let i = 0; i < 20; i++) {
        const delay1 = calculateFastRetryDelay(1);
        expect(delay1).toBeGreaterThanOrEqual(500);
        expect(delay1).toBeLessThanOrEqual(1000);

        const delay2 = calculateFastRetryDelay(2);
        expect(delay2).toBeGreaterThanOrEqual(1000);
        expect(delay2).toBeLessThanOrEqual(1500);
      }
    });

    it('should respect Retry-After in calculateFastRetryDelay capped sensibly', () => {
      const delay3s = calculateFastRetryDelay(1, '3');
      expect(delay3s).toBeGreaterThanOrEqual(3100);
      expect(delay3s).toBeLessThanOrEqual(3500);

      // Capped at maxCapMs (default 5000ms)
      const delay60s = calculateFastRetryDelay(1, '60');
      expect(delay60s).toBe(5000);
    });
  });

  // =========================================================================
  // 2. Automated test: 503 then success
  // =========================================================================
  describe('Transient 503 UNAVAILABLE Retry Handling', () => {
    it('should retry on 503 and succeed on second attempt (503 then success)', async () => {
      let callCount = 0;
      const sleepDelays: number[] = [];

      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error('503 UNAVAILABLE: This model is currently experiencing high demand');
          err.status = 503;
          throw err;
        }
        return {
          text: 'Response after 503 recovery',
          candidates: [{ finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
        sleepFn: async (ms) => {
          sleepDelays.push(ms);
        },
      });

      const response = await provider.generateResponse([
        { role: 'user', content: 'What is the status?' },
      ]);

      expect(response.text).toBe('Response after 503 recovery');
      expect(callCount).toBe(2);
      expect(sleepDelays).toHaveLength(1);
      // Attempt 1 fast retry delay is ~500-1000ms
      expect(sleepDelays[0]).toBeGreaterThanOrEqual(500);
      expect(sleepDelays[0]).toBeLessThanOrEqual(1000);
    });

    // =======================================================================
    // 3. Automated test: 503, 503, then success
    // =======================================================================
    it('should retry twice on consecutive 503 errors and succeed on third attempt (503, 503, then success)', async () => {
      let callCount = 0;
      const sleepDelays: number[] = [];

      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          const err: any = new Error('503 UNAVAILABLE: This model is currently experiencing high demand');
          err.status = 503;
          throw err;
        }
        return {
          text: 'Successful response on attempt 3',
          candidates: [{ finishReason: 'STOP' }],
        };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        primaryMaxRetries: 2,
        generateContentFn: mockGenerate,
        sleepFn: async (ms) => {
          sleepDelays.push(ms);
        },
      });

      const response = await provider.generateResponse([
        { role: 'user', content: 'Query' },
      ]);

      expect(response.text).toBe('Successful response on attempt 3');
      expect(callCount).toBe(3);
      expect(sleepDelays).toHaveLength(2);

      // Fast retry delays
      expect(sleepDelays[0]).toBeGreaterThanOrEqual(500);
      expect(sleepDelays[0]).toBeLessThanOrEqual(1000);

      expect(sleepDelays[1]).toBeGreaterThanOrEqual(1000);
      expect(sleepDelays[1]).toBeLessThanOrEqual(1500);
    });

    // =======================================================================
    // 4. Automated test: 3 failures then safe failure
    // =======================================================================
    it('should retry 3 times on consecutive 503 errors and throw safe user-facing failure (3 failures then safe failure)', async () => {
      let callCount = 0;
      const sleepDelays: number[] = [];

      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        const err: any = new Error('503 UNAVAILABLE: This model is currently experiencing high demand');
        err.status = 503;
        throw err;
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        fallbackModel: '', // isolate primary model for this test
        primaryMaxRetries: 3,
        generateContentFn: mockGenerate,
        sleepFn: async (ms) => {
          sleepDelays.push(ms);
        },
      });

      await expect(
        provider.generateResponse([{ role: 'user', content: 'Query' }])
      ).rejects.toThrow(NexaError);

      try {
        await provider.generateResponse([{ role: 'user', content: 'Query' }]);
      } catch (err: any) {
        expect(err).toBeInstanceOf(NexaError);
        expect(err.statusCode).toBe(503);
        expect(err.code).toBe('AI_SERVICE_UNAVAILABLE');
        expect(err.userFacingMessage).toBe(
          'NEXA is currently experiencing high load. Please try again in a moment.'
        );
      }

      // Initial call + 3 retries = 4 total attempts
      expect(sleepDelays.slice(0, 3)).toHaveLength(3);
      expect(sleepDelays[0]).toBeGreaterThanOrEqual(500);
      expect(sleepDelays[0]).toBeLessThanOrEqual(1000);
      expect(sleepDelays[1]).toBeGreaterThanOrEqual(1000);
      expect(sleepDelays[1]).toBeLessThanOrEqual(1500);
      expect(sleepDelays[2]).toBeGreaterThanOrEqual(2000);
      expect(sleepDelays[2]).toBeLessThanOrEqual(2500);
    });
  });

  // =========================================================================
  // 4b. Provider-Level Fallback Model on 503 Exhaustion Suite
  // =========================================================================
  describe('Provider-Level Fallback Model on 503 Exhaustion Suite', () => {
    it('should fall back to gemini-3.7-flash when primary model exhausts retries (503 -> 503 -> 503 -> fallback model succeeds)', async () => {
      const modelsCalled: string[] = [];
      let callCount = 0;

      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        callCount++;
        modelsCalled.push(params.model);
        if (params.model === 'gemini-3.8-flash') {
          const err: any = new Error('503 UNAVAILABLE: This model is currently experiencing high demand');
          err.status = 503;
          throw err;
        }
        return {
          text: 'Successful response from fallback model gemini-3.7-flash',
        };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.8-flash',
        fallbackModel: 'gemini-3.7-flash',
        maxRetries: 2, // 1 initial + 2 retries = 3 attempts of 503 on primary
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      const response = await provider.generateResponse([{ role: 'user', content: 'Help me' }]);
      expect(response.text).toBe('Successful response from fallback model gemini-3.7-flash');
      expect(callCount).toBe(4); // 3 attempts on primary, 1 on fallback
      expect(modelsCalled).toEqual([
        'gemini-3.8-flash',
        'gemini-3.8-flash',
        'gemini-3.8-flash',
        'gemini-3.7-flash',
      ]);
    });

    it('should invoke fallback model promptly after 1 fast retry (2 attempts) on primary model', async () => {
      const modelsCalled: string[] = [];
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        modelsCalled.push(params.model);
        if (params.model === 'gemini-3.8-flash') {
          const err: any = new Error('503 UNAVAILABLE: This model is currently experiencing high demand');
          err.status = 503;
          throw err;
        }
        return { text: 'Fallback success' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.8-flash',
        fallbackModel: 'gemini-3.7-flash',
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      const response = await provider.generateResponse([{ role: 'user', content: 'Test' }]);
      expect(response.text).toBe('Fallback success');
      expect(modelsCalled.filter((m) => m === 'gemini-3.8-flash')).toHaveLength(2);
      expect(modelsCalled.filter((m) => m === 'gemini-3.7-flash')).toHaveLength(1);
    });

    it('should throw safe error when all retries on both primary and fallback model are exhausted (all retries exhausted -> safe error)', async () => {
      const modelsCalled: string[] = [];
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        modelsCalled.push(params.model);
        const err: any = new Error('503 UNAVAILABLE: This model is currently experiencing high demand');
        err.status = 503;
        throw err;
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.8-flash',
        fallbackModel: 'gemini-3.7-flash',
        maxRetries: 1, // 2 on primary, 2 on fallback = 4 total calls
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      try {
        await provider.generateResponse([{ role: 'user', content: 'Test' }]);
        expect.unreachable();
      } catch (err: any) {
        expect(err).toBeInstanceOf(NexaError);
        expect(err.statusCode).toBe(503);
        expect(err.code).toBe('AI_SERVICE_UNAVAILABLE');
        expect(err.userFacingMessage).toBe(
          'NEXA is currently experiencing high load. Please try again in a moment.'
        );
      }

      expect(modelsCalled).toEqual([
        'gemini-3.8-flash',
        'gemini-3.8-flash',
        'gemini-3.7-flash',
        'gemini-3.7-flash',
      ]);
    });

    it('should NOT invoke fallback model when error is a permanent client error (401/403/404)', async () => {
      let callCount = 0;
      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        const err: any = new Error('401 UNAUTHENTICATED: Invalid API Key');
        err.status = 401;
        throw err;
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.8-flash',
        fallbackModel: 'gemini-3.7-flash',
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      try {
        await provider.generateResponse([{ role: 'user', content: 'Test' }]);
        expect.unreachable();
      } catch (err: any) {
        expect(err).toBeInstanceOf(NexaError);
        expect(err.statusCode).toBe(401);
      }

      // Exactly 1 call: must not retry or switch to fallback model
      expect(callCount).toBe(1);
    });
  });

  // =========================================================================
  // 5. Automated test: 429 retry
  // =========================================================================
  describe('Rate Limit & 429 RESOURCE_EXHAUSTED Retry Handling', () => {
    it('should retry on 429 RESOURCE_EXHAUSTED and succeed (429 retry)', async () => {
      let callCount = 0;
      const sleepDelays: number[] = [];

      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error('429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric');
          err.status = 429;
          throw err;
        }
        return {
          text: 'Response recovered after 429 backoff',
        };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
        sleepFn: async (ms) => {
          sleepDelays.push(ms);
        },
      });

      const response = await provider.generateResponse([
        { role: 'user', content: 'Hello' },
      ]);

      expect(response.text).toBe('Response recovered after 429 backoff');
      expect(callCount).toBe(2);
      expect(sleepDelays).toHaveLength(1);
      expect(sleepDelays[0]).toBeGreaterThanOrEqual(500);
      expect(sleepDelays[0]).toBeLessThanOrEqual(1000);
    });

    it('should respect Retry-After header during 429 retry', async () => {
      let callCount = 0;
      const sleepDelays: number[] = [];

      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error('429 ResourceExhausted');
          err.status = 429;
          err.headers = { 'retry-after': '3' };
          throw err;
        }
        return { text: 'Done' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
        sleepFn: async (ms) => {
          sleepDelays.push(ms);
        },
      });

      await provider.generateResponse([{ role: 'user', content: 'Test' }]);

      expect(callCount).toBe(2);
      expect(sleepDelays).toHaveLength(1);
      // 3000ms + small jitter (100–500ms)
      expect(sleepDelays[0]).toBeGreaterThanOrEqual(3100);
      expect(sleepDelays[0]).toBeLessThanOrEqual(3500);
    });

    it('should throw safe AI_RATE_LIMIT error when all 429 retries are exhausted', async () => {
      const mockGenerate = vi.fn().mockImplementation(async () => {
        const err: any = new Error('429 RESOURCE_EXHAUSTED');
        err.status = 429;
        throw err;
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      try {
        await provider.generateResponse([{ role: 'user', content: 'Exhaust quota' }]);
        expect.unreachable();
      } catch (err: any) {
        expect(err).toBeInstanceOf(NexaError);
        expect(err.statusCode).toBe(429);
        expect(err.code).toBe('AI_RATE_LIMIT');
        expect(err.userFacingMessage).toBe(
          'NEXA is currently experiencing high load. Please try again in a moment.'
        );
      }
    });
  });

  // =========================================================================
  // 6. Automated test: permanent 401/403 does not retry
  // =========================================================================
  describe('Permanent Client/Auth Errors (No Retries)', () => {
    it('should NOT retry on permanent 401 UNAUTHENTICATED (invalid API key)', async () => {
      let callCount = 0;
      const sleepCalls: number[] = [];

      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        const err: any = new Error('401 UNAUTHENTICATED: API_KEY_INVALID');
        err.status = 401;
        throw err;
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
        sleepFn: async (ms) => {
          sleepCalls.push(ms);
        },
      });

      try {
        await provider.generateResponse([{ role: 'user', content: 'Test' }]);
        expect.unreachable();
      } catch (err: any) {
        expect(err).toBeInstanceOf(NexaError);
        expect(err.statusCode).toBe(401);
        expect(err.code).toBe('AI_AUTH_FAILED');
        expect(err.userFacingMessage).toContain('AI authentication error');
      }

      // Must NOT retry: exactly 1 call and 0 sleep calls
      expect(callCount).toBe(1);
      expect(sleepCalls).toHaveLength(0);
    });

    it('should NOT retry on permanent 403 PERMISSION_DENIED', async () => {
      let callCount = 0;
      const sleepCalls: number[] = [];

      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        const err: any = new Error('403 PERMISSION_DENIED: Access denied to model');
        err.status = 403;
        throw err;
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
        sleepFn: async (ms) => {
          sleepCalls.push(ms);
        },
      });

      try {
        await provider.generateResponse([{ role: 'user', content: 'Test' }]);
        expect.unreachable();
      } catch (err: any) {
        expect(err).toBeInstanceOf(NexaError);
        expect(err.statusCode).toBe(403);
        expect(err.code).toBe('AI_PERMISSION_DENIED');
        expect(err.userFacingMessage).toContain('AI permission error');
      }

      // Must NOT retry: exactly 1 call and 0 sleep calls
      expect(callCount).toBe(1);
      expect(sleepCalls).toHaveLength(0);
    });

    it('should NOT retry on permanent 400 INVALID_ARGUMENT (malformed request)', async () => {
      let callCount = 0;
      const sleepCalls: number[] = [];

      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        const err: any = new Error('400 INVALID_ARGUMENT: Contents must not be empty');
        err.status = 400;
        throw err;
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
        sleepFn: async (ms) => {
          sleepCalls.push(ms);
        },
      });

      await expect(
        provider.generateResponse([{ role: 'user', content: 'Test' }])
      ).rejects.toThrow(NexaError);

      expect(callCount).toBe(1);
      expect(sleepCalls).toHaveLength(0);
    });
  });

  // =========================================================================
  // 7. Automated test: transient 500, 502, 504 server errors
  // =========================================================================
  describe('Transient 500/502/504 Server Errors', () => {
    it('should retry on 500 Internal Server Error and succeed', async () => {
      let callCount = 0;
      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error('500 INTERNAL: An internal error occurred');
          err.status = 500;
          throw err;
        }
        return { text: 'Recovered from 500' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      const response = await provider.generateResponse([{ role: 'user', content: 'Test' }]);
      expect(response.text).toBe('Recovered from 500');
      expect(callCount).toBe(2);
    });

    it('should retry on 502 Bad Gateway and succeed', async () => {
      let callCount = 0;
      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error('502 Bad Gateway');
          err.status = 502;
          throw err;
        }
        return { text: 'Recovered from 502' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      const response = await provider.generateResponse([{ role: 'user', content: 'Test' }]);
      expect(response.text).toBe('Recovered from 502');
      expect(callCount).toBe(2);
    });

    it('should retry on 504 Gateway Timeout and succeed', async () => {
      let callCount = 0;
      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error('504 Gateway Timeout');
          err.status = 504;
          throw err;
        }
        return { text: 'Recovered from 504' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      const response = await provider.generateResponse([{ role: 'user', content: 'Test' }]);
      expect(response.text).toBe('Recovered from 504');
      expect(callCount).toBe(2);
    });
  });

  // =========================================================================
  // 8. Sanitized logging (never log API keys, tokens, or prompt data)
  // =========================================================================
  describe('Sanitized Logging During Retries', () => {
    it('should emit required sanitized logs: attempt, transient_error, and success', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      let callCount = 0;
      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error('503 UNAVAILABLE: High demand');
          err.status = 503;
          throw err;
        }
        return { text: 'OK' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      await provider.generateResponse([{ role: 'user', content: 'hello secret prompt' }]);

      const loggedMessages = logSpy.mock.calls.map((c) => c[0]);
      expect(loggedMessages.some((m) => m === '[Gemini] attempt=1 model=gemini-3.7-flash')).toBe(true);
      expect(
        loggedMessages.some(
          (m) => typeof m === 'string' && m.startsWith('[Gemini] transient_error status=503 retry_in_ms=')
        )
      ).toBe(true);
      expect(loggedMessages.some((m) => m === '[Gemini] attempt=2 model=gemini-3.7-flash')).toBe(true);
      expect(loggedMessages.some((m) => m === '[Gemini] success')).toBe(true);

      // Verify prompt content is NOT logged
      expect(loggedMessages.every((m) => typeof m === 'string' && !m.includes('hello secret prompt'))).toBe(true);

      logSpy.mockRestore();
    });

    it('should never leak sensitive API keys or credentials in any log', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const sensitiveLeakKey = 'AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6';

      let callCount = 0;
      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error(
            `503 UNAVAILABLE: High demand for request with key ${sensitiveLeakKey}`
          );
          err.status = 503;
          throw err;
        }
        return { text: 'Success' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      await provider.generateResponse([{ role: 'user', content: 'Test secret prompt' }]);

      const loggedMessages = logSpy.mock.calls.map((c) => c[0]);
      expect(loggedMessages.every((m) => typeof m === 'string' && !m.includes(sensitiveLeakKey))).toBe(true);

      logSpy.mockRestore();
    });

    it('should log sanitized timing instrumentation for request_start, success, fallback_model_switch, and request_failed', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      let callCount = 0;
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        callCount++;
        if (params.model === 'gemini-3.8-flash') {
          const err: any = new Error('503 UNAVAILABLE: Busy');
          err.status = 503;
          throw err;
        }
        return { text: 'Fallback OK' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.8-flash',
        fallbackModel: 'gemini-3.7-flash',
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      await provider.generateResponse([{ role: 'user', content: 'Hello timing' }]);

      const loggedMessages = logSpy.mock.calls.map((c) => c[0]);
      expect(loggedMessages.some((m) => m === '[Gemini] request_start model=gemini-3.8-flash')).toBe(true);
      expect(loggedMessages.some((m) => typeof m === 'string' && m.startsWith('[Gemini] success model=gemini-3.7-flash latency_ms='))).toBe(true);
      expect(loggedMessages.some((m) => m === '[Gemini] fallback_model_switch from=gemini-3.8-flash to=gemini-3.7-flash')).toBe(true);

      logSpy.mockRestore();
    });
  });

  // =========================================================================
  // 9. Model configuration (gemini-3.8-flash default & configurable)
  // =========================================================================
  describe('Configurable Model & gemini-3.7-flash Default', () => {
    it('should default to gemini-3.7-flash', () => {
      const provider = new GeminiProvider({ apiKey: dummyApiKey });
      expect(provider.getDefaultModel()).toBe('gemini-3.7-flash');
    });

    it('should respect custom defaultModel in constructor', () => {
      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-1.5-pro',
      });
      expect(provider.getDefaultModel()).toBe('gemini-1.5-pro');
    });

    it('should pass correct model to generateContent call', async () => {
      let passedModel = '';
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        passedModel = params.model;
        return { text: 'ok' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.8-flash',
        generateContentFn: mockGenerate,
      });

      // Default model
      await provider.generateResponse([{ role: 'user', content: 'test' }]);
      expect(passedModel).toBe('gemini-3.8-flash');

      // Overridden per call
      await provider.generateResponse([{ role: 'user', content: 'test' }], {
        model: 'gemini-2.5-pro',
      });
      expect(passedModel).toBe('gemini-2.5-pro');
    });
  });

  // =========================================================================
  // 10. Thinking Level Configuration (Gemini 3.8 Flash low/medium/high)
  // =========================================================================
  describe('Thinking Level Configuration', () => {
    it('should pass thinkingLevel: low by default in config', async () => {
      let passedConfig: any = null;
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        passedConfig = params.config;
        return { text: 'ok' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
      });

      await provider.generateResponse([{ role: 'user', content: 'hello' }]);
      expect(passedConfig?.thinkingConfig?.thinkingLevel).toBe('LOW');
    });

    it('should pass thinkingLevel: medium when elevated for complex requests', async () => {
      let passedConfig: any = null;
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        passedConfig = params.config;
        return { text: 'ok' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
      });

      await provider.generateResponse(
        [{ role: 'user', content: 'compare these products in depth' }],
        { thinkingLevel: 'medium' }
      );
      expect(passedConfig?.thinkingConfig?.thinkingLevel).toBe('MEDIUM');
    });

    it('should respect custom defaultThinkingLevel configured in provider', async () => {
      let passedConfig: any = null;
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        passedConfig = params.config;
        return { text: 'ok' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultThinkingLevel: 'high',
        generateContentFn: mockGenerate,
      });

      expect(provider.getDefaultThinkingLevel()).toBe('high');
      await provider.generateResponse([{ role: 'user', content: 'test' }]);
      expect(passedConfig?.thinkingConfig?.thinkingLevel).toBe('HIGH');
    });
  });

  // =========================================================================
  // 11. Hard Per-Request Timeout & Overall AI Deadline Suite
  // =========================================================================
  describe('Hard Per-Request Timeout & Overall AI Deadline Suite', () => {
    it('SDK request hangs -> timeout: aborts underlying request and logs timeout', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      let aborted = false;

      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        return new Promise((resolve) => {
          params.config?.abortSignal?.addEventListener('abort', () => {
            aborted = true;
          });
          // Hangs indefinitely without resolving
          setTimeout(() => resolve({ text: 'late' }), 2000);
        });
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.8-flash',
        fallbackModel: '', // isolate primary model
        primaryMaxRetries: 0,
        requestTimeoutMs: 50,
        overallDeadlineMs: 500,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      await expect(
        provider.generateResponse([{ role: 'user', content: 'hello' }])
      ).rejects.toThrow(NexaError);

      expect(aborted).toBe(true);
      const loggedMessages = logSpy.mock.calls.map((c) => c[0]);
      expect(
        loggedMessages.some(
          (m) => typeof m === 'string' && m.startsWith('[Gemini] timeout model=gemini-3.8-flash timeout_ms=50')
        )
      ).toBe(true);

      logSpy.mockRestore();
    });

    it('timeout -> fallback: switches to fallback model after primary model times out', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const modelsCalled: string[] = [];

      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        modelsCalled.push(params.model);
        if (params.model === 'gemini-3.8-flash') {
          // Hangs and times out
          return new Promise((resolve) => {
            setTimeout(() => resolve({ text: 'late' }), 2000);
          });
        }
        return { text: 'Fallback succeeded in time!' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.8-flash',
        fallbackModel: 'gemini-3.7-flash',
        primaryMaxRetries: 0, // prompt switch on first timeout
        requestTimeoutMs: 50,
        overallDeadlineMs: 1000,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      const response = await provider.generateResponse([{ role: 'user', content: 'test' }]);
      expect(response.text).toBe('Fallback succeeded in time!');
      expect(modelsCalled).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash']);

      const loggedMessages = logSpy.mock.calls.map((c) => c[0]);
      expect(
        loggedMessages.some(
          (m) => m === '[Gemini] fallback_model_switch from=gemini-3.8-flash to=gemini-3.7-flash'
        )
      ).toBe(true);

      logSpy.mockRestore();
    });

    it('503 -> retry -> fallback: retries 503 then switches to fallback model', async () => {
      const modelsCalled: string[] = [];
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        modelsCalled.push(params.model);
        if (params.model === 'gemini-3.8-flash') {
          const err: any = new Error('503 UNAVAILABLE');
          err.status = 503;
          throw err;
        }
        return { text: 'Recovered on fallback' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.8-flash',
        fallbackModel: 'gemini-3.7-flash',
        primaryMaxRetries: 1, // 1 retry then switch
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      const response = await provider.generateResponse([{ role: 'user', content: 'query' }]);
      expect(response.text).toBe('Recovered on fallback');
      expect(modelsCalled).toEqual([
        'gemini-3.8-flash',
        'gemini-3.8-flash',
        'gemini-3.7-flash',
      ]);
    });

    it('fallback timeout -> safe error: throws safe user-facing error when both models time out', async () => {
      const mockGenerate = vi.fn().mockImplementation(async () => {
        return new Promise((resolve) => setTimeout(() => resolve({ text: 'late' }), 2000));
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.8-flash',
        fallbackModel: 'gemini-3.7-flash',
        primaryMaxRetries: 0,
        fallbackMaxRetries: 0,
        requestTimeoutMs: 50,
        overallDeadlineMs: 500,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      try {
        await provider.generateResponse([{ role: 'user', content: 'query' }]);
        expect.unreachable();
      } catch (err: any) {
        expect(err).toBeInstanceOf(NexaError);
        expect(err.statusCode).toBe(503);
        expect(err.code).toBe('AI_SERVICE_UNAVAILABLE');
        expect(err.userFacingMessage).toBe(
          'NEXA is currently experiencing high load. Please try again in a moment.'
        );
      }
    });

    it('successful fast request: completes well within timeout without aborting', async () => {
      let passedAbortSignal: any = null;
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        passedAbortSignal = params.config?.abortSignal;
        return { text: 'Fast response' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        requestTimeoutMs: 5000,
        generateContentFn: mockGenerate,
      });

      const response = await provider.generateResponse([{ role: 'user', content: 'hi' }]);
      expect(response.text).toBe('Fast response');
      expect(passedAbortSignal?.aborted).toBe(false);
    });

    it('permanent 401/403/404: fails immediately without waiting for timeout or retry', async () => {
      let callCount = 0;
      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        const err: any = new Error('401 UNAUTHENTICATED');
        err.status = 401;
        throw err;
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      await expect(
        provider.generateResponse([{ role: 'user', content: 'test' }])
      ).rejects.toThrow(NexaError);

      expect(callCount).toBe(1);
    });

    it('overall deadline: caps total execution time and prevents runaway retries', async () => {
      let callCount = 0;
      const mockGenerate = vi.fn().mockImplementation(async () => {
        callCount++;
        return new Promise((resolve) => setTimeout(() => resolve({ text: 'late' }), 2000));
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        primaryMaxRetries: 5,
        requestTimeoutMs: 30,
        overallDeadlineMs: 70, // deadline expires after ~2 timeouts
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      const startTime = Date.now();
      await expect(
        provider.generateResponse([{ role: 'user', content: 'test' }])
      ).rejects.toThrow(NexaError);
      const elapsed = Date.now() - startTime;

      // Must have stopped within approximately the deadline without looping 5 times
      expect(callCount).toBeLessThanOrEqual(3);
      expect(elapsed).toBeLessThan(500);
    });
  });

  // =========================================================================
  // 12. Conversation Structure Validation & Final User Turn Suite
  // =========================================================================
  describe('Conversation Structure Validation & Final User Turn Suite', () => {
    it('Test A: history ends with model + new user message => valid request ending in user', async () => {
      let passedContents: any[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        passedContents = params.contents;
        return { text: 'ok' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
      });

      // History ending in assistant + current user text supplied
      await provider.generateResponse(
        [
          { role: 'user', content: 'Previous user message' },
          { role: 'assistant', content: 'Previous assistant reply' },
        ],
        { currentUserText: 'New incoming user query' }
      );

      expect(passedContents.length).toBe(3);
      expect(passedContents[2].role).toBe('user');
      expect(passedContents[2].parts[0].text).toBe('New incoming user query');

      const loggedMessages = logSpy.mock.calls.map((c) => c[0]);
      expect(loggedMessages.some((m) => m === '[Gemini] final_turn_role=user')).toBe(true);
      expect(loggedMessages.some((m) => m === '[Gemini] conversation_roles=user,model,user')).toBe(true);

      logSpy.mockRestore();
    });

    it('Test B: history ends with model + current user already included => no duplicate user message', async () => {
      let passedContents: any[] = [];
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        passedContents = params.contents;
        return { text: 'ok' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
      });

      await provider.generateResponse(
        [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Second' },
          { role: 'user', content: 'Third' },
        ],
        { currentUserText: 'Third' }
      );

      expect(passedContents.length).toBe(3);
      expect(passedContents[0].role).toBe('user');
      expect(passedContents[1].role).toBe('model');
      expect(passedContents[2].role).toBe('user');
      expect(passedContents[2].parts[0].text).toBe('Third');
    });

    it('Test C: history ends with user => valid request', async () => {
      let passedContents: any[] = [];
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        passedContents = params.contents;
        return { text: 'ok' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
      });

      await provider.generateResponse([{ role: 'user', content: 'Single prompt' }]);
      expect(passedContents).toHaveLength(1);
      expect(passedContents[0].role).toBe('user');
      expect(passedContents[0].parts[0].text).toBe('Single prompt');
    });

    it('Test D: empty history + user message => valid request', async () => {
      let passedContents: any[] = [];
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        passedContents = params.contents;
        return { text: 'ok' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
      });

      await provider.generateResponse([], { currentUserText: 'Fresh message' });
      expect(passedContents).toHaveLength(1);
      expect(passedContents[0].role).toBe('user');
      expect(passedContents[0].parts[0].text).toBe('Fresh message');
    });

    it('validateGeminiConversation unit tests: repair model turn and enforce validation', () => {
      // 1. Repair model turn with fallback user text
      const repaired = validateGeminiConversation(
        [
          { role: 'user', parts: [{ text: 'hi' }] },
          { role: 'model', parts: [{ text: 'hello' }] },
        ],
        'Follow-up query'
      );
      expect(repaired.length).toBe(3);
      expect(repaired[2].role).toBe('user');
      expect(repaired[2].parts[0].text).toBe('Follow-up query');

      // 2. Reject model turn without fallback text
      expect(() => {
        validateGeminiConversation([
          { role: 'user', parts: [{ text: 'hi' }] },
          { role: 'model', parts: [{ text: 'hello' }] },
        ]);
      }).toThrow('final turn must be a user turn');

      // 3. Reject empty contents without fallback
      expect(() => {
        validateGeminiConversation([]);
      }).toThrow('contents cannot be empty');

      // 4. Reject invalid role
      expect(() => {
        validateGeminiConversation([{ role: 'unknown', parts: [{ text: 'bad' }] }]);
      }).toThrow('invalid role');

      // 5. Deduplicate identical consecutive user messages at the end
      const deduped = validateGeminiConversation([
        { role: 'model', parts: [{ text: 'hi' }] },
        { role: 'user', parts: [{ text: 'same' }] },
        { role: 'user', parts: [{ text: 'same' }] },
      ]);
      expect(deduped.length).toBe(2);
      expect(deduped[1].role).toBe('user');
      expect(deduped[1].parts[0].text).toBe('same');
    });

    it('Regression: reproduces exact previous 400 error on trailing model turn and proves user->model->user fix', async () => {
      // 1. Reproduce what the real Gemini API does if contents ends in a 'model' turn:
      // It returns HTTP 400 INVALID_ARGUMENT "Requests ending with a model turn are not supported."
      const mockRealGeminiSdk = vi.fn().mockImplementation(async (params) => {
        const last = params.contents[params.contents.length - 1];
        if (last.role === 'model') {
          const err: any = new Error(
            'HTTP 400 INVALID_ARGUMENT: Requests ending with a model turn are not supported.'
          );
          err.status = 400;
          throw err;
        }
        return { text: `Success: handled response for "${last.parts[0].text}"` };
      });

      // Proof 1: The exact previous bug reproduced.
      // If raw contents ending in model turn is submitted to Gemini SDK without validation:
      const rawBuggyContents = [
        { role: 'user', parts: [{ text: 'First user message' }] },
        { role: 'model', parts: [{ text: 'First assistant reply' }] },
      ];
      await expect(
        mockRealGeminiSdk({ contents: rawBuggyContents })
      ).rejects.toThrow('HTTP 400 INVALID_ARGUMENT: Requests ending with a model turn are not supported.');

      // Proof 2: validateGeminiConversation catches unrepairable trailing model turn
      // and blocks the invalid request before sending to Gemini:
      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockRealGeminiSdk,
      });

      await expect(
        provider.generateResponse([
          { role: 'assistant', content: 'Only assistant reply without any user context' },
        ])
      ).rejects.toThrow('final turn must be a user turn');

      // Proof 3: With the fix in place:
      // History has: user -> model
      // New incoming user message is provided: 'Second user message'
      // Final Gemini contents is validated and constructed as: user -> model -> user
      let capturedContents: any[] = [];
      mockRealGeminiSdk.mockImplementation(async (params) => {
        capturedContents = params.contents;
        const last = params.contents[params.contents.length - 1];
        if (last.role === 'model') {
          const err: any = new Error(
            'HTTP 400 INVALID_ARGUMENT: Requests ending with a model turn are not supported.'
          );
          err.status = 400;
          throw err;
        }
        return { text: `Success: handled response for "${last.parts[0].text}"` };
      });

      const response = await provider.generateResponse(
        [
          { role: 'user', content: 'First user message' },
          { role: 'assistant', content: 'First assistant reply' },
        ],
        { currentUserText: 'Second user message' }
      );

      // Verify the 400 error is completely avoided and contents is user -> model -> user
      expect(response.text).toBe('Success: handled response for "Second user message"');
      expect(capturedContents).toHaveLength(3);
      expect(capturedContents[0]).toEqual({ role: 'user', parts: [{ text: 'First user message' }] });
      expect(capturedContents[1]).toEqual({ role: 'model', parts: [{ text: 'First assistant reply' }] });
      expect(capturedContents[2]).toEqual({ role: 'user', parts: [{ text: 'Second user message' }] });
    });
  });

  // =========================================================================
  // 13. Gemini SDK Deadline & Fallback Latency Suite (Minimum 10s Deadline)
  // =========================================================================
  describe('Gemini SDK Deadline & Fallback Latency Suite (Minimum 10s Deadline)', () => {
    it('A: SDK deadline is never below 10s even when options specify a shorter timeout', async () => {
      let capturedHttpOptions: any = null;
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        capturedHttpOptions = params.config?.httpOptions;
        return { text: 'ok' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        generateContentFn: mockGenerate,
      });

      await provider.generateResponse([{ role: 'user', content: 'test' }], {
        requestTimeoutMs: 1000, // 1s requested in options
      });

      expect(capturedHttpOptions).toBeDefined();
      expect(capturedHttpOptions.timeout).toBeGreaterThanOrEqual(10_000);
    });

    it('B: primary timeout -> retry (primary attempt 1 times out, attempts fast retry)', async () => {
      let primaryAttempts = 0;
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        if (params.model === 'gemini-3.7-flash') {
          primaryAttempts++;
          if (primaryAttempts === 1) {
            // Timeout on attempt 1
            return new Promise((resolve) => setTimeout(() => resolve({ text: 'late' }), 2000));
          }
          return { text: 'Primary succeeded on retry!' };
        }
        return { text: 'Fallback' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.7-flash',
        fallbackModel: 'gemini-3.8-flash',
        primaryMaxRetries: 1,
        requestTimeoutMs: 50,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      const res = await provider.generateResponse([{ role: 'user', content: 'test' }]);
      expect(res.text).toBe('Primary succeeded on retry!');
      expect(primaryAttempts).toBe(2);
    });

    it('C: second primary timeout -> switches immediately to fallback model', async () => {
      let primaryAttempts = 0;
      let fallbackAttempts = 0;
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        if (params.model === 'gemini-3.7-flash') {
          primaryAttempts++;
          return new Promise((resolve) => setTimeout(() => resolve({ text: 'late' }), 2000));
        }
        if (params.model === 'gemini-3.8-flash') {
          fallbackAttempts++;
          return { text: 'Fallback succeeded!' };
        }
        return { text: 'Other' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.7-flash',
        fallbackModel: 'gemini-3.8-flash',
        primaryMaxRetries: 1,
        requestTimeoutMs: 50,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      const res = await provider.generateResponse([{ role: 'user', content: 'test' }]);
      expect(res.text).toBe('Fallback succeeded!');
      expect(primaryAttempts).toBe(2);
      expect(fallbackAttempts).toBe(1);
    });

    it('D: fallback uses valid >=10s SDK deadline', async () => {
      let fallbackHttpOptions: any = null;
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        if (params.model === 'gemini-3.7-flash') {
          return new Promise((resolve) => setTimeout(() => resolve({ text: 'late' }), 2000));
        }
        fallbackHttpOptions = params.config?.httpOptions;
        return { text: 'Fallback OK' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.7-flash',
        fallbackModel: 'gemini-3.8-flash',
        primaryMaxRetries: 0,
        requestTimeoutMs: 50,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      await provider.generateResponse([{ role: 'user', content: 'test' }]);
      expect(fallbackHttpOptions).toBeDefined();
      expect(fallbackHttpOptions.timeout).toBeGreaterThanOrEqual(10_000);
    });

    it('E: fallback can successfully return a response after primary failures', async () => {
      const mockGenerate = vi.fn().mockImplementation(async (params) => {
        if (params.model === 'gemini-3.7-flash') {
          const err: any = new Error('503 UNAVAILABLE');
          err.status = 503;
          throw err;
        }
        return { text: 'Fallback model answered properly' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.7-flash',
        fallbackModel: 'gemini-3.8-flash',
        primaryMaxRetries: 1,
        generateContentFn: mockGenerate,
        sleepFn: async () => {},
      });

      const res = await provider.generateResponse([{ role: 'user', content: 'hello' }]);
      expect(res.text).toBe('Fallback model answered properly');
    });

    it('F: exact previous 400 "Manually set deadline 5s is too short" is prevented', async () => {
      // Recreate the exact Google GenAI backend check:
      // Any request with httpOptions.timeout < 10000 throws:
      // HTTP 400 INVALID_ARGUMENT: Manually set deadline 5s is too short. Minimum allowed deadline is 10s.
      const mockRealGeminiSdk = vi.fn().mockImplementation(async (params) => {
        const timeout = params.config?.httpOptions?.timeout;
        if (typeof timeout === 'number' && timeout < 10_000) {
          const err: any = new Error(
            `HTTP 400 INVALID_ARGUMENT: Manually set deadline ${Math.round(timeout / 1000)}s is too short. Minimum allowed deadline is 10s.`
          );
          err.status = 400;
          throw err;
        }

        if (params.model === 'gemini-3.7-flash') {
          // Hangs and times out
          return new Promise((resolve) => setTimeout(() => resolve({ text: 'late' }), 2000));
        }

        return { text: 'Fallback succeeded without 400 error!' };
      });

      const provider = new GeminiProvider({
        apiKey: dummyApiKey,
        defaultModel: 'gemini-3.7-flash',
        fallbackModel: 'gemini-3.8-flash',
        primaryMaxRetries: 1, // 2 primary attempts
        requestTimeoutMs: 50,
        generateContentFn: mockRealGeminiSdk,
        sleepFn: async () => {},
      });

      // When primary times out twice and switches to fallback, fallback MUST NOT fail with 400:
      const res = await provider.generateResponse([{ role: 'user', content: 'test message' }]);
      expect(res.text).toBe('Fallback succeeded without 400 error!');
    });
  });
});


