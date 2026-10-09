import {
  AuthState,
  BrowserOpenResult,
  MerchantSessionRecord,
} from '@nexa/shared';
import { IDatabaseRepository } from '@nexa/database';
import { CredentialVault, credentialVault, MerchantCredentials } from '@nexa/security';
import { PlaywrightBrowserService } from '@nexa/browser';
import { merchantResolver } from '../merchants/merchant-resolver.js';
import { ConnectedAccountManager } from './connected-account-manager.js';

export interface InitiateHandoffOptions {
  userId: string;
  merchant: string;
  canonicalUrl?: string;
  targetUrl?: string;
  openResult?: BrowserOpenResult;
  failureReason?: string;
  errorType?: string;
  status?: number;
  authState?: AuthState;
}

export interface HandoffSessionData {
  userId: string;
  merchant: string;
  canonicalUrl: string;
  blockedUrl: string;
  authState: AuthState;
  reason: string;
  errorType: string;
  status?: number;
  handoffOfferedAt: string;
  userFacingMessage: string;
  directMerchantUrl: string;
}

export interface HandoffReadinessResult {
  ready: boolean;
  merchant: string;
  authState: AuthState;
  hasCredentials: boolean;
  cookiesCount?: number;
  credentials?: MerchantCredentials;
  reason?: string;
  userFacingMessage?: string;
  directMerchantUrl: string;
}

/**
 * Determines whether a browser navigation result or page state represents a bot block,
 * CAPTCHA, edge network reset, or required login.
 */
export function isNavigationBlockedOrAuthRequired(result: BrowserOpenResult | {
  success?: boolean;
  errorType?: string;
  authState?: AuthState;
  message?: string;
  status?: number;
}): boolean {
  if (result.success === true && result.authState === 'AUTHENTICATED') {
    return false;
  }
  const errorType = (result as any).errorType?.toUpperCase();
  const authState = result.authState;
  const status = (result as any).status;
  const message = (result as any).message?.toLowerCase() || '';

  if (errorType === 'BOT_BLOCKED' || errorType === 'CAPTCHA_REQUIRED' || errorType === 'BLOCKED') {
    return true;
  }
  if (authState === 'BLOCKED' || authState === 'CAPTCHA_REQUIRED' || authState === 'AUTH_REQUIRED') {
    return true;
  }
  if (status === 429 || status === 403) {
    return true;
  }
  if (
    errorType === 'NAVIGATION_FAILED' &&
    (message.includes('err_connection_reset') ||
      message.includes('connection reset') ||
      message.includes('challenge') ||
      message.includes('blocked') ||
      message.includes('cloudflare') ||
      message.includes('forbidden') ||
      message.includes('rate limit'))
  ) {
    return true;
  }
  return false;
}

/**
 * Formulates a friendly, honest, and actionable WhatsApp handoff message.
 */
export function generateHandoffMessage(
  merchant: string,
  directUrl: string,
  authState: AuthState,
  details?: { errorType?: string; reason?: string; status?: number }
): string {
  const cleanMerchant = merchant.trim();
  const isAuthRequired = authState === 'AUTH_REQUIRED';

  const reasonText = (details?.reason || '').toLowerCase();
  const isRateLimit = details?.status === 429 || details?.errorType === 'RATE_LIMITED' || reasonText.includes('429') || reasonText.includes('rate limit');
  const isVerification = authState === 'CAPTCHA_REQUIRED' || details?.errorType === 'CAPTCHA_REQUIRED' || reasonText.includes('verification') || reasonText.includes('challenge') || reasonText.includes('captcha');

  if (isAuthRequired) {
    return [
      `🔐 *Sign-in required for ${cleanMerchant}*`,
      ``,
      `${cleanMerchant} requires an active account session to view your cart or place orders.`,
      ``,
      `*Options to proceed:*`,
      `1️⃣ *Direct Order:* Open ${cleanMerchant} directly on your device: ${directUrl}`,
      `2️⃣ *Authorized Session:* Connect your account session in NEXA settings, then reply *"resume"* to pick right back up.`,
    ].join('\n');
  }

  const causePhrase = isRateLimit
    ? `is presenting bot protection or rate limits`
    : isVerification
    ? `presented a verification check or security challenge`
    : `automated security check restricted access`;

  // Anti-bot / Edge Firewall / Connection Reset Block
  return [
    `🛡️ *${cleanMerchant} Security Notice*`,
    ``,
    `${cleanMerchant} ${causePhrase} from my cloud browser.`,
    ``,
    `*How we can get this done:*`,
    `1️⃣ *Direct Order (Fastest):* Open ${cleanMerchant} on your phone to complete your order directly: ${directUrl}`,
    `2️⃣ *Authorized Session:* If you have connected your authorized session with NEXA, reply *"resume"* and I'll use your authenticated session.`,
  ].join('\n');
}

