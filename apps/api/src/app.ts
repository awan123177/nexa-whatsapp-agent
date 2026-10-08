import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rawBody from 'fastify-raw-body';
import { IDatabaseRepository } from '@nexa/database';
import { AIProvider, NexaError } from '@nexa/shared';
import { ToolRegistry, GoogleOAuthService } from '@nexa/tools';
import { AgentOrchestrator } from '@nexa/agent';
import { WhatsAppGateway } from '@nexa/whatsapp';
import { InMemoryRateLimiter, redactString } from '@nexa/security';
import { registerHealthRoutes } from './routes/health.js';
import { registerWhatsAppRoutes } from './routes/whatsapp.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerAuthRoutes } from './routes/auth.js';

export interface AppDependencies {
  db: IDatabaseRepository;
  aiProvider: AIProvider;
  toolRegistry: ToolRegistry;
  whatsapp: WhatsAppGateway;
  oauthService?: GoogleOAuthService;
  rateLimiter?: InMemoryRateLimiter;
  maxAgentSteps?: number;
  toolTimeoutMs?: number;
  totalAgentDeadlineMs?: number;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // Enable CORS
  app.register(cors, {
    origin: true,
  });

  // Enable rawBody support (needed for Meta HMAC-SHA256 signature verification)
  app.register(rawBody, {
    field: 'rawBody',
    global: true,
    encoding: 'utf8',
    runFirst: true,
  });

  const rateLimiter = deps.rateLimiter || new InMemoryRateLimiter();
  const orchestrator = new AgentOrchestrator(
    deps.aiProvider,
    deps.toolRegistry,
    deps.db,
    deps.maxAgentSteps || 5,
    deps.whatsapp,
    deps.toolTimeoutMs || 7000,
    deps.totalAgentDeadlineMs || 22000
  );

  // Global Error Handler
  app.setErrorHandler((error, _req, reply) => {
    app.log.error(error);
    if (error instanceof NexaError) {
      return reply.status(error.statusCode).send({
        error: redactString(error.message),
        code: error.code,
        userFacingMessage: redactString(error.userFacingMessage),
      });
    }

    return reply.status(500).send({
      error: 'Internal Server Error',
      message: redactString((error as any).message || 'An unexpected error occurred.'),
    });
  });

  const oauthService = deps.oauthService || new GoogleOAuthService({ db: deps.db });

  // Register route handlers after plugins have initialized so rawBody hooks attach to all routes
  app.after(() => {
    registerHealthRoutes(app, {
      db: deps.db,
      aiProvider: deps.aiProvider,
      whatsapp: deps.whatsapp,
      oauthService,
    });

    registerWhatsAppRoutes(app, {
      orchestrator,
      whatsapp: deps.whatsapp,
      rateLimiter,
    });

    registerChatRoutes(app, {
      orchestrator,
      db: deps.db,
      rateLimiter,
    });

    registerAuthRoutes(app, {
      db: deps.db,
      oauthService,
    });
  });

  return app;
}
