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
  function getActionOptions(context: ToolExecutionContext, overrideSessionId?: string) {
    return {
      signal: context.abortSignal,
      timeoutMs: context.timeoutMs,
      sessionId: overrideSessionId || context.sessionId || context.user?.id || 'default',
      userId: context.user?.id,
      taskId: context.taskId,
      requestId: context.requestId,
      toolCallId: context.toolCallId,
    };
  }

  const browserOpenTool: BaseTool = {
    name: 'browser_open',
    description: 'Navigates the controlled browser to a public website URL to view live content.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      url: z.string().url().describe('The destination URL (must start with http:// or https://)'),
      sessionId: z.string().optional().describe('Optional reusable browser session identifier'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { url: string; sessionId?: string }, context: ToolExecutionContext): Promise<ToolResult> => {
      const result = await browserService.openPage(args.url, getActionOptions(context, args.sessionId));
      if (!result.success) {
        return {
          success: false,
          error: result.message,
          data: result,
          userFacingMessage: `Unable to open page: ${result.message}`,
        };
      }
      return {
        success: true,
        data: result,
      };
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
    execute: async (args: { selector?: string }, context: ToolExecutionContext): Promise<ToolResult> => {
      const data = await browserService.readPage(args.selector, getActionOptions(context));
      return { success: true, data };
    },
  };

  const browserClickTool: BaseTool = {
    name: 'browser_click',
    description: 'Clicks an interactive element, link, or button on the currently opened webpage.',
    riskLevel: 'medium_risk',
    parametersSchema: z.object({
      selector: z.string().describe('CSS selector of the element to click (e.g. button#submit, a.nav-link)'),
      sessionId: z.string().optional().describe('Optional browser session identifier'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { selector: string; sessionId?: string }, context: ToolExecutionContext): Promise<ToolResult> => {
      const data = await browserService.clickElement(
        args.selector,
        args.sessionId || context.user?.id || 'default',
        getActionOptions(context, args.sessionId)
      );
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
      sessionId: z.string().optional().describe('Optional browser session identifier'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { selector: string; text: string; sessionId?: string }, context: ToolExecutionContext): Promise<ToolResult> => {
      const data = await browserService.typeText(
        args.selector,
        args.text,
        args.sessionId || context.user?.id || 'default',
        getActionOptions(context, args.sessionId)
      );
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
    execute: async (args: { direction: 'up' | 'down'; amount?: number }, context: ToolExecutionContext): Promise<ToolResult> => {
      const data = await browserService.scrollPage(args.direction, args.amount, undefined, getActionOptions(context));
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
    execute: async (args: { milliseconds?: number; selector?: string }, context: ToolExecutionContext): Promise<ToolResult> => {
      const waitTarget = args.selector || args.milliseconds || 1000;
      const data = await browserService.waitFor(waitTarget, undefined, getActionOptions(context));
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
        ...getActionOptions(context),
        fullPage: args.fullPage,
        selector: args.selector,
        timeoutMs: context.timeoutMs ?? 10_000,
        signal: context.abortSignal,
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
          console.log('[WhatsApp Media] image_upload_start');
          const uploadRes = await whatsappClient.uploadMedia(fileData, screenshot.mimeType, uploadFilename);
          mediaId = uploadRes.mediaId;
          console.log('[WhatsApp Media] image_upload_success');

          // Send image message with caption
          await whatsappClient.sendImageMessage(recipient, mediaId, caption);
          console.log('[WhatsApp Media] image_send_success');
          deliveredToWhatsApp = true;
        }

        console.log(`[ShoppingWorkflow] screenshot_captured media_id="${mediaId || 'none'}" delivered=${deliveredToWhatsApp}`);

        // Return clean result WITHOUT exposing any filesystem paths
        return {
          success: true,
          data: {
            mimeType: screenshot.mimeType,
            sizeBytes: screenshot.buffer.length,
            mediaId,
            deliveredToWhatsApp,
            caption,
            imageBuffer: screenshot.buffer,
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

  const browserVerifyCartTool: BaseTool = {
    name: 'browser_verify_cart',
    description:
      'Verifies the contents, items, quantities, and total prices currently in the shopping cart within the browser session before checkout.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      expectedItem: z.string().optional().describe('Expected item name to verify presence in cart'),
      sessionId: z.string().optional().describe('Optional browser session identifier'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (
      args: { expectedItem?: string; sessionId?: string },
      context: ToolExecutionContext
    ): Promise<ToolResult> => {
      const sessionId = args.sessionId || context.user?.id || 'default';
      const cart = await browserService.verifyCart(sessionId, args.expectedItem, getActionOptions(context, args.sessionId));
      return {
        success: true,
        data: cart,
        userFacingMessage: cart.items.length > 0
          ? `Cart verified with ${cart.items.length} item(s).`
          : 'Cart is currently empty or pending item addition.',
      };
    },
  };

  const browserRestoreSessionTool: BaseTool = {
    name: 'browser_restore_session',
    description:
      'Restores a browser session after a network timeout, transient failure, or interruption, recovering the page and verifying the cart before continuing.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      sessionId: z.string().optional().describe('Optional browser session identifier to restore'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { sessionId?: string }, context: ToolExecutionContext): Promise<ToolResult> => {
      const sessionId = args.sessionId || context.user?.id || 'default';
      const restored = await browserService.restoreSession(sessionId);
      return {
        success: restored.success,
        data: restored,
        userFacingMessage: restored.success
          ? 'Browser session restored successfully.'
          : 'Unable to restore previous browser session.',
      };
    },
  };

  const browserObserveTool: BaseTool = {
    name: 'browser_observe',
    description:
      'Inspects and observes interactive elements on the currently active webpage DOM (discovering search inputs, action buttons, visible products, and cart summary) without needing hard-coded selectors.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      sessionId: z.string().optional().describe('Optional browser session identifier'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { sessionId?: string }, context: ToolExecutionContext): Promise<ToolResult> => {
      const sessionId = args.sessionId || context.user?.id || 'default';
      const observation = await browserService.observePage(sessionId);
      return {
        success: true,
        data: observation,
        userFacingMessage: `Observed ${observation.title || observation.url}: found ${observation.searchInputs.length} search input(s), ${observation.actionButtons.length} action button(s), and ${observation.products.length} product(s).`,
      };
    },
  };

  return [
    browserOpenTool,
    browserReadTool,
    browserObserveTool,
    browserClickTool,
    browserTypeTool,
    browserScrollTool,
    browserWaitTool,
    browserScreenshotTool,
    browserVerifyCartTool,
    browserRestoreSessionTool,
  ];
}
