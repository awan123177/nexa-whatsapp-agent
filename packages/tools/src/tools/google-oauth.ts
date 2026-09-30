import crypto from 'node:crypto';
import { IDatabaseRepository } from '@nexa/database';
import { ConnectedAccount, NexaError } from '@nexa/shared';
import { encryptTokenData, decryptTokenData, createSessionToken } from '@nexa/security';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

export interface GoogleOAuthOptions {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  db?: IDatabaseRepository;
  encryptionKey?: string;
  fetchFn?: typeof fetch;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  expiresAt: string;
  scope: string;
  tokenType: string;
}

export interface AuthStateData {
  userId: string;
  nonce: string;
  timestamp: number;
}

export class GoogleOAuthService {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private db?: IDatabaseRepository;
  private encryptionKey?: string;
  private fetchFn: typeof fetch;

  constructor(options: GoogleOAuthOptions = {}) {
    this.clientId = options.clientId || process.env.GOOGLE_CLIENT_ID || '';
    this.clientSecret = options.clientSecret || process.env.GOOGLE_CLIENT_SECRET || '';
    this.redirectUri = options.redirectUri || process.env.GOOGLE_REDIRECT_URI || '';
    this.db = options.db;
    this.encryptionKey = options.encryptionKey || process.env.ENCRYPTION_KEY;
    this.fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis);
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  getFetchFn(): typeof fetch {
    return this.fetchFn;
  }

  getEncryptionKey(): string | undefined {
    return this.encryptionKey;
  }

  /**
   * Generates a signed, short-lived session token allowing the user to initiate Google OAuth.
   */
  createConnectSessionToken(userId: string, ttlMs = 3600_000): string {
    return createSessionToken(userId, this.encryptionKey, ttlMs);
  }

  /**
   * Generates an authenticated URL for connecting Google Gmail.
   */
  generateConnectUrl(baseUrl: string, userId: string, redirect = true): string {
    const token = this.createConnectSessionToken(userId);
    const cleanBase = baseUrl.replace(/\/+$/, '');
    return `${cleanBase}/auth/google/start?token=${encodeURIComponent(token)}${redirect ? '&redirect=true' : ''}`;
  }

  /**
   * Generates a signed, tamper-proof state token containing the userId and timestamp.
   */
  generateState(userId: string): string {
    const payload: AuthStateData = {
      userId,
      nonce: crypto.randomBytes(16).toString('hex'),
      timestamp: Date.now(),
    };

    const serialized = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const secret = this.clientSecret || this.encryptionKey || 'nexa-oauth-state-secret';
    const sig = crypto.createHmac('sha256', secret).update(serialized).digest('base64url');
    return `${serialized}.${sig}`;
  }

  /**
   * Validates state signature and expiration (15-minute max lifetime).
   */
  verifyState(state: string): AuthStateData {
    if (!state || typeof state !== 'string') {
      throw new NexaError('Invalid or missing OAuth state parameter.', {
        code: 'INVALID_OAUTH_STATE',
        statusCode: 400,
      });
    }

    const parts = state.split('.');
    if (parts.length !== 2) {
      throw new NexaError('Malformed OAuth state parameter format.', {
        code: 'INVALID_OAUTH_STATE',
        statusCode: 400,
      });
    }

    const [serialized, receivedSig] = parts;
    const secret = this.clientSecret || this.encryptionKey || 'nexa-oauth-state-secret';
    const expectedSig = crypto.createHmac('sha256', secret).update(serialized).digest('base64url');

    const expectedBuffer = Buffer.from(expectedSig);
    const receivedBuffer = Buffer.from(receivedSig);
    if (
      expectedBuffer.length !== receivedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
    ) {
      throw new NexaError('OAuth state CSRF signature mismatch.', {
        code: 'OAUTH_STATE_MISMATCH',
        statusCode: 403,
      });
    }

    try {
      const json = Buffer.from(serialized, 'base64url').toString('utf8');
      const data = JSON.parse(json) as AuthStateData;

      // Reject if older than 15 minutes (900,000 ms)
      const MAX_AGE = 15 * 60 * 1000;
      if (Date.now() - data.timestamp > MAX_AGE) {
        throw new NexaError('OAuth state has expired. Please initiate authorization again.', {
          code: 'OAUTH_STATE_EXPIRED',
          statusCode: 400,
        });
      }

      return data;
    } catch (err: any) {
      if (err instanceof NexaError) throw err;
      throw new NexaError('Failed to parse OAuth state payload.', {
        code: 'INVALID_OAUTH_STATE',
        statusCode: 400,
      });
    }
  }

