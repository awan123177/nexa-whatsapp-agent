import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { PlaywrightBrowserService } from '../packages/browser/src/index.js';
import { WhatsAppCloudApiClient, WhatsAppGateway } from '../packages/whatsapp/src/index.js';
import { createBrowserTools } from '../packages/tools/src/tools/browser-tools.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';
import { ToolExecutionError, SecurityViolationError, NexaError } from '../packages/shared/src/index.js';

describe('Screenshot, Media Upload & WhatsApp Delivery Suite', () => {
  let browserService: PlaywrightBrowserService;

  beforeAll(async () => {
    browserService = new PlaywrightBrowserService();
  });

  afterAll(async () => {
    if (browserService) {
      await browserService.close();
    }
  });

  // =========================================================================
  // 1. PlaywrightBrowserService Screenshot Capture
  // =========================================================================
  describe('PlaywrightBrowserService - Screenshot Capabilities', () => {
    it('should throw ToolExecutionError if takeScreenshot is called without an open page', async () => {
      const freshService = new PlaywrightBrowserService();
      await expect(freshService.takeScreenshot()).rejects.toThrow(ToolExecutionError);
      await expect(freshService.takeScreenshot()).rejects.toThrow(/No page currently open/);
      await freshService.close();
    });

    it('should throw ToolExecutionError if the browser page is closed', async () => {
      const service = new PlaywrightBrowserService();
      const page = await service.ensurePage();
      // Simulate navigation
      await page.setContent('<html><body><h1>Active Page</h1></body></html>');
      (service as any).activeUrl = 'https://example.com/test';

      await page.close();

      await expect(service.takeScreenshot()).rejects.toThrow(ToolExecutionError);
      await expect(service.takeScreenshot()).rejects.toThrow(/closed or not available/);
      await service.close();
    });

    it('should capture a viewport screenshot by default', async () => {
      const page = await browserService.ensurePage();
      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body style="margin: 0; background: #f0f0f0;">
            <div id="header" style="height: 100px; background: blue; color: white;">Header Content</div>
            <div style="height: 2000px; background: linear-gradient(red, yellow);">Long Content</div>
          </body>
        </html>
      `);
      (browserService as any).activeUrl = 'https://example.com/viewport-test';

      const result = await browserService.takeScreenshot();

      expect(result).toBeDefined();
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.buffer.length).toBeGreaterThan(100);
      expect(result.mimeType).toBe('image/png');
      expect(typeof result.base64).toBe('string');
      expect(result.base64.length).toBeGreaterThan(100);
    });

    it('should capture a full-page screenshot when fullPage is true', async () => {
      const page = await browserService.ensurePage();
      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body style="margin: 0;">
            <div style="height: 1500px; background: #e0e0e0;">
              <h1>Full Page Content Top</h1>
            </div>
            <div style="height: 1500px; background: #c0c0c0;">
              <h2>Full Page Content Bottom</h2>
            </div>
          </body>
        </html>
      `);
      (browserService as any).activeUrl = 'https://example.com/fullpage-test';

      const viewportShot = await browserService.takeScreenshot({ fullPage: false });
      const fullPageShot = await browserService.takeScreenshot({ fullPage: true });

      expect(fullPageShot.buffer.length).toBeGreaterThan(0);
      expect(fullPageShot.mimeType).toBe('image/png');
      // Full page screenshot of a 3000px page should be substantially larger than 800px viewport
      expect(fullPageShot.buffer.length).toBeGreaterThan(viewportShot.buffer.length);
    });

    it('should capture a specific element screenshot when selector is provided', async () => {
      const page = await browserService.ensurePage();
      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body>
            <div id="target-card" style="width: 200px; height: 100px; background: #22c55e; color: white; padding: 10px;">
              Target Element
            </div>
            <div style="height: 1000px;">Other content</div>
          </body>
        </html>
      `);
      (browserService as any).activeUrl = 'https://example.com/element-test';

      const elementShot = await browserService.takeScreenshot({ selector: '#target-card' });

      expect(elementShot).toBeDefined();
      expect(elementShot.buffer.length).toBeGreaterThan(0);
      expect(elementShot.mimeType).toBe('image/png');

      // Element screenshot should be much smaller in bytes than full viewport
      const viewportShot = await browserService.takeScreenshot();
      expect(elementShot.buffer.length).toBeLessThan(viewportShot.buffer.length);
    });

    it('should throw ToolExecutionError if requested element selector is not found', async () => {
      const page = await browserService.ensurePage();
      await page.setContent('<html><body><h1>Page Without Target</h1></body></html>');
      (browserService as any).activeUrl = 'https://example.com/missing-selector-test';

      await expect(
        browserService.takeScreenshot({ selector: '#non-existent-element-999' })
      ).rejects.toThrow(ToolExecutionError);
      await expect(
        browserService.takeScreenshot({ selector: '#non-existent-element-999' })
      ).rejects.toThrow(/not found on page/);
    });

    it('should reject taking screenshots of internal/SSRF addresses', async () => {
      const page = await browserService.ensurePage();
      await page.setContent('<html><body><h1>Internal Mock</h1></body></html>');

      // Attempt screenshot on localhost
      (browserService as any).activeUrl = 'http://localhost:8080/admin';
      await expect(browserService.takeScreenshot()).rejects.toThrow(SecurityViolationError);

      // Attempt screenshot on 127.0.0.1
      (browserService as any).activeUrl = 'http://127.0.0.1:3000/keys';
      await expect(browserService.takeScreenshot()).rejects.toThrow(SecurityViolationError);

      // Attempt screenshot on 169.254.169.254 cloud metadata
      (browserService as any).activeUrl = 'http://169.254.169.254/latest/meta-data';
      await expect(browserService.takeScreenshot()).rejects.toThrow(SecurityViolationError);

      // Attempt screenshot on private class B address
      (browserService as any).activeUrl = 'http://172.20.0.1:8080';
      await expect(browserService.takeScreenshot()).rejects.toThrow(SecurityViolationError);
    });

    it('should block screenshot if CAPTCHA or bot detection challenge is present', async () => {
      const page = await browserService.ensurePage();
      await page.setContent(`
        <html>
          <body>
            <h1>Attention Required! | Cloudflare</h1>
            <div class="cf-browser-verification">Verifying your browser...</div>
          </body>
        </html>
      `);
      (browserService as any).activeUrl = 'https://protected-site.com/challenge';

      await expect(browserService.takeScreenshot()).rejects.toThrow(ToolExecutionError);
      await expect(browserService.takeScreenshot()).rejects.toThrow(/Cloudflare Challenge/);
    });
  });

  // =========================================================================
  // 2. WhatsApp Media Upload & Send Image Message Service
  // =========================================================================
  describe('WhatsApp Media Upload & Send Image Service', () => {
    it('should simulate media upload when client is unconfigured', async () => {
      const client = new WhatsAppCloudApiClient();
      expect(client.isConfigured()).toBe(false);

      const buffer = Buffer.from('fake-image-bytes-png');
      const result = await client.uploadMedia(buffer, 'image/png', 'screenshot.png');

      expect(result).toBeDefined();
      expect(result.mediaId).toMatch(/^sim_media_/);
    });

    it('should simulate image sending when client is unconfigured', async () => {
      const client = new WhatsAppCloudApiClient();
      const result = await client.sendImageMessage('+15551234567', 'sim_media_123', "📸 Here's the screenshot.");

      expect(result).toBeDefined();
      expect(result.messaging_product).toBe('whatsapp');
      expect(result.messages[0].id).toMatch(/^sim_img_/);
    });

    it('should perform real HTTP POST for media upload when configured', async () => {
      const originalFetch = globalThis.fetch;
      let capturedUrl = '';
      let capturedHeaders: Record<string, string> = {};
      let capturedBody: any;

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
        capturedUrl = url;
        capturedHeaders = init.headers;
        capturedBody = init.body;
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'meta_media_id_789456' }),
        } as any;
      });

      try {
        const client = new WhatsAppCloudApiClient({
          accessToken: 'test_token_abc',
          phoneNumberId: 'phone_id_12345',
        });
        expect(client.isConfigured()).toBe(true);

        const buffer = Buffer.from('real-binary-data');
        const uploadRes = await client.uploadMedia(buffer, 'image/png', 'test-shot.png');

        expect(uploadRes.mediaId).toBe('meta_media_id_789456');
        expect(capturedUrl).toBe('https://graph.facebook.com/v21.0/phone_id_12345/media');
        expect(capturedHeaders.Authorization).toBe('Bearer test_token_abc');
        expect(capturedBody).toBeInstanceOf(FormData);
        expect(capturedBody.get('messaging_product')).toBe('whatsapp');
        expect(capturedBody.get('type')).toBe('image/png');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should throw NexaError on media upload API error', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'Invalid media format' } }),
      } as any);

      try {
        const client = new WhatsAppCloudApiClient({
          accessToken: 'test_token_abc',
          phoneNumberId: 'phone_id_12345',
        });

        const buffer = Buffer.from('bad-data');
        await expect(client.uploadMedia(buffer, 'image/png', 'shot.png')).rejects.toThrow(NexaError);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should perform real HTTP POST for image message sending with caption', async () => {
      const originalFetch = globalThis.fetch;
      let capturedPayload: any;

      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
        capturedPayload = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ messages: [{ id: 'wamid.image_sent_001' }] }),
        } as any;
      });

      try {
        const client = new WhatsAppCloudApiClient({
          accessToken: 'test_token_abc',
          phoneNumberId: 'phone_id_12345',
        });

        const sendRes = await client.sendImageMessage(
          '+15559876543',
          'meta_media_id_789456',
          "📸 Here's the screenshot."
        );

        expect(sendRes.messages[0].id).toBe('wamid.image_sent_001');
        expect(capturedPayload.messaging_product).toBe('whatsapp');
        expect(capturedPayload.to).toBe('+15559876543');
        expect(capturedPayload.type).toBe('image');
        expect(capturedPayload.image.id).toBe('meta_media_id_789456');
        expect(capturedPayload.image.caption).toBe("📸 Here's the screenshot.");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should support URL link image sending when mediaIdOrUrl is an HTTP URL', async () => {
      const originalFetch = globalThis.fetch;
      let capturedPayload: any;

      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
        capturedPayload = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ messages: [{ id: 'wamid.link_image_002' }] }),
        } as any;
      });

      try {
        const client = new WhatsAppCloudApiClient({
          accessToken: 'test_token_abc',
          phoneNumberId: 'phone_id_12345',
        });

        await client.sendImageMessage(
          '+15559876543',
          'https://example.com/cdn/screenshot.png',
          'Preview caption'
        );

        expect(capturedPayload.image.link).toBe('https://example.com/cdn/screenshot.png');
        expect(capturedPayload.image.id).toBeUndefined();
        expect(capturedPayload.image.caption).toBe('Preview caption');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should delegate uploadMedia and sendImageMessage via WhatsAppGateway', async () => {
      const gateway = new WhatsAppGateway({
        verifyToken: 'token_123',
        appSecret: 'secret_456',
      });

      const buffer = Buffer.from('mock-bytes');
      const upload = await gateway.uploadMedia(buffer, 'image/png', 'gateway-test.png');
      expect(upload.mediaId).toMatch(/^sim_media_/);

      const sent = await gateway.sendImageMessage('+15550001111', upload.mediaId, 'Gateway Caption');
      expect(sent.messages[0].id).toMatch(/^sim_img_/);

      const aliasSent = await gateway.sendImage('+15550001111', upload.mediaId, 'Alias Caption');
      expect(aliasSent.messages[0].id).toMatch(/^sim_img_/);
    });
  });

  // =========================================================================
  // 3. browser_screenshot Tool Lifecycle, Temp Storage & Security
  // =========================================================================
  describe('browser_screenshot Tool Lifecycle & Privacy Protections', () => {
    it('should securely create temporary file, upload to WhatsApp, send image, and clean up temp file', async () => {
      const page = await browserService.ensurePage();
      await page.setContent('<html><body><h1>Delivery Test Page</h1></body></html>');
      (browserService as any).activeUrl = 'https://example.com/delivery';

      const uploadedFiles: { buffer: Buffer; mimeType: string; filename: string }[] = [];
      const sentImages: { to: string; mediaId: string; caption?: string }[] = [];
      let tempFileObservedDuringUpload = false;

      const mockWhatsappClient = {
        uploadMedia: async (buffer: Buffer, mimeType: string, filename: string) => {
          uploadedFiles.push({ buffer, mimeType, filename });
          // Check that the temp file exists on disk while upload is taking place
          const tmpFiles = await fs.readdir(os.tmpdir());
          const matching = tmpFiles.filter((f) => f.startsWith('nexa-screenshot-'));
          if (matching.length > 0) {
            tempFileObservedDuringUpload = true;
          }
          return { mediaId: 'media_uploaded_mock_123' };
        },
        sendImageMessage: async (to: string, mediaId: string, caption?: string) => {
          sentImages.push({ to, mediaId, caption });
          return { success: true };
        },
      };

      const tools = createBrowserTools(browserService);
      const screenshotTool = tools.find((t) => t.name === 'browser_screenshot')!;
      expect(screenshotTool).toBeDefined();

      const context = {
        user: {
          id: 'user-1',
          phone_number: '+15551112222',
          role: 'user' as const,
          status: 'active' as const,
          preferences: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        conversation: {
          id: 'conv-1',
          user_id: 'user-1',
          channel: 'whatsapp' as const,
          status: 'active' as const,
          metadata: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        sourceChannel: 'whatsapp' as const,
        whatsappClient: mockWhatsappClient,
        recipientPhone: '+15551112222',
      };

      const result = await screenshotTool.execute(
        { caption: "📸 Here's the screenshot." },
        context
      );

      // Verify tool output
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect((result.data as any).deliveredToWhatsApp).toBe(true);
      expect((result.data as any).mediaId).toBe('media_uploaded_mock_123');
      expect((result.data as any).caption).toBe("📸 Here's the screenshot.");

      // Verify upload and send were called
      expect(uploadedFiles).toHaveLength(1);
      expect(uploadedFiles[0].mimeType).toBe('image/png');
      expect(uploadedFiles[0].buffer.length).toBeGreaterThan(0);

      expect(sentImages).toHaveLength(1);
      expect(sentImages[0].to).toBe('+15551112222');
      expect(sentImages[0].mediaId).toBe('media_uploaded_mock_123');
      expect(sentImages[0].caption).toBe("📸 Here's the screenshot.");

      // Verify temporary file was indeed created and accessible
      expect(tempFileObservedDuringUpload).toBe(true);

      // Verify temporary file is cleaned up after execution completes
      const tmpFilesAfter = await fs.readdir(os.tmpdir());
      const remainingShots = tmpFilesAfter.filter((f) => f.startsWith('nexa-screenshot-'));
      expect(remainingShots).toHaveLength(0);

      // Verify NO local filesystem path is exposed to user
      const resultString = JSON.stringify(result);
      expect(resultString).not.toContain(os.tmpdir());
      expect(resultString).not.toContain('nexa-screenshot-');
      expect(result.userFacingMessage).not.toContain(os.tmpdir());
    });

    it('should delete temporary file even if WhatsApp upload throws an error', async () => {
      const page = await browserService.ensurePage();
      await page.setContent('<html><body><h1>Upload Failure Test Page</h1></body></html>');
      (browserService as any).activeUrl = 'https://example.com/upload-fail';

      const failingWhatsappClient = {
        uploadMedia: async () => {
          throw new Error('Meta CDN network timeout error');
        },
        sendImageMessage: async () => {},
      };

      const tools = createBrowserTools(browserService);
      const screenshotTool = tools.find((t) => t.name === 'browser_screenshot')!;

      const context = {
        user: {
          id: 'user-2',
          phone_number: '+15552223333',
          role: 'user' as const,
          status: 'active' as const,
          preferences: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        conversation: {
          id: 'conv-2',
          user_id: 'user-2',
          channel: 'whatsapp' as const,
          status: 'active' as const,
          metadata: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        sourceChannel: 'whatsapp' as const,
        whatsappClient: failingWhatsappClient,
        recipientPhone: '+15552223333',
      };

      await expect(
        screenshotTool.execute({ caption: 'Test' }, context)
      ).rejects.toThrow(ToolExecutionError);

      // Verify temporary file was deleted despite the failure
      const tmpFilesAfter = await fs.readdir(os.tmpdir());
      const remainingShots = tmpFilesAfter.filter((f) => f.startsWith('nexa-screenshot-'));
      expect(remainingShots).toHaveLength(0);
    });

    it('should retain temporary file if savePermanently: true is explicitly requested', async () => {
      const page = await browserService.ensurePage();
      await page.setContent('<html><body><h1>Retain Test Page</h1></body></html>');
      (browserService as any).activeUrl = 'https://example.com/retain-test';

      const tools = createBrowserTools(browserService);
      const screenshotTool = tools.find((t) => t.name === 'browser_screenshot')!;

      const context = {
        user: {
          id: 'user-3',
          phone_number: '+15553334444',
          role: 'user' as const,
          status: 'active' as const,
          preferences: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        conversation: {
          id: 'conv-3',
          user_id: 'user-3',
          channel: 'whatsapp' as const,
          status: 'active' as const,
          metadata: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        sourceChannel: 'whatsapp' as const,
      };

      const result = await screenshotTool.execute(
        { savePermanently: true },
        context
      );

      expect(result.success).toBe(true);

      // File was saved and retained
      const tmpFiles = await fs.readdir(os.tmpdir());
      const savedShots = tmpFiles.filter((f) => f.startsWith('nexa-screenshot-'));
      expect(savedShots.length).toBeGreaterThan(0);

      // Even when saved, NO filesystem path is exposed to the user
      expect(JSON.stringify(result)).not.toContain(os.tmpdir());
      expect(JSON.stringify(result)).not.toContain('nexa-screenshot-');

      // Teardown: clean up retained file
      for (const f of savedShots) {
        await fs.unlink(path.join(os.tmpdir(), f)).catch(() => {});
      }
    });

    it('should never expose filesystem paths in error messages', async () => {
      const page = await browserService.ensurePage();
      await page.setContent('<html><body><h1>Path Redaction Test</h1></body></html>');
      (browserService as any).activeUrl = 'https://example.com/path-test';

      const pathLeakingClient = {
        uploadMedia: async () => {
          throw new Error(`Failed to read ${path.join(os.tmpdir(), 'nexa-screenshot-secret123.png')}: access denied`);
        },
        sendImageMessage: async () => {},
      };

      const tools = createBrowserTools(browserService);
      const screenshotTool = tools.find((t) => t.name === 'browser_screenshot')!;

      const context = {
        user: {
          id: 'user-4',
          phone_number: '+15554445555',
          role: 'user' as const,
          status: 'active' as const,
          preferences: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        conversation: {
          id: 'conv-4',
          user_id: 'user-4',
          channel: 'whatsapp' as const,
          status: 'active' as const,
          metadata: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        sourceChannel: 'whatsapp' as const,
        whatsappClient: pathLeakingClient,
      };

      try {
        await screenshotTool.execute({}, context);
        expect.fail('Should have thrown error');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ToolExecutionError);
        expect(err.message).not.toContain(os.tmpdir());
        expect(err.message).toContain('[SECURE_TEMP_PATH]');
      }
    });
  });

  // =========================================================================
  // 4. End-to-End Agent Orchestrator with browser_screenshot
  // =========================================================================
  describe('Agent Orchestrator Screenshot Loop', () => {
    it('should orchestrate user screenshot request, capture, upload to WhatsApp, send image, and reply with confirmation', async () => {
      const db = new InMemoryRepository();
      const page = await browserService.ensurePage();
      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body>
            <h1>NEXA Flight Deals</h1>
            <p>Dubai to London from $450</p>
          </body>
        </html>
      `);
      (browserService as any).activeUrl = 'https://deals.example.com/flights';

      const sentWhatsAppImages: any[] = [];
      const mockWhatsAppGateway = {
        uploadMedia: async (_buf: Buffer, _mime: string, _filename: string) => {
          return { mediaId: 'media_wamid_998877' };
        },
        sendImageMessage: async (to: string, mediaId: string, caption?: string) => {
          sentWhatsAppImages.push({ to, mediaId, caption });
          return { success: true };
        },
      };

      const toolRegistry = createDefaultToolRegistry({
        db,
        browserService,
        whatsappClient: mockWhatsAppGateway,
      });

      let step = 0;
      const mockAi = new MockAIProvider(async (_messages) => {
        step++;
        if (step === 1) {
          // AI calls browser_screenshot tool
          return {
            text: '',
            toolCalls: [
              {
                id: 'call_shot_1',
                name: 'browser_screenshot',
                arguments: {
                  caption: "📸 Here's the screenshot.",
                },
              },
            ],
          };
        }

        // Step 2: AI returns short confirmation reply
        return {
          text: "📸 Here's the screenshot of the page you requested!",
        };
      });

      const orchestrator = new AgentOrchestrator(
        mockAi,
        toolRegistry,
        db,
        10,
        mockWhatsAppGateway
      );

      const result = await orchestrator.processMessage({
        phoneNumber: '+15557778888',
        name: 'David',
        text: 'Take a screenshot of the current page and send it to me.',
        channel: 'whatsapp',
      });

      // Verify agent output
      expect(result.replyText).toContain("📸 Here's the screenshot");
      expect(result.stepsCount).toBe(2);

      // Verify WhatsApp image was delivered
      expect(sentWhatsAppImages).toHaveLength(1);
      expect(sentWhatsAppImages[0].to).toBe('+15557778888');
      expect(sentWhatsAppImages[0].mediaId).toBe('media_wamid_998877');
      expect(sentWhatsAppImages[0].caption).toBe("📸 Here's the screenshot.");

      // Verify no temporary files remain
      const remaining = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('nexa-screenshot-'));
      expect(remaining).toHaveLength(0);
    });
  });
});
