import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryRepository } from '../packages/database/src/index.js';
import {
  PlaywrightBrowserService,
} from '../packages/browser/src/index.js';
import {
  UserAssistedHandoffManager,
  isNavigationBlockedOrAuthRequired,
  generateHandoffMessage,
  createShoppingTools,
  createDefaultToolRegistry,
  clearUserCart,
  getUserCart,
} from '../packages/tools/src/index.js';
import { CredentialVault, credentialVault } from '../packages/security/src/index.js';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';
import { ApprovalRequiredError } from '@nexa/shared';

describe('NEXA User-Assisted Browser Handoff & Session Security Suite', () => {
  let db: InMemoryRepository;
  let browserService: PlaywrightBrowserService;
  let handoffManager: UserAssistedHandoffManager;
  let toolRegistry: any;

  beforeEach(() => {
    db = new InMemoryRepository();
    browserService = new PlaywrightBrowserService();
    handoffManager = new UserAssistedHandoffManager(db);
    toolRegistry = createDefaultToolRegistry({ db, browserService });
  });

  afterEach(async () => {
    if (browserService) {
      await browserService.close();
    }
  });

  // ==========================================================================
  // SECTION 1: Block Detection & Handoff Message Formatting
  // ==========================================================================
  describe('1. Block Detection & Friendly Handoff Messages', () => {
    it('detects BOT_BLOCKED, HTTP 429, Cloudflare challenge, and connection reset as blocked', () => {
      expect(isNavigationBlockedOrAuthRequired({
        success: false,
        errorType: 'BOT_BLOCKED',
        message: 'Bot challenge detected',
      })).toBe(true);

      expect(isNavigationBlockedOrAuthRequired({
        success: false,
        errorType: 'NAVIGATION_FAILED',
        status: 429,
        message: 'Too Many Requests',
      })).toBe(true);

      expect(isNavigationBlockedOrAuthRequired({
        success: false,
        errorType: 'NAVIGATION_FAILED',
        message: 'net::ERR_CONNECTION_RESET at https://www.swiggy.com/instamart',
      })).toBe(true);

      expect(isNavigationBlockedOrAuthRequired({
        success: false,
        errorType: 'CAPTCHA_REQUIRED',
        message: 'Cloudflare Turnstile challenge',
      })).toBe(true);

      expect(isNavigationBlockedOrAuthRequired({
        success: true,
        finalUrl: 'https://www.swiggy.com/instamart',
        status: 200,
        title: 'Swiggy Instamart',
        text: 'Groceries',
        authState: 'AUTHENTICATED',
      })).toBe(false);
    });

    it('generates friendly WhatsApp message with direct merchant link and resume instructions', () => {
      const msg = generateHandoffMessage(
        'Swiggy Instamart',
        'https://www.swiggy.com/instamart',
        'BLOCKED',
        { errorType: 'BOT_BLOCKED', status: 429 }
      );

      expect(msg).toContain('Swiggy Instamart');
      expect(msg).toContain('https://www.swiggy.com/instamart');
      expect(msg).toContain('resume');
      expect(msg).toContain('Direct Order');
      expect(msg).toContain('Authorized Session');
    });

    it('generates login-specific handoff message when authState is AUTH_REQUIRED', () => {
      const msg = generateHandoffMessage(
        'Swiggy Instamart',
        'https://www.swiggy.com/instamart',
        'AUTH_REQUIRED'
      );

      expect(msg).toContain('Sign-in required');
      expect(msg).toContain('Swiggy Instamart');
      expect(msg).toContain('https://www.swiggy.com/instamart');
      expect(msg).toContain('resume');
    });
  });

  // ==========================================================================
  // SECTION 2: Handoff State Persistence & Database Tracking
  // ==========================================================================
  describe('2. Handoff Initiation & Merchant Session Database Persistence', () => {
    it('persists blocked session state into merchant_sessions table in database', async () => {
      const user = await db.findOrCreateUserByPhone('+919876500001', 'Test Handoff User');

      const handoff = await handoffManager.initiateHandoff({
        userId: user.id,
        merchant: 'Swiggy Instamart',
        canonicalUrl: 'https://www.swiggy.com/instamart',
        targetUrl: 'https://www.swiggy.com/instamart',
        errorType: 'BOT_BLOCKED',
        status: 429,
        failureReason: 'Rate limit or bot challenge',
      });

      expect(handoff.authState).toBe('BLOCKED');
      expect(handoff.merchant).toBe('Swiggy Instamart');
      expect(handoff.directMerchantUrl).toBe('https://www.swiggy.com/instamart');

      // Verify database record
      const dbSession = await db.getMerchantSession(user.id, 'Swiggy Instamart');
      expect(dbSession).not.toBeNull();
      expect(dbSession?.authState).toBe('BLOCKED');
      expect(dbSession?.sessionState?.errorType).toBe('BOT_BLOCKED');
      expect(dbSession?.sessionState?.status).toBe(429);
      expect(dbSession?.sessionState?.canonicalUrl).toBe('https://www.swiggy.com/instamart');
    });

    it('shopping_search initiates handoff and stops automated retries on navigation block', async () => {
      const user = await db.findOrCreateUserByPhone('+919876500002', 'Blocked User');
      const conv = await db.getOrCreateActiveConversation(user.id);
      const ctx = { user, conversation: conv, messageId: 'msg_block_1', sourceChannel: 'whatsapp' as const };

      // Mock browserService.openPage to simulate Swiggy Instamart connection reset / block
      vi.spyOn(browserService, 'openPage').mockResolvedValue({
        success: false,
        errorType: 'BOT_BLOCKED',
        status: 429,
        message: 'net::ERR_CONNECTION_RESET by edge firewall',
      });

      const shoppingTools = createShoppingTools(undefined, db, browserService, handoffManager);
      const searchTool = shoppingTools.find((t) => t.name === 'shopping_search')!;

      const result = await searchTool.execute(
        { query: 'Diet Coke', merchant: 'Swiggy Instamart' },
        ctx
      );

      // Must report failure honestly with handoff guidance
      expect(result.success).toBe(false);
      expect(result.userFacingMessage).toContain('Swiggy Instamart');
      expect(result.userFacingMessage).toContain('https://www.swiggy.com/instamart');
      expect(result.userFacingMessage).toContain('resume');

      // Must have written BLOCKED to database
      const session = await db.getMerchantSession(user.id, 'Swiggy Instamart');
      expect(session?.authState).toBe('BLOCKED');
    });
  });

  // ==========================================================================
  // SECTION 3: Session Readiness & Resume Gating
  // ==========================================================================
  describe('3. Secure Session Readiness Validation & Resume Gating', () => {
    it('returns ready: false when no authorized session has been connected', async () => {
      const user = await db.findOrCreateUserByPhone('+919876500003', 'Unready User');

      // Initiate handoff (session is BLOCKED)
      await handoffManager.initiateHandoff({
        userId: user.id,
        merchant: 'Swiggy Instamart',
        errorType: 'BOT_BLOCKED',
      });

      const readiness = await handoffManager.checkSessionReadiness(user.id, 'Swiggy Instamart');
      expect(readiness.ready).toBe(false);
      expect(readiness.hasCredentials).toBe(false);
      expect(readiness.authState).toBe('BLOCKED');
      expect(readiness.userFacingMessage).toBeDefined();
    });

    it('orchestrator receiving "resume" with unready session does NOT retry browser and informs user', async () => {
      const user = await db.findOrCreateUserByPhone('+919876500004', 'Resume Blocked User');
      await db.updateUser(user.id, { name_confirmed: true, preferred_name: 'Alex' });
      const conv = await db.getOrCreateActiveConversation(user.id);

      // Seed previous shopping request in history
      await db.saveMessage({
        conversation_id: conv.id,
        sender_type: 'user',
        content: 'Order a Diet Coke from Instamart',
      });

      // User was blocked previously
      await handoffManager.initiateHandoff({
        userId: user.id,
        merchant: 'Swiggy Instamart',
        errorType: 'BOT_BLOCKED',
      });

      const openSpy = vi.spyOn(browserService, 'openPage');

      const mockAi = new MockAIProvider(async () => ({
        text: 'Should not run tool loop',
      }));

      const orchestrator = new AgentOrchestrator(
        mockAi,
        toolRegistry,
        db,
        5,
        undefined,
        7000,
        22000,
        25,
        60000,
        browserService,
        handoffManager
      );

      // User replies "resume"
      const result = await orchestrator.processMessage({
        phoneNumber: '+919876500004',
        name: 'Alex',
        preferredName: 'Alex',
        nameConfirmed: true,
        text: 'resume',
      });

      // Must NOT invoke browser navigation blindly
      expect(openSpy).not.toHaveBeenCalled();

      // Must respond with honest handoff guidance
      expect(result.stepsCount).toBe(0);
      expect(result.replyText).toContain('Swiggy Instamart');
      expect(result.replyText).toContain('https://www.swiggy.com/instamart');
    });

    it('returns ready: true when authorized session with valid encrypted cookies is saved', async () => {
      const user = await db.findOrCreateUserByPhone('+919876500005', 'Authorized User');

      // Save authorized session with cookies
      const cookies = [
        { name: 'session_token', value: 'auth_tok_xyz123', domain: '.swiggy.com' },
        { name: '_swiggy_sid', value: 'sid_998877', domain: '.swiggy.com' },
      ];

      await handoffManager.saveAuthorizedSession(user.id, 'Swiggy Instamart', {
        cookies,
        sessionToken: 'auth_tok_xyz123',
      });

      const readiness = await handoffManager.checkSessionReadiness(user.id, 'Swiggy Instamart');
      expect(readiness.ready).toBe(true);
      expect(readiness.authState).toBe('AUTHENTICATED');
      expect(readiness.hasCredentials).toBe(true);
      expect(readiness.cookiesCount).toBe(2);
      expect(readiness.credentials?.cookies).toHaveLength(2);
    });
  });

  // ==========================================================================
  // SECTION 4: Zero Credential Leakage & Encryption Integrity
  // ==========================================================================
  describe('4. Zero Credential Leakage & Context-Bound Encryption Integrity', () => {
    it('stored token_data in database is encrypted with AES-256-GCM and contains zero plaintext secrets', async () => {
      const user = await db.findOrCreateUserByPhone('+919876500006', 'Secret User');

      const plainPassword = 'SuperSecretSwiggyPassword!';
      const plainCookieValue = 'ultra_secret_cookie_token_999';

      await handoffManager.saveAuthorizedSession(user.id, 'Swiggy Instamart', {
        cookies: [{ name: 'sec_auth', value: plainCookieValue, domain: '.swiggy.com' }],
        sessionToken: plainPassword,
      });

      const connectedAccount = await db.getConnectedAccount(user.id, 'swiggy instamart');
      expect(connectedAccount).not.toBeNull();

      const rawJson = JSON.stringify(connectedAccount?.token_data);
      // Raw database json must NEVER contain plaintext passwords or cookies
      expect(rawJson).not.toContain(plainPassword);
      expect(rawJson).not.toContain(plainCookieValue);
      expect((connectedAccount?.token_data?.sessionToken as string).startsWith('aes256gcm:')).toBe(true);
      expect((connectedAccount?.token_data?.cookies as any[])[0].value.startsWith('aes256gcm:')).toBe(true);
    });

    it('credentials for User A cannot be decrypted by User B (per-user context salt isolation)', async () => {
      const userA = await db.findOrCreateUserByPhone('+919876500007', 'User A');
      const userB = await db.findOrCreateUserByPhone('+919876500008', 'User B');

      await handoffManager.saveAuthorizedSession(userA.id, 'Swiggy Instamart', {
        cookies: [{ name: 'auth', value: 'userA_cookie_secret', domain: '.swiggy.com' }],
      });

      const accountA = await db.getConnectedAccount(userA.id, 'swiggy instamart');
      expect(accountA).not.toBeNull();

      // User B attempts to decrypt User A's token_data
      expect(() => {
        credentialVault.decryptCredentials(userB.id, 'Swiggy Instamart', accountA!.token_data);
      }).toThrow();
    });
  });

  // ==========================================================================
  // SECTION 5: Resumption & Browser Cookie Injection
  // ==========================================================================
  describe('5. Resumption with Authorized Session & Browser Cookie Injection', () => {
    it('applies authorized session cookies to browser service and resumes execution', async () => {
      const user = await db.findOrCreateUserByPhone('+919876500009', 'Resume Success User');
      await db.updateUser(user.id, { name_confirmed: true, preferred_name: 'David' });
      const conv = await db.getOrCreateActiveConversation(user.id);

      // Seed previous shopping request in history
      await db.saveMessage({
        conversation_id: conv.id,
        sender_type: 'user',
        content: 'Order a Diet Coke from Instamart',
      });

      // User connects authorized session
      const cookies = [
        { name: 'session_token', value: 'authenticated_token_david', domain: '.swiggy.com' },
      ];
      await handoffManager.saveAuthorizedSession(user.id, 'Swiggy Instamart', { cookies });

      const cookieSpy = vi.spyOn(browserService, 'addCookies');

      const mockAi = new MockAIProvider(async () => ({
        text: 'Resumed with your authorized Swiggy Instamart session! Finding your Diet Coke now.',
      }));

      const orchestrator = new AgentOrchestrator(
        mockAi,
        toolRegistry,
        db,
        5,
        undefined,
        7000,
        22000,
        25,
        60000,
        browserService,
        handoffManager
      );

      const result = await orchestrator.processMessage({
        phoneNumber: '+919876500009',
        name: 'David',
        preferredName: 'David',
        nameConfirmed: true,
        text: 'resume',
      });

      // Verify cookies were applied to browser context
      expect(cookieSpy).toHaveBeenCalledWith(cookies);
      expect(result.replyText).toContain('authorized Swiggy Instamart session');
    });

    it('end-to-end shopping workflow with authorized session still enforces explicit checkout approval gate', async () => {
      const user = await db.findOrCreateUserByPhone('+919876500010', 'Approval Safe User');
      const conv = await db.getOrCreateActiveConversation(user.id);
      const ctx = { user, conversation: conv, messageId: 'msg_safety_1', sourceChannel: 'whatsapp' as const };

      // Save authorized session
      await handoffManager.saveAuthorizedSession(user.id, 'Swiggy Instamart', {
        cookies: [{ name: 'auth', value: 'valid_tok', domain: '.swiggy.com' }],
      });

      const shoppingTools = createShoppingTools(undefined, db, browserService, handoffManager);
      const addToCart = shoppingTools.find((t) => t.name === 'shopping_add_to_cart')!;
      const verifyCart = shoppingTools.find((t) => t.name === 'shopping_verify_cart')!;
      const checkout = shoppingTools.find((t) => t.name === 'shopping_checkout')!;

      // 1. Add item to cart
      await addToCart.execute(
        { productName: 'Diet Coke 300ml', price: 40, store: 'Swiggy Instamart', quantity: 1 },
        ctx
      );

      // 2. Verify cart
      const cartRes = await verifyCart.execute(
        { merchant: 'Swiggy Instamart', expectedItem: 'Diet Coke' },
        ctx
      );
      expect(cartRes.success).toBe(true);

      // 3. Attempt checkout WITHOUT prior user confirmation -> MUST REJECT!
      await expect(
        checkout.execute(
          { store: 'Swiggy Instamart', amount: 40, itemSummary: '1x Diet Coke' },
          { ...ctx, isUserConfirmed: false }
        )
      ).rejects.toThrow(ApprovalRequiredError);
    });
  });
});