/**
 * Manages user-assisted browser handoffs when cloud automated navigation is blocked.
 * Stores blocked sessions in merchant_sessions, generates friendly WhatsApp guidance,
 * and validates session readiness before resuming.
 */
export class UserAssistedHandoffManager {
  private static instances = new WeakMap<IDatabaseRepository, UserAssistedHandoffManager>();

  private accountManager: ConnectedAccountManager;
  private pendingHandoffs = new Map<string, HandoffSessionData>();

  public static getInstance(db: IDatabaseRepository): UserAssistedHandoffManager {
    let instance = UserAssistedHandoffManager.instances.get(db);
    if (!instance) {
      instance = new UserAssistedHandoffManager(db);
      UserAssistedHandoffManager.instances.set(db, instance);
    }
    return instance;
  }

  constructor(
    private db: IDatabaseRepository,
    private vault: CredentialVault = credentialVault
  ) {
    this.accountManager = new ConnectedAccountManager(db, vault);
  }

  /**
   * Initiates a user-assisted handoff for a blocked merchant.
   * Persists session to database and records in memory.
   */
  async initiateHandoff(options: InitiateHandoffOptions): Promise<HandoffSessionData> {
    const { userId, merchant } = options;
    const resolved = merchantResolver.resolve(merchant);
    const storeName = resolved?.name || merchant;
    const canonicalUrl = resolved?.canonicalUrl || options.canonicalUrl || 'https://www.swiggy.com/instamart';
    const targetUrl = options.targetUrl || canonicalUrl;

    const errorType = options.errorType || (options.openResult as any)?.errorType || 'BOT_BLOCKED';
    const status = options.status || (options.openResult as any)?.status;
    const reason = options.failureReason || (options.openResult as any)?.message || 'Access blocked by edge security';
    const authState = options.authState || (errorType === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'BLOCKED');
    const now = new Date().toISOString();

    const userFacingMessage = generateHandoffMessage(storeName, canonicalUrl, authState, {
      errorType,
      reason,
      status,
    });

    const handoffData: HandoffSessionData = {
      userId,
      merchant: storeName,
      canonicalUrl,
      blockedUrl: targetUrl,
      authState,
      reason,
      errorType,
      status,
      handoffOfferedAt: now,
      userFacingMessage,
      directMerchantUrl: canonicalUrl,
    };

    // Store in-memory
    this.pendingHandoffs.set(`${userId}:${storeName.toLowerCase()}`, handoffData);
    this.pendingHandoffs.set(`${userId}:latest`, handoffData);

    // Persist to database
    await this.db.saveMerchantSession({
      userId,
      merchant: storeName,
      authState,
      sessionState: {
        blockedUrl: targetUrl,
        reason,
        errorType,
        status,
        canonicalUrl,
        handoffOfferedAt: now,
        directMerchantUrl: canonicalUrl,
        actionNeeded: authState === 'BLOCKED' ? 'remote_session_or_direct' : 'login_required',
      },
      lastVerifiedAt: now,
      lastUsedAt: now,
    });

    console.log(`[Handoff] handoff_initiated user=${userId} merchant=${storeName} authState=${authState} errorType=${errorType}`);
    return handoffData;
  }

