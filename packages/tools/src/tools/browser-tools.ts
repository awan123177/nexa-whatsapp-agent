import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { z } from 'zod';
import { BaseTool, ToolExecutionContext, ToolResult, ToolExecutionError, SecurityViolationError, WhatsAppMediaSender } from '@nexa/shared';
import { PlaywrightBrowserService } from '@nexa/browser';

export function createBrowserTools(
  browserService: PlaywrightBrowserService,
  defaultWhatsappClient?: WhatsAppMediaSender
): BaseTool[] {
  const browserOpenTool: BaseTool = {
    name: 'browser_open',
    description: 'Navigates the controlled browser to a public website URL to view live content.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      url: z.string().url().describe('The destination URL (must start with http:// or https://)'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { url: string }, _context: ToolExecutionContext): Promise<ToolResult> => {
      const data = await browserService.openPage(args.url);
      return { success: true, data };
    },
  };

  const browserReadTool: BaseTool = {
    name: 'browser_read',
    description: 'Extracts textual content or an element from the currently opened webpage.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      selector: z.string().optional().describe('Optional CSS selector to read specific element content'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { selector?: string }, _context: ToolExecutionContext): Promise<ToolResult> => {
      const data = await browserService.readPage(args.selector);
      return { success: true, data };
    },
  };

  const browserClickTool: BaseTool = {
    name: 'browser_click',
    description: 'Clicks an interactive element, link, or button on the currently opened webpage.',
    riskLevel: 'medium_risk',
    parametersSchema: z.object({
      selector: z.string().describe('CSS selector of the element to click (e.g. button#submit, a.nav-link)'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { selector: string }, _context: ToolExecutionContext): Promise<ToolResult> => {
      const data = await browserService.clickElement(args.selector);
      return { success: true, data };
    },
  };

  const browserTypeTool: BaseTool = {
    name: 'browser_type',
    description: 'Enters text into an input field or textarea on the active webpage.',
    riskLevel: 'medium_risk',
    parametersSchema: z.object({
      selector: z.string().describe('CSS selector of the input field'),
      text: z.string().describe('The text to enter'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { selector: string; text: string }, _context: ToolExecutionContext): Promise<ToolResult> => {
      const data = await browserService.typeText(args.selector, args.text);
      return { success: true, data };
    },
  };

  const browserScrollTool: BaseTool = {
    name: 'browser_scroll',
    description: 'Scrolls the active webpage viewport up or down.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      direction: z.enum(['up', 'down']).describe('Direction to scroll'),
      amount: z.number().min(100).max(2000).optional().describe('Pixels to scroll (default 500)'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { direction: 'up' | 'down'; amount?: number }, _context: ToolExecutionContext): Promise<ToolResult> => {
      const data = await browserService.scrollPage(args.direction, args.amount);
      return { success: true, data };
    },
  };

  const browserWaitTool: BaseTool = {
    name: 'browser_wait',
    description: 'Waits for a specified amount of time or for an element to appear on the page.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      milliseconds: z.number().min(100).max(15000).optional().describe('Milliseconds to wait'),
      selector: z.string().optional().describe('CSS selector to wait for'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { milliseconds?: number; selector?: string }, _context: ToolExecutionContext): Promise<ToolResult> => {
      const waitTarget = args.selector || args.milliseconds || 1000;
      const data = await browserService.waitFor(waitTarget);
      return { success: true, data };
    },
  };

  const browserScreenshotTool: BaseTool = {
    name: 'browser_screenshot',
    description:
      'Captures a screenshot of the currently open webpage (viewport, full page, or specific element) and sends it directly to the user as an image message on WhatsApp.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      fullPage: z
        .boolean()
        .optional()
        .describe('Whether to capture the entire scrollable webpage instead of just the visible viewport'),
      selector: z
        .string()
        .optional()
        .describe('Optional CSS selector to screenshot a specific element instead of the entire page'),
      caption: z
        .string()
        .optional()
        .describe('Optional caption for the screenshot image message (e.g. "📸 Here\'s the screenshot.")'),
      savePermanently: z
        .boolean()
        .optional()
        .describe('Whether to retain the screenshot permanently (defaults to false; temporary files are deleted after delivery)'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (
      args: { fullPage?: boolean; selector?: string; caption?: string; savePermanently?: boolean },
      context: ToolExecutionContext
    ): Promise<ToolResult> => {
      // 1. Capture screenshot via PlaywrightBrowserService
      const screenshot = await browserService.takeScreenshot({
        fullPage: args.fullPage,
        selector: args.selector,
      });

      // 2. Generate secure temporary file path in os.tmpdir() with cryptographically random name
      const randomId = crypto.randomBytes(16).toString('hex');
      const ext = screenshot.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const tempFilename = `nexa-screenshot-${randomId}.${ext}`;
      const tempFilePath = path.join(os.tmpdir(), tempFilename);

      const caption = args.caption || "📸 Here's the screenshot.";
      let mediaId: string | undefined;
      let deliveredToWhatsApp = false;

      try {
        // 3. Save screenshot buffer securely to temp file (mode 0o600: user read/write only)
        await fs.writeFile(tempFilePath, screenshot.buffer, { mode: 0o600 });

        // 4. Check if WhatsApp delivery is possible
        const whatsappClient = context.whatsappClient || defaultWhatsappClient;
        const recipient = context.recipientPhone || context.user?.phone_number;

        if (whatsappClient && recipient) {
          const fileData = await fs.readFile(tempFilePath);
          const uploadFilename = `screenshot-${Date.now()}.${ext}`;

          // Upload media via Meta WhatsApp Cloud API
          const uploadRes = await whatsappClient.uploadMedia(fileData, screenshot.mimeType, uploadFilename);
          mediaId = uploadRes.mediaId;

          // Send image message with caption
          await whatsappClient.sendImageMessage(recipient, mediaId, caption);
          deliveredToWhatsApp = true;
        }

        // Return clean result WITHOUT exposing any filesystem paths
        return {
          success: true,
          data: {
            mimeType: screenshot.mimeType,
            sizeBytes: screenshot.buffer.length,
            mediaId,
            deliveredToWhatsApp,
            caption,
            preview: `data:${screenshot.mimeType};base64,${screenshot.base64.slice(0, 100)}...`,
          },
          userFacingMessage: caption,
        };
      } catch (err: any) {
        if (err instanceof ToolExecutionError || err instanceof SecurityViolationError) {
          throw err;
        }
        // Sanitize error to prevent leaking local filesystem paths
        const rawMsg = err.message || 'Unknown screenshot error';
        const sanitizedMsg = rawMsg.replace(/([a-zA-Z]:\\[^\s]+|\/[^\s]+)/g, '[SECURE_TEMP_PATH]');
        throw new ToolExecutionError(
          'browser_screenshot',
          `Screenshot delivery failed: ${sanitizedMsg}`,
          'I captured the screenshot, but was unable to deliver it via WhatsApp. Please try again.'
        );
      } finally {
        // 5. Clean up temporary screenshot file after delivery when safe to do so
        if (!args.savePermanently) {
          try {
            await fs.unlink(tempFilePath);
          } catch {
            // Ignore if already deleted
          }
        }
      }
    },
  };

  return [
    browserOpenTool,
    browserReadTool,
    browserClickTool,
    browserTypeTool,
    browserScrollTool,
    browserWaitTool,
    browserScreenshotTool,
  ];
}
