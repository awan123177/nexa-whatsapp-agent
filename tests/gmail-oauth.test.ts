import { describe, it, expect, vi } from 'vitest';
import { InMemoryRepository } from '../packages/database/src/index.js';
import {
  GoogleOAuthService,
  GmailEmailProvider,
  createDefaultToolRegistry,
  GMAIL_SCOPES,
} from '../packages/tools/src/index.js';
import { decryptTokenData, createSessionToken } from '../packages/security/src/index.js';
import { buildApp } from '../apps/api/src/app.js';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';
import { WhatsAppGateway } from '../packages/whatsapp/src/index.js';

describe('Google OAuth & Gmail Integration Suite', () => {
  const testEncryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  describe('GoogleOAuthService', () => {
    it('should generate an authorization URL with minimal Gmail scopes and CSRF state', () => {
      const oauth = new GoogleOAuthService({
        clientId: 'test-google-client-id.apps.googleusercontent.com',
        clientSecret: 'test-google-client-secret',
        redirectUri: 'https://nexa.example.com/auth/google/callback',
        encryptionKey: testEncryptionKey,
      });

      const { url, state } = oauth.generateAuthUrl({ userId: 'user-123' });
      const parsed = new URL(url);

      expect(parsed.origin).toBe('https://accounts.google.com');
      expect(parsed.pathname).toBe('/o/oauth2/v2/auth');
      expect(parsed.searchParams.get('client_id')).toBe('test-google-client-id.apps.googleusercontent.com');
      expect(parsed.searchParams.get('redirect_uri')).toBe('https://nexa.example.com/auth/google/callback');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('access_type')).toBe('offline');
      expect(parsed.searchParams.get('prompt')).toBe('consent');
      expect(parsed.searchParams.get('state')).toBe(state);

      // Verify scopes are strictly minimal
      const scopes = parsed.searchParams.get('scope')?.split(' ') || [];
      expect(scopes).toEqual(GMAIL_SCOPES);
      expect(scopes).toContain('https://www.googleapis.com/auth/gmail.send');
      expect(scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    });

    it('should verify valid state and reject tampered or expired state tokens', () => {
      const oauth = new GoogleOAuthService({
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
      });

      const { state } = oauth.generateAuthUrl({ userId: 'user-abc' });

      // Valid state verification
      const verified = oauth.verifyState(state);
      expect(verified.userId).toBe('user-abc');
      expect(verified.nonce).toBeDefined();

      // Tampered state payload rejection
      const parts = state.split('.');
      const tamperedState = `${parts[0]}tampered.${parts[1]}`;
      expect(() => oauth.verifyState(tamperedState)).toThrow(/CSRF signature mismatch/);

      // Malformed state rejection
      expect(() => oauth.verifyState('invalid-state-without-dots')).toThrow(/Malformed OAuth state/);
    });

    it('should exchange code for tokens and fetch user Gmail profile', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'mock-access-token-xyz',
              refresh_token: 'mock-refresh-token-abc',
              expires_in: 3600,
              token_type: 'Bearer',
              scope: GMAIL_SCOPES.join(' '),
            }),
          };
        }
        if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              emailAddress: 'alice.test@gmail.com',
              messagesTotal: 42,
              threadsTotal: 10,
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });

      const oauth = new GoogleOAuthService({
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        fetchFn: mockFetch as any,
      });

      const tokens = await oauth.exchangeCodeForTokens('valid-auth-code');
      expect(tokens.accessToken).toBe('mock-access-token-xyz');
      expect(tokens.refreshToken).toBe('mock-refresh-token-abc');
      expect(tokens.expiresIn).toBe(3600);
      expect(new Date(tokens.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const profile = await oauth.getGmailUserProfile(tokens.accessToken);
      expect(profile.emailAddress).toBe('alice.test@gmail.com');
    });

    it('should securely store credentials in connected_accounts encrypted at rest', async () => {
      const db = new InMemoryRepository();
      const oauth = new GoogleOAuthService({
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        db,
      });

      const tokens = {
        accessToken: 'super-secret-access-token-12345',
        refreshToken: 'super-secret-refresh-token-67890',
        expiresIn: 3600,
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        scope: GMAIL_SCOPES.join(' '),
        tokenType: 'Bearer',
      };

      const connected = await oauth.saveUserGoogleConnection('user-1', tokens, 'user1@gmail.com');
      expect(connected.user_id).toBe('user-1');
      expect(connected.provider).toBe('google');
      expect(connected.account_id).toBe('user1@gmail.com');
      expect(connected.status).toBe('active');

      // Verify that stored token_data is encrypted and NOT plain text
      const rawStoredToken = connected.token_data.access_token as string;
      expect(rawStoredToken).not.toBe('super-secret-access-token-12345');
      expect(rawStoredToken.startsWith('aes256gcm:')).toBe(true);

      const rawRefreshToken = connected.token_data.refresh_token as string;
      expect(rawRefreshToken).not.toBe('super-secret-refresh-token-67890');
      expect(rawRefreshToken.startsWith('aes256gcm:')).toBe(true);

      // Verify decryption recovers original values
      const decrypted = decryptTokenData(connected.token_data, testEncryptionKey);
      expect(decrypted.access_token).toBe('super-secret-access-token-12345');
      expect(decrypted.refresh_token).toBe('super-secret-refresh-token-67890');
    });

    it('should automatically refresh expired tokens when getValidAccessToken is called', async () => {
      const db = new InMemoryRepository();
      let refreshCallCount = 0;

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          refreshCallCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'new-refreshed-access-token-999',
              expires_in: 3600,
              scope: GMAIL_SCOPES.join(' '),
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });

      const oauth = new GoogleOAuthService({
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        db,
        fetchFn: mockFetch as any,
      });

      // Save an expired token
      const expiredTokens = {
        accessToken: 'old-expired-token',
        refreshToken: 'valid-refresh-token',
        expiresIn: 0,
        expiresAt: new Date(Date.now() - 10000).toISOString(), // expired 10s ago
        scope: GMAIL_SCOPES.join(' '),
        tokenType: 'Bearer',
      };
      await oauth.saveUserGoogleConnection('user-expired', expiredTokens, 'user-expired@gmail.com');

      // Call getValidAccessToken -> should trigger automatic token refresh
      const validToken = await oauth.getValidAccessToken('user-expired');
      expect(validToken).toBe('new-refreshed-access-token-999');
      expect(refreshCallCount).toBe(1);

      // Verify the new token was updated in database
      const stored = await db.getConnectedAccount('user-expired', 'google');
      expect(stored).toBeDefined();
      const decrypted = decryptTokenData(stored!.token_data, testEncryptionKey);
      expect(decrypted.access_token).toBe('new-refreshed-access-token-999');
    });

    it('should revoke token and mark connected account revoked upon disconnect', async () => {
      const db = new InMemoryRepository();
      let revokeCalledWith = '';

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.startsWith('https://oauth2.googleapis.com/revoke')) {
          revokeCalledWith = url;
          return { ok: true, status: 200 };
        }
        return { ok: false, status: 404 };
      });

      const oauth = new GoogleOAuthService({
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        db,
        fetchFn: mockFetch as any,
      });

      await oauth.saveUserGoogleConnection(
        'user-revoke',
        {
          accessToken: 'token-to-revoke',
          refreshToken: 'refresh-to-revoke',
          expiresIn: 3600,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          scope: GMAIL_SCOPES.join(' '),
          tokenType: 'Bearer',
        },
        'revoke@gmail.com'
      );

      const success = await oauth.disconnect('user-revoke');
      expect(success).toBe(true);
      expect(revokeCalledWith).toContain('refresh-to-revoke');

      // Account status in DB should now be 'revoked'
      const updated = await db.getConnectedAccount('user-revoke', 'google');
      expect(updated?.status).toBe('revoked');

      // Further attempt to get valid token should fail
      await expect(oauth.getValidAccessToken('user-revoke')).rejects.toThrow(
        /No active Google account connected/
      );
    });
  });

  describe('GmailEmailProvider', () => {
    it('should read emails and extract sender, recipient, subject, and body correctly', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              messages: [{ id: 'msg-001', threadId: 'thread-001' }],
            }),
          };
        }
        if (url.includes('/messages/msg-001?format=full')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 'msg-001',
              payload: {
                headers: [
                  { name: 'From', value: 'sender@example.com' },
                  { name: 'To', value: 'me@gmail.com' },
                  { name: 'Subject', value: 'Flight Confirmation #NX102' },
                  { name: 'Date', value: 'Wed, 30 Sep 2026 12:00:00 GMT' },
                ],
                body: {
                  data: Buffer.from('Your flight to London is confirmed.', 'utf-8').toString(
                    'base64url'
                  ),
                },
              },
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });

      const provider = new GmailEmailProvider({
        accessToken: 'valid-test-token',
        fetchFn: mockFetch as any,
      });

      const emails = await provider.readEmails({ query: 'flight', limit: 5 });
      expect(emails.length).toBe(1);
      expect(emails[0].id).toBe('msg-001');
      expect(emails[0].sender).toBe('sender@example.com');
      expect(emails[0].subject).toBe('Flight Confirmation #NX102');
      expect(emails[0].body).toBe('Your flight to London is confirmed.');
    });

    it('should send email using RFC 2822 formatting and URL-safe base64 encoding', async () => {
      let sentRawDecoded = '';

      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
          const bodyJson = JSON.parse(init?.body as string);
          sentRawDecoded = Buffer.from(bodyJson.raw, 'base64url').toString('utf-8');
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 'sent-msg-999',
              threadId: 'thread-999',
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });

      const provider = new GmailEmailProvider({
        accessToken: 'valid-test-token',
        fetchFn: mockFetch as any,
      });

      const result = await provider.sendEmail({
        to: 'client@example.com',
        subject: 'Meeting Summary',
        body: 'Here are the key takeaways from our meeting.',
        cc: ['manager@example.com'],
      });

      expect(result.messageId).toBe('sent-msg-999');
      expect(result.status).toBe('sent');
      expect(sentRawDecoded).toContain('To: client@example.com');
      expect(sentRawDecoded).toContain('Cc: manager@example.com');
      expect(sentRawDecoded).toContain('Here are the key takeaways from our meeting.');
    });

    it('should NOT fake successful Gmail operations on API errors', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        return {
          ok: false,
          status: 403,
          json: async () => ({
            error: {
              code: 403,
              message: 'The caller does not have permission for this Gmail resource.',
            },
          }),
        };
      });

      const provider = new GmailEmailProvider({
        accessToken: 'forbidden-token',
        fetchFn: mockFetch as any,
      });

      await expect(
        provider.sendEmail({
          to: 'client@example.com',
          subject: 'Test',
          body: 'Test body',
        })
      ).rejects.toThrow(/Failed to send email via Gmail API.*permission/);

      await expect(provider.readEmails({})).rejects.toThrow(/Gmail API error/);
    });
  });

  describe('Communication Tools Dynamic Email Integration', () => {
    it('should return helpful disconnected message when user has no connected Gmail account', async () => {
      const db = new InMemoryRepository();
      const oauthService = new GoogleOAuthService({ db, encryptionKey: testEncryptionKey });
      const registry = createDefaultToolRegistry({ db, oauthService });

      const user = await db.findOrCreateUserByPhone('+15551230001');
      const conversation = await db.getOrCreateActiveConversation(user.id);
      const context = { user, conversation, sourceChannel: 'whatsapp' as const };

      const result = await registry.executeTool('read_email', {}, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Email account is not connected');
    });

    it('should automatically use GmailEmailProvider when user has active Google account', async () => {
      const db = new InMemoryRepository();

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              messages: [{ id: 'msg-auto-01' }],
            }),
          };
        }
        if (url.includes('/messages/msg-auto-01?format=full')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 'msg-auto-01',
              payload: {
                headers: [
                  { name: 'From', value: 'boss@corp.com' },
                  { name: 'Subject', value: 'Project Review' },
                  { name: 'Date', value: 'Today' },
                ],
                body: {
                  data: Buffer.from('Review is scheduled for 3pm.', 'utf-8').toString('base64url'),
                },
              },
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });

      const oauthService = new GoogleOAuthService({
        clientId: 'cid',
        clientSecret: 'sec',
        redirectUri: 'uri',
        db,
        encryptionKey: testEncryptionKey,
        fetchFn: mockFetch as any,
      });

      const user = await db.findOrCreateUserByPhone('+15551230002');
      await oauthService.saveUserGoogleConnection(
        user.id,
        {
          accessToken: 'user-connected-token',
          refreshToken: 'user-refresh-token',
          expiresIn: 3600,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          scope: GMAIL_SCOPES.join(' '),
          tokenType: 'Bearer',
        },
        'user@gmail.com'
      );

      const registry = createDefaultToolRegistry({ db, oauthService });
      const conversation = await db.getOrCreateActiveConversation(user.id);
      const context = { user, conversation, sourceChannel: 'whatsapp' as const };

      const result = await registry.executeTool('read_email', {}, context);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.emails.length).toBe(1);
      expect(data.emails[0].subject).toBe('Project Review');
    });
  });

  describe('Fastify OAuth API Routes', () => {
    it('GET /auth/google/start should return 401 Unauthorized when session token is missing', async () => {
      const db = new InMemoryRepository();
      const oauthService = new GoogleOAuthService({
        clientId: 'cid-test',
        clientSecret: 'sec-test',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        db,
      });

      const app = buildApp({
        db,
        aiProvider: new MockAIProvider(async () => ({ text: 'mock' })),
        toolRegistry: createDefaultToolRegistry({ db, oauthService }),
        whatsapp: new WhatsAppGateway({}),
        oauthService,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/auth/google/start',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('AUTHENTICATION_REQUIRED');
      expect(body.error).toContain('Authentication required');
    });

    it('GET /auth/google/start should return 401 when called with raw userId query and no session token', async () => {
      const db = new InMemoryRepository();
      const oauthService = new GoogleOAuthService({
        clientId: 'cid-test',
        clientSecret: 'sec-test',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        db,
      });

      const app = buildApp({
        db,
        aiProvider: new MockAIProvider(async () => ({ text: 'mock' })),
        toolRegistry: createDefaultToolRegistry({ db, oauthService }),
        whatsapp: new WhatsAppGateway({}),
        oauthService,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/auth/google/start?userId=victim-user',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('GET /auth/google/start should return 403 Forbidden when requested userId does not match session token', async () => {
      const db = new InMemoryRepository();
      const oauthService = new GoogleOAuthService({
        clientId: 'cid-test',
        clientSecret: 'sec-test',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        db,
      });

      const app = buildApp({
        db,
        aiProvider: new MockAIProvider(async () => ({ text: 'mock' })),
        toolRegistry: createDefaultToolRegistry({ db, oauthService }),
        whatsapp: new WhatsAppGateway({}),
        oauthService,
      });

      const sessionToken = createSessionToken('alice-user', testEncryptionKey);

      const response = await app.inject({
        method: 'GET',
        url: `/auth/google/start?token=${encodeURIComponent(sessionToken)}&userId=bob-user`,
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('SECURITY_VIOLATION');
      expect(body.error).toContain('cannot initiate OAuth for another user');
    });

    it('GET /auth/google/start should return 200 with auth URL and state for valid session token', async () => {
      const db = new InMemoryRepository();
      const oauthService = new GoogleOAuthService({
        clientId: 'cid-test',
        clientSecret: 'sec-test',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        db,
      });

      const app = buildApp({
        db,
        aiProvider: new MockAIProvider(async () => ({ text: 'mock' })),
        toolRegistry: createDefaultToolRegistry({ db, oauthService }),
        whatsapp: new WhatsAppGateway({}),
        oauthService,
      });

      const sessionToken = createSessionToken('test-user-456', testEncryptionKey);

      const response = await app.inject({
        method: 'GET',
        url: `/auth/google/start?token=${encodeURIComponent(sessionToken)}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(body.state).toBeDefined();

      // State must be cryptographically tied to test-user-456
      const verifiedState = oauthService.verifyState(body.state);
      expect(verifiedState.userId).toBe('test-user-456');
    });

    it('GET /auth/google/start should accept session token via Authorization: Bearer header', async () => {
      const db = new InMemoryRepository();
      const oauthService = new GoogleOAuthService({
        clientId: 'cid-test',
        clientSecret: 'sec-test',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        db,
      });

      const app = buildApp({
        db,
        aiProvider: new MockAIProvider(async () => ({ text: 'mock' })),
        toolRegistry: createDefaultToolRegistry({ db, oauthService }),
        whatsapp: new WhatsAppGateway({}),
        oauthService,
      });

      const sessionToken = createSessionToken('bearer-user-777', testEncryptionKey);

      const response = await app.inject({
        method: 'GET',
        url: '/auth/google/start',
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      const stateData = oauthService.verifyState(body.state);
      expect(stateData.userId).toBe('bearer-user-777');
    });

    it('GET /auth/google/callback should handle authorization code and save connection', async () => {
      const db = new InMemoryRepository();

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'api-cb-access-token',
              refresh_token: 'api-cb-refresh-token',
              expires_in: 3600,
              token_type: 'Bearer',
              scope: GMAIL_SCOPES.join(' '),
            }),
          };
        }
        if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              emailAddress: 'api.callback.user@gmail.com',
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });

      const oauthService = new GoogleOAuthService({
        clientId: 'cid-test',
        clientSecret: 'sec-test',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        db,
        fetchFn: mockFetch as any,
      });

      const app = buildApp({
        db,
        aiProvider: new MockAIProvider(async () => ({ text: 'mock' })),
        toolRegistry: createDefaultToolRegistry({ db, oauthService }),
        whatsapp: new WhatsAppGateway({}),
        oauthService,
      });

      const { state } = oauthService.generateAuthUrl({ userId: 'api-user-789' });

      const response = await app.inject({
        method: 'GET',
        url: `/auth/google/callback?code=mock-code-123&state=${encodeURIComponent(state)}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.account.email).toBe('api.callback.user@gmail.com');

      // Verify account saved in DB
      const account = await db.getConnectedAccount('api-user-789', 'google');
      expect(account).toBeDefined();
      expect(account?.status).toBe('active');
      expect(account?.account_id).toBe('api.callback.user@gmail.com');
    });

    it('POST /auth/google/disconnect should return 401 when session token is missing', async () => {
      const db = new InMemoryRepository();
      const oauthService = new GoogleOAuthService({
        clientId: 'cid-test',
        clientSecret: 'sec-test',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        db,
      });

      const app = buildApp({
        db,
        aiProvider: new MockAIProvider(async () => ({ text: 'mock' })),
        toolRegistry: createDefaultToolRegistry({ db, oauthService }),
        whatsapp: new WhatsAppGateway({}),
        oauthService,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/auth/google/disconnect',
        payload: { userId: 'unauthenticated-target' },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('POST /auth/google/disconnect should return 403 when session token does not match target userId', async () => {
      const db = new InMemoryRepository();
      const oauthService = new GoogleOAuthService({
        clientId: 'cid-test',
        clientSecret: 'sec-test',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        db,
      });

      const app = buildApp({
        db,
        aiProvider: new MockAIProvider(async () => ({ text: 'mock' })),
        toolRegistry: createDefaultToolRegistry({ db, oauthService }),
        whatsapp: new WhatsAppGateway({}),
        oauthService,
      });

      const sessionToken = createSessionToken('attacker-user', testEncryptionKey);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/google/disconnect',
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
        payload: { userId: 'victim-target' },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('SECURITY_VIOLATION');
      expect(body.error).toContain('cannot disconnect another user');
    });

    it('POST /auth/google/disconnect should disconnect account and return 200 with valid session', async () => {
      const db = new InMemoryRepository();
      const oauthService = new GoogleOAuthService({
        clientId: 'cid-test',
        clientSecret: 'sec-test',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        db,
      });

      await oauthService.saveUserGoogleConnection(
        'disconnect-user-1',
        {
          accessToken: 'tok',
          refreshToken: 'ref',
          expiresIn: 3600,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          scope: GMAIL_SCOPES.join(' '),
          tokenType: 'Bearer',
        },
        'disconnect@gmail.com'
      );

      const app = buildApp({
        db,
        aiProvider: new MockAIProvider(async () => ({ text: 'mock' })),
        toolRegistry: createDefaultToolRegistry({ db, oauthService }),
        whatsapp: new WhatsAppGateway({}),
        oauthService,
      });

      const sessionToken = createSessionToken('disconnect-user-1', testEncryptionKey);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/google/disconnect',
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);

      const updated = await db.getConnectedAccount('disconnect-user-1', 'google');
      expect(updated?.status).toBe('revoked');
    });

    it('POST /auth/google/disconnect should return 404 when user has no active Google connection', async () => {
      const db = new InMemoryRepository();
      const oauthService = new GoogleOAuthService({
        clientId: 'cid-test',
        clientSecret: 'sec-test',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        db,
      });

      const app = buildApp({
        db,
        aiProvider: new MockAIProvider(async () => ({ text: 'mock' })),
        toolRegistry: createDefaultToolRegistry({ db, oauthService }),
        whatsapp: new WhatsAppGateway({}),
        oauthService,
      });

      const sessionToken = createSessionToken('non-existent-or-revoked-user', testEncryptionKey);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/google/disconnect',
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('No active Google account found');
    });

    it('GET /auth/google/start should return 302 redirect for browser requests with valid session', async () => {
      const db = new InMemoryRepository();
      const oauthService = new GoogleOAuthService({
        clientId: 'cid-test',
        clientSecret: 'sec-test',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        db,
      });

      const app = buildApp({
        db,
        aiProvider: new MockAIProvider(async () => ({ text: 'mock' })),
        toolRegistry: createDefaultToolRegistry({ db, oauthService }),
        whatsapp: new WhatsAppGateway({}),
        oauthService,
      });

      const sessionToken = createSessionToken('test-browser-user', testEncryptionKey);

      const response = await app.inject({
        method: 'GET',
        url: `/auth/google/start?token=${encodeURIComponent(sessionToken)}`,
        headers: {
          accept: 'text/html,application/xhtml+xml',
        },
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    });
  });

  describe('Edge Cases & Security Hardening', () => {
    it('GmailEmailProvider should strip CRLF injection characters from recipient and subject', async () => {
      let sentRawDecoded = '';

      const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const bodyJson = JSON.parse(init?.body as string);
        sentRawDecoded = Buffer.from(bodyJson.raw, 'base64url').toString('utf-8');
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'sent-safe-id' }),
        };
      });

      const provider = new GmailEmailProvider({
        accessToken: 'valid-test-token',
        fetchFn: mockFetch as any,
      });

      await provider.sendEmail({
        to: 'victim@example.com\r\nBcc: evil@attacker.com',
        subject: 'Injected\r\nSubject',
        body: 'Safe body content',
      });

      // Recipient header must have stripped newlines preventing Bcc injection
      expect(sentRawDecoded).not.toContain('\r\nBcc: evil@attacker.com');
      expect(sentRawDecoded).toContain('To: victim@example.comBcc: evil@attacker.com');
    });

    it('GoogleOAuthService should NOT reuse a revoked refresh token when user reconnects', async () => {
      const db = new InMemoryRepository();
      const oauth = new GoogleOAuthService({
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        db,
      });

      // 1. Initial connection
      await oauth.saveUserGoogleConnection(
        'reconnect-user',
        {
          accessToken: 'initial-access-token',
          refreshToken: 'revoked-refresh-token',
          expiresIn: 3600,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          scope: GMAIL_SCOPES.join(' '),
          tokenType: 'Bearer',
        },
        'user@gmail.com'
      );

      // 2. User disconnects -> account marked revoked and tokens cleared
      await oauth.disconnect('reconnect-user');

      // 3. User reconnects, but Google omits refresh token (e.g. without prompt=consent)
      const reconnected = await oauth.saveUserGoogleConnection(
        'reconnect-user',
        {
          accessToken: 'new-access-token',
          refreshToken: undefined, // Google omitted refresh token
          expiresIn: 3600,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          scope: GMAIL_SCOPES.join(' '),
          tokenType: 'Bearer',
        },
        'user@gmail.com'
      );

      // Verify that the reconnected account does NOT inherit the dead/revoked refresh token
      const decrypted = decryptTokenData(reconnected.token_data, testEncryptionKey);
      expect(decrypted.refresh_token).toBeUndefined();
    });

    it('GoogleOAuthService should mark connection expired in DB when Google rejects refresh token', async () => {
      const db = new InMemoryRepository();
      const mockFetch = vi.fn().mockImplementation(async () => {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          }),
        };
      });

      const oauth = new GoogleOAuthService({
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        redirectUri: 'https://example.com/callback',
        encryptionKey: testEncryptionKey,
        db,
        fetchFn: mockFetch as any,
      });

      await oauth.saveUserGoogleConnection(
        'user-bad-grant',
        {
          accessToken: 'expired-access-token',
          refreshToken: 'revoked-by-google',
          expiresIn: 0,
          expiresAt: new Date(Date.now() - 10000).toISOString(),
          scope: GMAIL_SCOPES.join(' '),
          tokenType: 'Bearer',
        },
        'badgrant@gmail.com'
      );

      await expect(oauth.getValidAccessToken('user-bad-grant')).rejects.toThrow(
        /Google OAuth token refresh failed/
      );

      // DB status should now be updated to 'expired'
      const updated = await db.getConnectedAccount('user-bad-grant', 'google');
      expect(updated?.status).toBe('expired');
    });
  });
});