  /**
   * Generates Google OAuth 2.0 authorization URL with minimal Gmail scopes.
   */
  generateAuthUrl(options: {
    userId: string;
    scopes?: string[];
    prompt?: string;
  }): { url: string; state: string } {
    if (!this.clientId || !this.redirectUri) {
      throw new NexaError(
        'Google OAuth is not configured. GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI are required.',
        { code: 'OAUTH_CONFIG_MISSING', statusCode: 500 }
      );
    }

    const state = this.generateState(options.userId);
    const scopes = options.scopes || GMAIL_SCOPES;

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', options.prompt || 'consent');
    url.searchParams.set('state', state);

    return { url: url.toString(), state };
  }

  /**
   * Exchanges an authorization code for access and refresh tokens.
   */
  async exchangeCodeForTokens(code: string): Promise<GoogleTokens> {
    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      throw new NexaError('Google OAuth credentials not configured on server.', {
        code: 'OAUTH_CONFIG_MISSING',
        statusCode: 500,
      });
    }

    const tokenEndpoint = 'https://oauth2.googleapis.com/token';
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    });

    const response = await this.fetchFn(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const resJson = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errMsg = (resJson as any).error_description || (resJson as any).error || 'Failed to exchange authorization code.';
      throw new NexaError(`Google OAuth token exchange failed: ${errMsg}`, {
        code: 'OAUTH_TOKEN_EXCHANGE_FAILED',
        statusCode: response.status,
      });
    }

    const expiresIn = Number((resJson as any).expires_in) || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    return {
      accessToken: (resJson as any).access_token,
      refreshToken: (resJson as any).refresh_token,
      expiresIn,
      expiresAt,
      scope: (resJson as any).scope || '',
      tokenType: (resJson as any).token_type || 'Bearer',
    };
  }

  /**
   * Refreshes an expired access token using the refresh token.
   */
  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn: number;
    expiresAt: string;
    scope?: string;
  }> {
    if (!this.clientId || !this.clientSecret) {
      throw new NexaError('Google OAuth credentials not configured on server.', {
        code: 'OAUTH_CONFIG_MISSING',
        statusCode: 500,
      });
    }

    const tokenEndpoint = 'https://oauth2.googleapis.com/token';
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await this.fetchFn(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const resJson = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errMsg = (resJson as any).error_description || (resJson as any).error || 'Failed to refresh access token.';
      throw new NexaError(`Google OAuth token refresh failed: ${errMsg}`, {
        code: 'OAUTH_TOKEN_REFRESH_FAILED',
        statusCode: response.status,
      });
    }

    const expiresIn = Number((resJson as any).expires_in) || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    return {
      accessToken: (resJson as any).access_token,
      refreshToken: (resJson as any).refresh_token,
      expiresIn,
      expiresAt,
      scope: (resJson as any).scope,
    };
  }

  /**
   * Revokes an access or refresh token with Google's OAuth revoke endpoint.
   */
  async revokeToken(token: string): Promise<boolean> {
    if (!token) return true;

    try {
      const response = await this.fetchFn(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Fetches the user's Gmail profile to obtain primary email address.
   */
  async getGmailUserProfile(accessToken: string): Promise<{
    emailAddress: string;
    messagesTotal?: number;
    threadsTotal?: number;
  }> {
    const response = await this.fetchFn('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = (err as any)?.error?.message || `HTTP ${response.status}`;
      throw new NexaError(`Failed to fetch Gmail profile: ${msg}`, {
        code: 'GMAIL_PROFILE_FETCH_FAILED',
        statusCode: response.status,
      });
    }

    const data = await response.json();
    return {
      emailAddress: (data as any).emailAddress,
      messagesTotal: (data as any).messagesTotal,
      threadsTotal: (data as any).threadsTotal,
    };
  }

  /**
   * Saves or updates a user's Google connected account with securely encrypted token storage.
   */
  async saveUserGoogleConnection(
    userId: string,
    tokens: GoogleTokens,
    emailAddress: string
  ): Promise<ConnectedAccount> {
    if (!this.db) {
      throw new NexaError('Database repository is not configured on GoogleOAuthService.', {
        code: 'DB_NOT_CONFIGURED',
        statusCode: 500,
      });
    }

    // Retrieve existing connection to preserve refresh_token if Google omitted it on re-consent
    // ONLY inherit refresh_token if the existing connection is active.
    // Never inherit from a revoked or expired connection.
    const existing = await this.db.getConnectedAccount(userId, 'google');
    let effectiveRefreshToken = tokens.refreshToken;

    if (!effectiveRefreshToken && existing && existing.status === 'active') {
      const existingDecrypted = decryptTokenData(existing.token_data, this.encryptionKey);
      effectiveRefreshToken = existingDecrypted.refresh_token as string | undefined;
    }

    const rawTokenData: Record<string, unknown> = {
      access_token: tokens.accessToken,
      refresh_token: effectiveRefreshToken,
      expires_at: tokens.expiresAt,
      token_type: tokens.tokenType,
      scope: tokens.scope,
    };

    // Encrypt sensitive token fields before writing to database
    const encryptedTokenData = encryptTokenData(rawTokenData, this.encryptionKey);

    return this.db.saveConnectedAccount({
      user_id: userId,
      provider: 'google',
      account_id: emailAddress,
      scopes: tokens.scope ? tokens.scope.split(' ') : GMAIL_SCOPES,
      token_data: encryptedTokenData,
      status: 'active',
      metadata: {
        email: emailAddress,
        connected_at: new Date().toISOString(),
      },
    });
  }

  /**
   * Retrieves a valid access token for a given user, automatically refreshing it if expired.
   */
  async getValidAccessToken(userId: string): Promise<string> {
    if (!this.db) {
      throw new NexaError('Database repository is not configured on GoogleOAuthService.', {
        code: 'DB_NOT_CONFIGURED',
        statusCode: 500,
      });
    }

    const connection = await this.db.getConnectedAccount(userId, 'google');
    if (!connection || connection.status !== 'active') {
      throw new NexaError('No active Google account connected for this user.', {
        code: 'GMAIL_ACCOUNT_NOT_CONNECTED',
        statusCode: 401,
        userFacingMessage: 'Please connect your Google / Gmail account via OAuth to enable this action.',
      });
    }

    const decrypted = decryptTokenData(connection.token_data, this.encryptionKey);
    const accessToken = decrypted.access_token as string;
    const refreshToken = decrypted.refresh_token as string | undefined;
    const expiresAtStr = decrypted.expires_at as string | undefined;

    // Check if token will expire within 60 seconds
    const expiresAt = expiresAtStr ? new Date(expiresAtStr).getTime() : 0;
    const now = Date.now();
    const isExpiredOrExpiring = !expiresAt || expiresAt - now < 60_000;

    if (!isExpiredOrExpiring && accessToken) {
      return accessToken;
    }

    // Attempt token refresh
    if (!refreshToken) {
      throw new NexaError('Access token is expired and no refresh token is stored. Re-authorization required.', {
        code: 'OAUTH_REAUTH_REQUIRED',
        statusCode: 401,
        userFacingMessage: 'Your Google connection has expired. Please re-authorize your Gmail account.',
      });
    }

    let refreshed;
    try {
      refreshed = await this.refreshAccessToken(refreshToken);
    } catch (err: any) {
      if (err.statusCode === 400 || err.statusCode === 401 || err.message?.includes('invalid_grant')) {
        await this.db.updateConnectedAccountStatus(userId, 'google', 'expired').catch(() => {});
      }
      throw err;
    }

    // Save refreshed tokens back to database
    decrypted.access_token = refreshed.accessToken;
    if (refreshed.refreshToken) {
      decrypted.refresh_token = refreshed.refreshToken;
    }
    decrypted.expires_at = refreshed.expiresAt;
    const updatedEncrypted = encryptTokenData(decrypted, this.encryptionKey);

    await this.db.saveConnectedAccount({
      user_id: userId,
      provider: 'google',
      account_id: connection.account_id,
      scopes: connection.scopes,
      token_data: updatedEncrypted,
      status: 'active',
      metadata: {
        ...connection.metadata,
        last_refreshed_at: new Date().toISOString(),
      },
    });

    return refreshed.accessToken;
  }

  /**
   * Disconnects a user's Google account: revokes tokens with Google and updates database.
   */
  async disconnect(userId: string): Promise<boolean> {
    if (!this.db) {
      throw new NexaError('Database repository is not configured on GoogleOAuthService.', {
        code: 'DB_NOT_CONFIGURED',
        statusCode: 500,
      });
    }

    const connection = await this.db.getConnectedAccount(userId, 'google');
    if (!connection || connection.status !== 'active') {
      return false;
    }

    try {
      const decrypted = decryptTokenData(connection.token_data, this.encryptionKey);
      const tokenToRevoke = (decrypted.refresh_token as string) || (decrypted.access_token as string);
      if (tokenToRevoke) {
        await this.revokeToken(tokenToRevoke);
      }
    } catch {
      // Continue even if revocation fails remotely (e.g. token already revoked)
    }

    // Clear sensitive token data and mark account revoked
    await this.db.saveConnectedAccount({
      ...connection,
      token_data: {},
      status: 'revoked',
      metadata: {
        ...connection.metadata,
        revoked_at: new Date().toISOString(),
      },
    });
    return true;
  }
}
