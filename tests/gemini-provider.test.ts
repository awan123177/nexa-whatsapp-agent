import { describe, it, expect, vi } from 'vitest';
import {
  GeminiProvider,
  calculateRetryDelay,
  parseRetryAfter,
  extractRetryAfter,
  isPermanentError,
  isTransientError,
  extractStatusCode,
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
      // Attempt 1 delay must be approximately 1-2 seconds (1000-2000ms)
      expect(sleepDelays[0]).toBeGreaterThanOrEqual(1000);
      expect(sleepDelays[0]).toBeLessThanOrEqual(2000);
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

      // Attempt 1: 1000–2000ms (1-2s)
      expect(sleepDelays[0]).toBeGreaterThanOrEqual(1000);
      expect(sleepDelays[0]).toBeLessThanOrEqual(2000);

      // Attempt 2: 2000–4000ms (2-4s)
      expect(sleepDelays[1]).toBeGreaterThanOrEqual(2000);
      expect(sleepDelays[1]).toBeLessThanOrEqual(4000);
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
      expect(sleepDelays[0]).toBeGreaterThanOrEqual(1000);
      expect(sleepDelays[0]).toBeLessThanOrEqual(2000);
      expect(sleepDelays[1]).toBeGreaterThanOrEqual(2000);
      expect(sleepDelays[1]).toBeLessThanOrEqual(4000);
      expect(sleepDelays[2]).toBeGreaterThanOrEqual(4000);
      expect(sleepDelays[2]).toBeLessThanOrEqual(8000);
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

    it('should invoke fallback model after default 3 retries (4 attempts) on primary model', async () => {
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
      expect(modelsCalled.filter((m) => m === 'gemini-3.8-flash')).toHaveLength(4);
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
      expect(sleepDelays[0]).toBeGreaterThanOrEqual(1000);
      expect(sleepDelays[0]).toBeLessThanOrEqual(2000);
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
      expect(loggedMessages.some((m) => m === '[Gemini] attempt=1 model=gemini-3.8-flash')).toBe(true);
      expect(
        loggedMessages.some(
          (m) => typeof m === 'string' && m.startsWith('[Gemini] transient_error status=503 retry_in_ms=')
        )
      ).toBe(true);
      expect(loggedMessages.some((m) => m === '[Gemini] attempt=2 model=gemini-3.8-flash')).toBe(true);
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
  });

  // =========================================================================
  // 9. Model configuration (gemini-3.8-flash default & configurable)
  // =========================================================================
  describe('Configurable Model & gemini-3.8-flash Default', () => {
    it('should default to gemini-3.8-flash', () => {
      const provider = new GeminiProvider({ apiKey: dummyApiKey });
      expect(provider.getDefaultModel()).toBe('gemini-3.8-flash');
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
});
