import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rawBody from 'fastify-raw-body';
import { IDatabaseRepository } from '@nexa/database';
import { AIProvider, NexaError } from '@nexa/shared';
import { ToolRegistry } from '@nexa/tools';
import { AgentOrchestrator } from '@nexa/agent';
import { WhatsAppGateway } from '@nexa/whatsapp';
import { InMemoryRateLimiter } from '@nexa/security';
import { registerHealthRoutes } from './routes/health.js';
import { registerWhatsAppRoutes } from './routes/whatsapp.js';
import { registerChatRoutes } from './routes/chat.js';

export interface AppDependencies {
  db: IDatabaseRepository;
  aiProvider: AIProvider;
  toolRegistry: ToolRegistry;
  whatsapp: WhatsAppGateway;
  rateLimiter?: InMemoryRateLimiter;
  maxAgentSteps?: number;
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
    global: false,
    encoding: 'utf8',
    runFirst: true,
    routes: ['/webhook/whatsapp'],
  });

  const rateLimiter = deps.rateLimiter || new InMemoryRateLimiter();
  const orchestrator = new AgentOrchestrator(
    deps.aiProvider,
    deps.toolRegistry,
    deps.db,
    deps.maxAgentSteps || 10
  );

  // Global Error Handler
  app.setErrorHandler((error, _req, reply) => {
    app.log.error(error);
    if (error instanceof NexaError) {
      return reply.status(error.statusCode).send({
        error: error.message,
        code: error.code,
        userFacingMessage: error.userFacingMessage,
      });
    }

    return reply.status(500).send({
      error: 'Internal Server Error',
      message: (error as any).message || 'An unexpected error occurred.',
    });
  });

  // Register route handlers
  registerHealthRoutes(app, {
    db: deps.db,
    aiProvider: deps.aiProvider,
    whatsapp: deps.whatsapp,
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

  return app;
}
