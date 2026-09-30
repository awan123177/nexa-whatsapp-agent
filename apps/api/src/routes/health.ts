import { FastifyInstance } from 'fastify';
import { IDatabaseRepository } from '@nexa/database';
import { AIProvider } from '@nexa/shared';
import { WhatsAppGateway } from '@nexa/whatsapp';
import { GoogleOAuthService } from '@nexa/tools';

export function registerHealthRoutes(
  app: FastifyInstance,
  options: {
    db: IDatabaseRepository;
    aiProvider: AIProvider;
    whatsapp: WhatsAppGateway;
    oauthService?: GoogleOAuthService;
  }
) {
  app.get('/health', async (_req, reply) => {
    return reply.status(200).send({
      status: 'healthy',
      service: 'NEXA Agent API',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      integrations: {
        aiProvider: options.aiProvider.name,
        whatsappConfigured: options.whatsapp.client.isConfigured(),
        googleOAuthConfigured: options.oauthService ? options.oauthService.isConfigured() : false,
        databaseType: options.db.constructor.name,
      },
    });
  });
}
