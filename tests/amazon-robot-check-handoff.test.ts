import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  AgentOrchestrator,
  TaskStateMachine,
  ShoppingStateMachine,
} from '@nexa/agent';
import {
  detectCaptchaOrBotBlock,
  PlaywrightBrowserService,
} from '@nexa/browser';
import {
  generateHandoffMessage,
  isRemoteInteractiveSessionSupported,
  UserAssistedHandoffManager,
  ToolRegistry,
} from '@nexa/tools';
import { InMemoryRepository } from '@nexa/database';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';

describe('NEXA Amazon Robot Check Human-Handoff & Safety Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.REMOTE_BROWSER_INTERACTIVE_URL;
  });

  describe('1. Amazon Robot Check & CAPTCHA Challenge Detection', () => {
    it('detects Amazon Robot Check via HTML content and sets challenge type', () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Robot Check</title></head>
          <body>
            <h4>Enter the characters you see below</h4>
            <p>Sorry, we just need to make sure you're not a robot. For best results, please make sure your browser is accepting cookies.</p>
            <img src="https://images-na.ssl-images-amazon.com/captcha/usbfg.jpg">
          </body>
        </html>
      `;
      const result = detectCaptchaOrBotBlock(html);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('Amazon Robot Check');
      expect(result.message).toContain('Amazon robot check');
    });

    it('detects Amazon India validatecaptcha error URL challenge', () => {
      const html = `<html><body><form action="/errors/validatecaptcha" method="get">Please enter characters</form></body></html>`;
      const result = detectCaptchaOrBotBlock(html);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('Amazon Robot Check');
    });

    it('treats BLOCKED state as terminal-for-automation in TaskStateMachine', () => {
      const sm = new TaskStateMachine('CREATED');
      sm.transitionTo('EXECUTING');
      expect(sm.isTerminal()).toBe(false);

      sm.transitionTo('BLOCKED');
      expect(sm.getState()).toBe('BLOCKED');
      expect(sm.isTerminal()).toBe(true);
      expect(sm.isBlocked()).toBe(true);
    });
  });

  describe('2. Immediate Suppression of Automated Retries on Robot Check', () => {
    it('terminates automation immediately upon Robot Check and prevents subsequent Gemini turns', async () => {
      const db = new InMemoryRepository();
      const registry = new ToolRegistry();

      let browserOpenCalls = 0;
      registry.register({
        name: 'browser_open',
        description: 'Open webpage',
        riskLevel: 'read_only',
        parametersSchema: z.object({ url: z.string() }),
        requiresApproval: () => ({ required: false }),
        execute: async () => {
          browserOpenCalls++;
          return {
            success: false,
            errorType: 'BOT_BLOCKED',
            error: 'Automated access restricted by Amazon Robot Check: human verification is required.',
            data: {
              success: false,
              errorType: 'BOT_BLOCKED',
              message: 'Automated access restricted by Amazon Robot Check',
              authState: 'BLOCKED',
              challengeDetected: true,
              challengeType: 'Amazon Robot Check',
              canonicalUrl: 'https://www.amazon.in/dp/B0DHCVXYZ1',
            },
          };
        },
      });

      let geminiTurns = 0;
      const mockAI = new MockAIProvider(async () => {
        geminiTurns++;
        if (geminiTurns === 1) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'call_open',
                name: 'browser_open',
                arguments: { url: 'https://www.amazon.in/dp/B0DHCVXYZ1' },
              },
            ],
          };
        }
        // If Gemini is called for turn 2, that indicates retries were NOT suppressed!
        return {
          text: 'I will retry opening Amazon now.',
          toolCalls: [
            {
              id: 'call_retry',
              name: 'browser_open',
              arguments: { url: 'https://www.amazon.in/dp/B0DHCVXYZ1' },
            },
          ],
        };
      });

      const orchestrator = new AgentOrchestrator(
        mockAI,
        registry,
        db,
        5,
        undefined,
        15000,
        120000,
        5,
        120000
      );

      const res = await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        text: 'Find iPhone 16 Pro Max screen guard on Amazon India and add to cart',
      });

      // Assertions:
      // 1. Exactly 1 Gemini turn was executed (no step 2 or retries)
      expect(geminiTurns).toBe(1);
      // 2. browser_open was called exactly once
      expect(browserOpenCalls).toBe(1);
      // 3. User receives clear verification required message
      expect(res.replyText).toContain('Amazon Robot Check');
      expect(res.replyText).toContain('Human Verification Required');
      // 4. Never falsely claims cart completion or success
      expect(res.replyText).not.toContain('cart verified');
      expect(res.replyText).not.toContain('added to your cart');
    });

    it('cancels subsequent tool calls in the same turn when a tool hits a bot challenge', async () => {
      const db = new InMemoryRepository();
      const registry = new ToolRegistry();

      let clickExecuted = false;
      registry.register({
        name: 'browser_open',
        description: 'Open webpage',
        riskLevel: 'read_only',
        parametersSchema: z.any(),
        requiresApproval: () => ({ required: false }),
        execute: async () => ({
          success: false,
          errorType: 'BOT_BLOCKED',
          error: 'Automated access restricted by Amazon Robot Check',
          data: { errorType: 'BOT_BLOCKED', challengeDetected: true },
        }),
      });

      registry.register({
        name: 'browser_click',
        description: 'Click button',
        riskLevel: 'medium_risk',
        parametersSchema: z.any(),
        requiresApproval: () => ({ required: false }),
        execute: async () => {
          clickExecuted = true;
          return { success: true };
        },
      });

      let rawHistoryDelivered: any = null;
      const mockAI = new MockAIProvider(async (_msgs, opts) => {
        rawHistoryDelivered = opts?.rawHistory;
        return {
          text: '',
          toolCalls: [
            { id: 'call_1', name: 'browser_open', arguments: { url: 'https://www.amazon.in' } },
            { id: 'call_2', name: 'browser_click', arguments: { selector: '#add-to-cart-button' } },
          ],
        };
      });

      const orchestrator = new AgentOrchestrator(
        mockAI,
        registry,
        db,
        5,
        undefined,
        15000,
        120000,
        5,
        120000
      );

      await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        text: 'Open Amazon and add to cart',
      });

      // Browser click must be completely skipped
      expect(clickExecuted).toBe(false);
    });
  });

  describe('3. Correct WhatsApp Handoff Messaging & Limitation Clarity', () => {
    it('generates honest message explaining remote container limitation and phone separation', () => {
      const msg = generateHandoffMessage(
        'Amazon India',
        'https://www.amazon.in/dp/B0DHCVXYZ1',
        'BLOCKED',
        {
          errorType: 'BOT_BLOCKED',
          reason: 'Amazon Robot Check detected',
          challengeType: 'Amazon Robot Check',
        }
      );

      // 1. Clearly identifies merchant and challenge
      expect(msg).toContain('Amazon India');
      expect(msg).toContain('Amazon Robot Check');
      // 2. States session limitation honestly: cloud container cannot be interactively solved
      expect(msg).toContain('Session Limitation');
      expect(msg).toContain('isolated cloud environment');
      expect(msg).toContain('cannot be exposed for interactive human solving');
      // 3. Clarifies that solving on personal device does not clear the separate cloud session
      expect(msg).toContain('Solving the check on your personal device will not clear the separate cloud session');
      // 4. Honest alternative: user can share product link or details for evaluation
      expect(msg).toContain('Manual Check & Share Link');
      expect(msg).toContain('Direct Order');
      // 5. Explicitly states cart continuation is halted
      expect(msg).toContain('Automated cart continuation is currently halted');
      // 6. Security guarantee: never asks for passwords or OTPs
      expect(msg).toContain('never ask for your Amazon password, OTP');
    });

    it('distinguishes when interactive remote session is configured vs cloud container default', () => {
      expect(isRemoteInteractiveSessionSupported()).toBe(false);

      // Simulate remote interactive URL configured
      process.env.REMOTE_BROWSER_INTERACTIVE_URL = 'https://nexa.internal/remote-browser/sess_123';
      expect(isRemoteInteractiveSessionSupported()).toBe(true);

      const msg = generateHandoffMessage(
        'Amazon India',
        'https://www.amazon.in',
        'BLOCKED',
        {
          errorType: 'BOT_BLOCKED',
          challengeType: 'Amazon Robot Check',
        }
      );

      expect(msg).toContain('https://nexa.internal/remote-browser/sess_123');
      expect(msg).toContain('reply *"resume"* and I will verify the page');
    });
  });

  describe('4. Safe Resumption & Page Re-observation Verification', () => {
    it('rejects resumption when challenge persists on cloud page after user replies resume', async () => {
      const db = new InMemoryRepository();
      const registry = new ToolRegistry();
      const handoffManager = new UserAssistedHandoffManager(db);

      const user = await db.findOrCreateUserByPhone('+919876543210');
      const conv = await db.getOrCreateActiveConversation(user.id);
      await db.saveMessage({
        conversation_id: conv.id,
        sender_type: 'user',
        content: 'Find screen guard on Amazon India',
      });

      // Record pending handoff for user
      await handoffManager.initiateHandoff({
        userId: user.id,
        merchant: 'Amazon India',
        canonicalUrl: 'https://www.amazon.in',
        authState: 'BLOCKED',
        errorType: 'BOT_BLOCKED',
      });

      const mockBrowser: any = {
        getActiveUrl: vi.fn().mockReturnValue('https://www.amazon.in/errors/validatecaptcha'),
        inspectPageState: vi.fn().mockResolvedValue({
          url: 'https://www.amazon.in/errors/validatecaptcha',
          challengeDetected: true,
          challengeType: 'Amazon Robot Check',
          authState: 'BLOCKED',
        }),
      };

      const mockAI = new MockAIProvider(async () => ({
        text: 'Should not run because readiness fails.',
        toolCalls: [],
      }));

      const orchestrator = new AgentOrchestrator(
        mockAI,
        registry,
        db,
        5,
        undefined,
        15000,
        120000,
        5,
        120000,
        mockBrowser,
        handoffManager
      );

      const res = await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        text: 'resume',
      });

      // Resume is rejected because session is not authenticated and challenge still persists
      expect(res.replyText).toContain('Amazon');
      expect(res.replyText).toContain('Human Verification Required');
      expect(res.stepsCount).toBe(0);
    });

    it('re-observes page and confirms challenge is gone before resuming when authorized session exists', async () => {
      const db = new InMemoryRepository();
      const registry = new ToolRegistry();
      const handoffManager = new UserAssistedHandoffManager(db);

      const user = await db.findOrCreateUserByPhone('+919876543210');
      const conv = await db.getOrCreateActiveConversation(user.id);
      await db.saveMessage({
        conversation_id: conv.id,
        sender_type: 'user',
        content: 'Find screen guard on Amazon India',
      });

      // Save authorized session
      await handoffManager.saveAuthorizedSession(user.id, 'Amazon India', {
        cookies: [{ name: 'session-id', value: '123-456' }],
      });

      // Mock browser that is still challenged initially when inspectPageState is called
      let inspectCalls = 0;
      const mockBrowser: any = {
        getActiveUrl: vi.fn().mockReturnValue('https://www.amazon.in/errors/validatecaptcha'),
        addCookies: vi.fn().mockResolvedValue(true),
        inspectPageState: vi.fn().mockImplementation(async () => {
          inspectCalls++;
          return {
            url: 'https://www.amazon.in/errors/validatecaptcha',
            challengeDetected: true,
            challengeType: 'Amazon Robot Check',
            authState: 'BLOCKED',
          };
        }),
      };

      const mockAI = new MockAIProvider(async () => ({
        text: '',
        toolCalls: [],
      }));

      const orchestrator = new AgentOrchestrator(
        mockAI,
        registry,
        db,
        5,
        undefined,
        15000,
        120000,
        5,
        120000,
        mockBrowser,
        handoffManager
      );

      const res = await orchestrator.processMessage({
        phoneNumber: '+919876543210',
        text: 'resume',
      });

      // Inspect page state was called to verify
      expect(inspectCalls).toBeGreaterThan(0);
      // Because challenge was still detected on inspect, resume was rejected safely
      expect(res.replyText).toContain('verification challenge');
      expect(res.replyText).toContain('still active on the cloud browser');
      expect(res.stepsCount).toBe(0);
    });
  });
});