  /**
   * Securely checks whether an authorized session is available and ready for execution.
   */
  async checkSessionReadiness(userId: string, merchant: string): Promise<HandoffReadinessResult> {
    const resolved = merchantResolver.resolve(merchant);
    const merchantName = resolved?.name || merchant;
    const directUrl = resolved?.canonicalUrl || 'https://www.swiggy.com/instamart';

    console.log(`[Handoff] readiness_check user=${userId} merchant=${merchantName}`);

    // Check merchant session record in DB
    const session = await this.db.getMerchantSession(userId, merchantName);
    const connectedAccount = await this.accountManager.getConnectedAccount(userId, merchantName);

    if (!session && !connectedAccount) {
      console.log(`[Handoff] readiness_check user=${userId} merchant=${merchantName} ready=false authState=AUTH_REQUIRED`);
      return {
        ready: false,
        merchant: merchantName,
        authState: 'AUTH_REQUIRED',
        hasCredentials: false,
        reason: 'No merchant session or connected account found',
        userFacingMessage: generateHandoffMessage(merchantName, directUrl, 'AUTH_REQUIRED'),
        directMerchantUrl: directUrl,
      };
    }

    const currentAuthState = session?.authState || (connectedAccount?.status === 'active' ? 'AUTHENTICATED' : 'AUTH_REQUIRED');

    if (currentAuthState === 'AUTH_EXPIRED') {
      console.log(`[Handoff] readiness_check user=${userId} merchant=${merchantName} ready=false authState=AUTH_EXPIRED`);
      return {
        ready: false,
        merchant: merchantName,
        authState: 'AUTH_EXPIRED',
        hasCredentials: false,
        reason: 'Merchant session has expired',
        userFacingMessage: `Your session for ${merchantName} has expired. Please reconnect your account and reply "resume". Direct link: ${directUrl}`,
        directMerchantUrl: directUrl,
      };
    }

    if (currentAuthState !== 'AUTHENTICATED') {
      console.log(`[Handoff] readiness_check user=${userId} merchant=${merchantName} ready=false authState=${currentAuthState}`);
      return {
        ready: false,
        merchant: merchantName,
        authState: currentAuthState,
        hasCredentials: false,
        reason: `Session not authenticated (current state: ${currentAuthState})`,
        userFacingMessage: generateHandoffMessage(merchantName, directUrl, currentAuthState),
        directMerchantUrl: directUrl,
      };
    }

    // Decrypt credentials in-memory
    const credentials = await this.accountManager.getDecryptedCredentials<MerchantCredentials>(userId, merchantName);
    const hasCookies = Boolean(credentials?.cookies && Array.isArray(credentials.cookies) && credentials.cookies.length > 0);
    const hasToken = Boolean(credentials?.sessionToken || credentials?.apiKey);

    if (!hasCookies && !hasToken) {
      console.log(`[Handoff] readiness_check user=${userId} merchant=${merchantName} ready=false authState=AUTHENTICATED reason="no_usable_tokens"`);
      return {
        ready: false,
        merchant: merchantName,
        authState: 'AUTH_REQUIRED',
        hasCredentials: false,
        reason: 'Authenticated account exists but lacks session cookies or tokens',
        userFacingMessage: `Your ${merchantName} connection is missing valid session tokens. Please reconnect your account or order directly: ${directUrl}`,
        directMerchantUrl: directUrl,
      };
    }

    const cookiesCount = credentials?.cookies?.length || 0;
    console.log(`[Handoff] readiness_check user=${userId} merchant=${merchantName} ready=true authState=AUTHENTICATED cookies_count=${cookiesCount}`);

    return {
      ready: true,
      merchant: merchantName,
      authState: 'AUTHENTICATED',
      hasCredentials: true,
      cookiesCount,
      credentials: credentials || undefined,
      directMerchantUrl: directUrl,
    };
  }

