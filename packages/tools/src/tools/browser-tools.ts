import { z } from 'zod';
import { BaseTool, ToolExecutionContext, ToolResult } from '@nexa/shared';
import { PlaywrightBrowserService } from '@nexa/browser';

export function createBrowserTools(browserService: PlaywrightBrowserService): BaseTool[] {
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
    description: 'Captures a screenshot of the currently open webpage for verification.',
    riskLevel: 'read_only',
    parametersSchema: z.object({}),
    requiresApproval: () => ({ required: false }),
    execute: async (_args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> => {
      const data = await browserService.takeScreenshot();
      return {
        success: true,
        data: {
          mimeType: data.mimeType,
          sizeBytes: Math.round((data.base64.length * 3) / 4),
          preview: `data:${data.mimeType};base64,${data.base64.slice(0, 100)}...`,
        },
      };
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
