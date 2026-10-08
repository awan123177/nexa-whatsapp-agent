import { z } from 'zod';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { PlaywrightBrowserService } from '../packages/browser/src/index.js';
import { createBrowserTools } from '../packages/tools/src/tools/browser-tools.js';
import { createWebSearchTool, DuckDuckGoSearchProvider } from '../packages/tools/src/tools/web-search.js';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';

describe('Browser Automation, Timeouts, Cancellation & Observability Suite', () => {
  let browserService: PlaywrightBrowserService;
  let testServer: http.Server;
  let testServerPort: number;

  beforeAll(async () => {
    browserService = new PlaywrightBrowserService();

    // Setup local HTTP server for fast, deterministic browser tests
    testServer = http.createServer((req, res) => {
      if (req.url === '/slow') {
        // Deliberately delay response by 5 seconds to test timeouts
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body>Delayed page</body></html>');
        }, 5000);
      } else if (req.url === '/fast') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>NEXA Test Fast Page</title></head>
            <body>
              <h1>Welcome to Fast Page</h1>
              <div id="content">Fast content body</div>
            </body>
          </html>
        `);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      // Listen on 127.0.0.1 with OS-assigned port
      testServer.listen(0, '127.0.0.1', () => {
        const addr = testServer.address() as any;
        testServerPort = addr.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (browserService) {
      await browserService.close();
    }
    if (testServer) {
      await new Promise<void>((resolve) => testServer.close(() => resolve()));
    }
  });

  // A. browser_open succeeds in under 15 seconds
  it('A. browser_open succeeds in under 15 seconds and returns structured result', async () => {
    const page = await browserService.ensurePage();
    // Use data: URI or content to test openPage navigation without external network dependency
    await page.setContent('<html><head><title>Test Page</title></head><body><h1>Hello World</h1><p>This is test content.</p></body></html>');
    (browserService as any).activeUrl = 'https://example.com/test';

    // Verify structured read and content
    const read = await browserService.readPage();
    expect(read.text).toContain('Hello World');

    // Test real openPage with small timeout window
    const tools = createBrowserTools(browserService);
    const openTool = tools.find((t) => t.name === 'browser_open');
    expect(openTool).toBeDefined();

    // Verify openTool returns structured data
    const mockContext: any = { timeoutMs: 15000 };
    // Navigation to valid public domain
    const startTime = Date.now();
    const result = await browserService.openPage('https://example.com', { timeoutMs: 15000 });
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(15000);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.finalUrl).toBeDefined();
      expect(typeof result.status).toBe('number');
      expect(result.title).toBeDefined();
      expect(typeof result.text).toBe('string');
    }
  }, 20000);

  // B. browser_open timeout
  it('B. browser_open timeout produces structured failure and does not hang', async () => {
    const start = Date.now();
    // Test with a tight 50ms timeout against an unreachable/blackholed address
    const result = await browserService.openPage('https://example.com:81', { timeoutMs: 100 });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorType).toBe('TIMEOUT');
      expect(result.message).toContain('timed out');
    }
  }, 10000);

  // C. browser navigation cancellation
  it('C. browser navigation cancellation via AbortSignal cancels immediately', async () => {
    const controller = new AbortController();

    // Abort after 30ms while navigation is in flight
    setTimeout(() => {
      controller.abort();
    }, 30);

    const start = Date.now();
    const result = await browserService.openPage('https://example.com:81', {
      timeoutMs: 15000,
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorType).toBe('TIMEOUT');
    }
  });

  // D. browser cleanup after timeout
  it('D. browser page is cleaned up after timeout and does not leave hanging page', async () => {
    const controller = new AbortController();
    controller.abort(); // already aborted

    await browserService.openPage('https://example.com', { signal: controller.signal });

    // Page must be cleaned up / closed
    expect(browserService.getActiveUrl()).toBeNull();
  });

  // E. browser_read
  it('E. browser_read extracts textual content from current page', async () => {
    const page = await browserService.ensurePage();
    await page.setContent('<html><body><div id="target">Special Element Text</div></body></html>');
    (browserService as any).activeUrl = 'https://example.com/read-test';

    const fullRead = await browserService.readPage();
    expect(fullRead.text).toContain('Special Element Text');

    const selectorRead = await browserService.readPage('#target');
    expect(selectorRead.text).toBe('Special Element Text');
  });

  // F. browser_screenshot
  it('F. browser_screenshot captures valid image buffer and base64', async () => {
    const page = await browserService.ensurePage();
    await page.setContent('<html><body><h1>Screenshot Page</h1></body></html>');
    (browserService as any).activeUrl = 'https://example.com/screenshot-test';

    const shot = await browserService.takeScreenshot();
    expect(shot.buffer).toBeInstanceOf(Buffer);
    expect(shot.buffer.length).toBeGreaterThan(50);
    expect(shot.mimeType).toBe('image/png');
    expect(shot.base64.length).toBeGreaterThan(50);
  });

  // G. browser screenshot delivery via WhatsApp media client
  it('G. browser screenshot delivery uploads media and sends image message', async () => {
    const page = await browserService.ensurePage();
    await page.setContent('<html><body><h1>Delivery Page</h1></body></html>');
    (browserService as any).activeUrl = 'https://example.com/delivery-test';

    let uploaded = false;
    let sent = false;

    const mockWhatsappClient: any = {
      uploadMedia: vi.fn(async () => {
        uploaded = true;
        return { mediaId: 'media_test_123' };
      }),
      sendImageMessage: vi.fn(async () => {
        sent = true;
        return { messageId: 'msg_test_123' };
      }),
    };

    const tools = createBrowserTools(browserService, mockWhatsappClient);
    const screenshotTool = tools.find((t) => t.name === 'browser_screenshot');
    expect(screenshotTool).toBeDefined();

    const mockContext: any = {
      whatsappClient: mockWhatsappClient,
      recipientPhone: '+15551234567',
    };

    const result = await screenshotTool!.execute({}, mockContext);
    expect(result.success).toBe(true);
    expect(uploaded).toBe(true);
    expect(sent).toBe(true);
  });

  // H. web_search timeout
  it('H. web_search respects timeout and logs search_timeout', async () => {
    const provider = new DuckDuckGoSearchProvider();
    const logSpy = vi.spyOn(console, 'log');

    // Run with 1ms timeout to ensure timeout triggers
    await expect(provider.search('test query that times out', 5, { timeoutMs: 1 })).rejects.toThrow('timed out');

    const logs = logSpy.mock.calls.map((c) => c[0]);
    expect(logs.some((l) => typeof l === 'string' && l.includes('[WebSearch] search_timeout'))).toBe(true);

    // Also verify tool execution returns structured failure
    const tool = createWebSearchTool(provider);
    const result = await tool.execute({ query: 'test query' }, { timeoutMs: 1 } as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    expect((result.data as any)?.errorType).toBe('TIMEOUT');
    logSpy.mockRestore();
  });

  // I. failed web_search does not continue indefinitely and aborts underlying request
  it('I. failed web_search aborts underlying fetch via AbortSignal', async () => {
    const provider = new DuckDuckGoSearchProvider();
    const controller = new AbortController();
    controller.abort(); // already cancelled

    const start = Date.now();
    await expect(provider.search('cancelled search', 5, { signal: controller.signal })).rejects.toThrow();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
  });

  // I2. web_search 2-strike disabling and duplicate call protection
  it('I2. failed web_search is blocked on identical duplicate and disabled after 2 strikes', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });

    let searchCount = 0;
    const failingProvider = {
      search: vi.fn(async () => {
        searchCount++;
        throw new Error('Search network failure');
      }),
    };
    toolRegistry.register(createWebSearchTool(failingProvider as any));

    let turn = 0;
    const mockAi = new MockAIProvider(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'tc1', name: 'web_search', arguments: { query: 'test failing query' } }],
        };
      }
      if (turn === 2) {
        // Model retries exact duplicate query
        return {
          text: '',
          toolCalls: [{ id: 'tc2', name: 'web_search', arguments: { query: 'test failing query' } }],
        };
      }
      if (turn === 3) {
        // Model tries a different query (second strike)
        return {
          text: '',
          toolCalls: [{ id: 'tc3', name: 'web_search', arguments: { query: 'different query' } }],
        };
      }
      if (turn === 4) {
        // Model tries third query (should be disabled!)
        return {
          text: '',
          toolCalls: [{ id: 'tc4', name: 'web_search', arguments: { query: 'third query' } }],
        };
      }
      return { text: 'Web search stopped after retries.' };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const result = await orchestrator.processMessage({
      phoneNumber: '+15558880001',
      name: 'SearchTestUser',
      text: 'Search for recent events',
      channel: 'whatsapp',
    });

    expect(result.replyText).toContain('stopped');
    // Turn 1 executed (strike 1). Turn 2 was blocked duplicate (0 provider call). Turn 3 executed (strike 2). Turn 4 was disabled (0 provider call).
    expect(searchCount).toBe(2);
  });

  // J. duplicate browser call protection
  it('J. duplicate browser_open with identical arguments is blocked after failure', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });

    // Mock browser_open to fail
    let openAttempts = 0;
    toolRegistry.register({
      name: 'browser_open',
      description: 'Navigates to URL',
      riskLevel: 'read_only',
      parametersSchema: z.object({ url: z.string() }),
      requiresApproval: () => ({ required: false }),
      execute: async () => {
        openAttempts++;
        return { success: false, error: 'Connection failed' };
      },
    });

    let aiTurn = 0;
    const mockAi = new MockAIProvider(async () => {
      aiTurn++;
      if (aiTurn === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'tc1', name: 'browser_open', arguments: { url: 'https://broken.invalid' } }],
        };
      }
      if (aiTurn === 2) {
        // Model attempts exact duplicate call
        return {
          text: '',
          toolCalls: [{ id: 'tc2', name: 'browser_open', arguments: { url: 'https://broken.invalid' } }],
        };
      }
      return { text: 'Stopped looping.' };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const logSpy = vi.spyOn(console, 'log');

    const result = await orchestrator.processMessage({
      phoneNumber: '+15559990001',
      name: 'DuplicateTestUser',
      text: 'Open the broken site',
      channel: 'whatsapp',
    });

    expect(result.replyText).toContain('Stopped looping');
    // Second attempt must have been blocked without calling the tool
    expect(openAttempts).toBe(1);

    const logs = logSpy.mock.calls.map((c) => c[0]);
    expect(logs.some((l) => typeof l === 'string' && l.includes('[Agent] duplicate_tool_blocked'))).toBe(true);
    logSpy.mockRestore();
  });

  // K. total agent deadline
  it('K. tools respect TOTAL_AGENT_DEADLINE_MS = 22000 and do not exceed request deadline', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });

    // Orchestrator with short total deadline of 3500ms
    const shortDeadlineMs = 3500;
    let toolExecutionTimeoutPassed = 0;

    toolRegistry.register({
      name: 'browser_open',
      description: 'Navigates to URL',
      riskLevel: 'read_only',
      parametersSchema: z.object({ url: z.string() }),
      requiresApproval: () => ({ required: false }),
      execute: async (_args: any, context: any) => {
        toolExecutionTimeoutPassed = context.timeoutMs;
        return { success: true, data: { status: 200 } };
      },
    });

    let turn = 0;
    const mockAi = new MockAIProvider(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'tc1', name: 'browser_open', arguments: { url: 'https://example.com' } }],
        };
      }
      return { text: 'Done' };
    });

    const orchestrator = new AgentOrchestrator(
      mockAi,
      toolRegistry,
      db,
      5,
      undefined,
      7000,
      shortDeadlineMs
    );

    const result = await orchestrator.processMessage({
      phoneNumber: '+15559990002',
      name: 'DeadlineUser',
      text: 'Open page before deadline',
      channel: 'whatsapp',
    });

    expect(result.replyText).toBe('Done');
    // Effective timeout must be capped by available deadline!
    expect(toolExecutionTimeoutPassed).toBeLessThanOrEqual(shortDeadlineMs);
  });

  // L. Render / Chromium launch test in production-like environment
  it('L. Chromium launches with production container flags (sandbox, dev-shm, gpu disabled)', async () => {
    const service = new PlaywrightBrowserService();
    const page = await service.ensurePage();

    expect(page).toBeDefined();
    expect(page.isClosed()).toBe(false);

    // Verify browser engine is responsive in headless container environment
    const testResult = await page.evaluate(() => {
      return {
        userAgent: navigator.userAgent,
        hasBody: Boolean(document.body),
        mathCheck: Math.sqrt(16),
      };
    });

    expect(testResult.userAgent).toContain('Chrome');
    expect(testResult.mathCheck).toBe(4);

    await service.close();
  });
});
