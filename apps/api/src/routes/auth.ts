import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IDatabaseRepository } from '@nexa/database';
import { GoogleOAuthService } from '@nexa/tools';
import { NexaError } from '@nexa/shared';
import { authenticateUserRequest } from '@nexa/security';

export interface AuthRouteOptions {
  db: IDatabaseRepository;
  oauthService: GoogleOAuthService;
}

const StartQuerySchema = z.object({
  userId: z.string().optional(),
  token: z.string().optional(),
  sessionToken: z.string().optional(),
  redirect: z.enum(['true', 'false']).optional(),
});

const CallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const DisconnectBodySchema = z.object({
  userId: z.string().optional(),
  token: z.string().optional(),
  sessionToken: z.string().optional(),
});

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions) {
  const { oauthService } = options;

  /**
   * GET /auth/google/start
   * Initiates Google OAuth 2.0 flow for a user.
   */
  app.get('/auth/google/start', async (req, reply) => {
    const parseResult = StartQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Bad Request',
        details: parseResult.error.format(),
      });
    }

    const { userId: requestedUserId, redirect } = parseResult.data;

    let authenticatedUserId: string;
    try {
      authenticatedUserId = authenticateUserRequest(req, oauthService.getEncryptionKey());
    } catch (authErr: any) {
      return reply.status(authErr.statusCode || 401).send({
        error: authErr.message || 'Authentication required to initiate Google OAuth flow.',
        code: authErr.code || 'AUTHENTICATION_REQUIRED',
      });
    }

    // Prevent user from initiating OAuth on behalf of another user account
    if (requestedUserId && requestedUserId !== authenticatedUserId) {
      return reply.status(403).send({
        error: 'Forbidden: You cannot initiate OAuth for another user account.',
        code: 'SECURITY_VIOLATION',
      });
    }

    try {
      const { url, state } = oauthService.generateAuthUrl({ userId: authenticatedUserId });

      const shouldRedirect =
        redirect === 'true' ||
        (redirect !== 'false' && Boolean(req.headers.accept?.includes('text/html')));

      if (shouldRedirect) {
        return reply.redirect(url, 302);
      }

      return reply.status(200).send({
        url,
        state,
        message: 'Direct user to the authorization URL to grant Gmail permissions.',
      });
    } catch (err: any) {
      if (err instanceof NexaError) {
        return reply.status(err.statusCode).send({
          error: err.message,
          code: err.code,
        });
      }
      return reply.status(500).send({
        error: 'Failed to initiate Google OAuth flow',
        message: err.message,
      });
    }
  });

  /**
   * GET /auth/google/callback
   * Handles Google OAuth 2.0 redirect callback, token exchange, and persistence.
   */
  app.get('/auth/google/callback', async (req, reply) => {
    const parseResult = CallbackQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid callback parameters',
      });
    }

    const { code, state, error, error_description } = parseResult.data;

    if (error) {
      return reply.status(400).send({
        error: `Google OAuth error: ${error}`,
        description: error_description || 'Authorization was cancelled or rejected.',
      });
    }

    if (!code || !state) {
      return reply.status(400).send({
        error: 'Missing required code or state parameter from Google OAuth callback.',
      });
    }

    try {
      // 1. Verify CSRF state signature and extract userId
      const stateData = oauthService.verifyState(state);
      const userId = stateData.userId;

      // 2. Exchange authorization code for tokens
      const tokens = await oauthService.exchangeCodeForTokens(code);

      // 3. Fetch user's Gmail profile to obtain email address
      const profile = await oauthService.getGmailUserProfile(tokens.accessToken);

      // 4. Save connection with securely encrypted tokens in database
      const connected = await oauthService.saveUserGoogleConnection(
        userId,
        tokens,
        profile.emailAddress
      );

      // Render a simple, clean HTML success page or return JSON
      const acceptsHtml = req.headers.accept?.includes('text/html');
      if (acceptsHtml) {
        return reply
          .type('text/html')
          .status(200)
          .send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="utf-8">
              <title>NEXA - Gmail Connected</title>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
                .card { background: #1e293b; padding: 2rem 2.5rem; border-radius: 1rem; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; max-width: 420px; }
                h1 { color: #22c55e; margin-bottom: 0.5rem; font-size: 1.5rem; }
                p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; }
                .badge { background: #334155; padding: 0.4rem 0.8rem; border-radius: 0.5rem; display: inline-block; margin-top: 1rem; font-family: monospace; font-size: 0.9rem; color: #38bdf8; }
              </style>
            </head>
            <body>
              <div class="card">
                <h1>Google Account Connected</h1>
                <p>Your Gmail account has been successfully linked to NEXA. You can now close this window and return to WhatsApp.</p>
                <div class="badge">${profile.emailAddress}</div>
              </div>
            </body>
            </html>
          `);
      }

      return reply.status(200).send({
        success: true,
        message: 'Google account connected successfully',
        account: {
          id: connected.id,
          email: profile.emailAddress,
          status: connected.status,
        },
      });
    } catch (err: any) {
      if (err instanceof NexaError) {
        return reply.status(err.statusCode).send({
          error: err.message,
          code: err.code,
        });
      }
      return reply.status(500).send({
        error: 'Failed to process Google OAuth callback',
        message: err.message,
      });
    }
  });

  /**
   * POST /auth/google/disconnect
   * Disconnects a user's Google account and revokes access.
   */
  app.post('/auth/google/disconnect', async (req, reply) => {
    const parseResult = DisconnectBodySchema.safeParse(req.body || {});
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Bad Request',
        details: parseResult.error.format(),
      });
    }

    const { userId: requestedUserId } = parseResult.data || {};

    let authenticatedUserId: string;
    try {
      authenticatedUserId = authenticateUserRequest(req, oauthService.getEncryptionKey());
    } catch (authErr: any) {
      return reply.status(authErr.statusCode || 401).send({
        error: authErr.message || 'Authentication required to disconnect Google account.',
        code: authErr.code || 'AUTHENTICATION_REQUIRED',
      });
    }

    // Prevent user from disconnecting another user account
    if (requestedUserId && requestedUserId !== authenticatedUserId) {
      return reply.status(403).send({
        error: 'Forbidden: You cannot disconnect another user account.',
        code: 'SECURITY_VIOLATION',
      });
    }

    try {
      const disconnected = await oauthService.disconnect(authenticatedUserId);
      if (!disconnected) {
        return reply.status(404).send({
          error: 'No active Google account found for this user.',
        });
      }

      return reply.status(200).send({
        success: true,
        message: 'Google account disconnected successfully.',
      });
    } catch (err: any) {
      if (err instanceof NexaError) {
        return reply.status(err.statusCode).send({
          error: err.message,
          code: err.code,
        });
      }
      return reply.status(500).send({
        error: 'Failed to disconnect Google account',
        message: err.message,
      });
    }
  });
}