  /**
   * Connects or updates an authorized session for a merchant.
   * Encrypts credentials with context-bound AES-256-GCM.
   */
  async saveAuthorizedSession(
    userId: string,
    merchant: string,
    sessionPayload: {
      cookies?: Array<{ name: string; value: string; [key: string]: any }>;
      sessionToken?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<MerchantSessionRecord> {
    const resolved = merchantResolver.resolve(merchant);
    const cleanMerchant = resolved?.name || merchant;
    const now = new Date().toISOString();

    // Store encrypted credentials in connected_accounts
    await this.accountManager.connectAccount({
      userId,
      merchant: cleanMerchant,
      accountId: `session_${userId}_${cleanMerchant.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
      credentials: {
        cookies: sessionPayload.cookies || [],
        sessionToken: sessionPayload.sessionToken,
      },
      metadata: sessionPayload.metadata || {},
    });

    // Save active merchant session
    const session = await this.db.saveMerchantSession({
      userId,
      merchant: cleanMerchant,
      authState: 'AUTHENTICATED',
      sessionState: {
        cookiesCount: sessionPayload.cookies?.length || 0,
        hasToken: Boolean(sessionPayload.sessionToken),
        connectedAt: now,
      },
      lastVerifiedAt: now,
      lastUsedAt: now,
    });

    // Update active pending handoff in memory to AUTHENTICATED
    const canonicalUrl = resolved?.canonicalUrl || 'https://www.swiggy.com/instamart';
    const handoffRecord: HandoffSessionData = {
      userId,
      merchant: cleanMerchant,
      canonicalUrl,
      blockedUrl: canonicalUrl,
      authState: 'AUTHENTICATED',
      reason: 'Authorized session connected',
      errorType: 'NONE',
      handoffOfferedAt: now,
      userFacingMessage: '',
      directMerchantUrl: canonicalUrl,
    };
    this.pendingHandoffs.set(`${userId}:${cleanMerchant.toLowerCase()}`, handoffRecord);
    this.pendingHandoffs.set(`${userId}:latest`, handoffRecord);

    console.log(`[Handoff] authorized_session_saved user=${userId} merchant=${cleanMerchant} authState=AUTHENTICATED cookies_count=${sessionPayload.cookies?.length || 0}`);
    return session;
  }

  /**
   * Applies an authorized session's decrypted cookies/headers to the Playwright browser context.
   */
  async applySessionToBrowser(
    browserService: PlaywrightBrowserService,
    userId: string,
    merchant: string
  ): Promise<boolean> {
    const readiness = await this.checkSessionReadiness(userId, merchant);
    if (!readiness.ready || !readiness.credentials) {
      return false;
    }

    try {
      if (readiness.credentials.cookies && readiness.credentials.cookies.length > 0) {
        await browserService.addCookies(readiness.credentials.cookies);
        console.log(`[Handoff] session_applied merchant=${merchant} cookies_count=${readiness.credentials.cookies.length}`);
      }
      return true;
    } catch (err: any) {
      console.log(`[Handoff] session_apply_failed merchant=${merchant} error="${err.message}"`);
      return false;
    }
  }

  getPendingHandoff(userId: string, merchant?: string): HandoffSessionData | null {
    if (merchant) {
      return this.pendingHandoffs.get(`${userId}:${merchant.toLowerCase()}`) || null;
    }
    return this.pendingHandoffs.get(`${userId}:latest`) || null;
  }

  async getLatestPendingHandoff(userId: string, merchant?: string): Promise<{ merchant: string; authState: AuthState; directUrl: string } | null> {
    const mem = this.getPendingHandoff(userId, merchant);
    if (mem) {
      return { merchant: mem.merchant, authState: mem.authState, directUrl: mem.directMerchantUrl };
    }
    const merchantsToCheck = merchant ? [merchant] : ['Swiggy Instamart', 'Blinkit', 'Zepto', 'Amazon'];
    for (const m of merchantsToCheck) {
      const session = await this.db.getMerchantSession(userId, m);
      if (session && (session.sessionState?.handoffOfferedAt || session.authState === 'BLOCKED' || session.authState === 'AUTH_REQUIRED' || session.authState === 'CAPTCHA_REQUIRED')) {
        const resolved = merchantResolver.resolve(m);
        return {
          merchant: session.merchant,
          authState: session.authState,
          directUrl: resolved?.canonicalUrl || 'https://www.swiggy.com/instamart',
        };
      }
    }
    return null;
  }

  async clearPendingHandoff(userId: string, merchant?: string): Promise<void> {
    if (merchant) {
      this.pendingHandoffs.delete(`${userId}:${merchant.toLowerCase()}`);
    }
    this.pendingHandoffs.delete(`${userId}:latest`);
  }
}
