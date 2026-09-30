import { FastifyInstance } from 'fastify';
import { AgentOrchestrator } from '@nexa/agent';
import { IDatabaseRepository } from '@nexa/database';
import { InMemoryRateLimiter } from '@nexa/security';

export function registerChatRoutes(
  app: FastifyInstance,
  options: {
    orchestrator: AgentOrchestrator;
    db: IDatabaseRepository;
    rateLimiter: InMemoryRateLimiter;
  }
) {
  const { orchestrator, db, rateLimiter } = options;

  /**
   * POST /api/v1/chat
   * Direct HTTP chat endpoint for testing and web client integration.
   */
  app.post('/api/v1/chat', async (req, reply) => {
    const body = req.body as {
      phoneNumber?: string;
      name?: string;
      message: string;
      interactiveButtonId?: string;
    };

    if (!body || !body.message) {
      return reply.status(400).send({ error: 'Missing required field: message' });
    }

    const phoneNumber = body.phoneNumber || '+15550000000';
    rateLimiter.enforce(phoneNumber);

    const result = await orchestrator.processMessage({
      phoneNumber,
      name: body.name,
      text: body.message,
      channel: 'api',
      interactiveButtonId: body.interactiveButtonId,
    });

    return reply.status(200).send(result);
  });

  /**
   * GET /api/v1/approvals/:conversationId
   * Retrieves any pending approvals for a conversation.
   */
  app.get('/api/v1/approvals/:conversationId', async (req, reply) => {
    const params = req.params as { conversationId: string };
    const pending = await db.getPendingApproval(params.conversationId);
    return reply.status(200).send({ pendingApproval: pending });
  });

  /**
   * GET /api/v1/memories/:phoneNumber
   * Retrieves memories for a specific phone number.
   */
  app.get('/api/v1/memories/:phoneNumber', async (req, reply) => {
    const params = req.params as { phoneNumber: string };
    const user = await db.findOrCreateUserByPhone(params.phoneNumber);
    const memories = await db.getUserMemories(user.id);
    return reply.status(200).send({ memories });
  });
}
