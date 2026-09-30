import { FastifyInstance } from 'fastify';
import { AgentOrchestrator } from '@nexa/agent';
import { WhatsAppGateway } from '@nexa/whatsapp';
import { InMemoryRateLimiter } from '@nexa/security';

export function registerWhatsAppRoutes(
  app: FastifyInstance,
  options: {
    orchestrator: AgentOrchestrator;
    whatsapp: WhatsAppGateway;
    rateLimiter: InMemoryRateLimiter;
  }
) {
  const { orchestrator, whatsapp, rateLimiter } = options;

  /**
   * GET /webhook/whatsapp
   * Meta Webhook Verification endpoint.
   */
  app.get('/webhook/whatsapp', async (req, reply) => {
    const query = req.query as {
      'hub.mode'?: string;
      'hub.verify_token'?: string;
      'hub.challenge'?: string;
    };

    const result = whatsapp.verifyWebhookChallenge(query);
    if (result.isValid && result.challenge) {
      console.log('[WhatsApp Webhook] Verification successful.');
      // Return challenge as plain text with 200 OK
      return reply.type('text/plain').status(200).send(result.challenge);
    }

    console.warn('[WhatsApp Webhook] Verification failed for query:', query);
    return reply.status(403).send('Forbidden: Invalid verification token');
  });

  /**
   * POST /webhook/whatsapp
   * Meta incoming webhook events (messages, button clicks, status updates).
   */
  app.post('/webhook/whatsapp', async (req, reply) => {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody = (req as any).rawBody || JSON.stringify(req.body);

    // 1. Verify Webhook Signature
    const isSignatureValid = whatsapp.verifyRequestSignature(rawBody, signature);
    if (!isSignatureValid) {
      console.error('[WhatsApp Webhook] Signature verification failed!');
      return reply.status(401).send({ error: 'Unauthorized signature' });
    }

    // 2. Parse incoming messages from the payload
    const incomingMessages = whatsapp.parseWebhook(req.body);

    // If this was just a delivery status receipt (e.g. 'delivered', 'read'), return 200 immediately
    if (incomingMessages.length === 0) {
      return reply.status(200).send({ status: 'ignored_non_message_event' });
    }

    // 3. Immediately respond 200 OK to Meta to prevent retries/timeouts
    reply.status(200).send({ status: 'received' });

    // 4. Asynchronously process incoming messages via Agent Orchestrator
    for (const msg of incomingMessages) {
      (async () => {
        try {
          // Check rate limit per phone number
          const rateCheck = rateLimiter.check(msg.senderPhoneNumber);
          if (!rateCheck.allowed) {
            await whatsapp.sendText(
              msg.senderPhoneNumber,
              'You have sent too many requests. Please wait a moment before sending another message.'
            );
            return;
          }

          // Acknowledge receipt by marking as read
          await whatsapp.markRead(msg.whatsappMessageId);

          if (!msg.text) {
            await whatsapp.sendText(
              msg.senderPhoneNumber,
              "I received your attachment! Document, audio, and media processing will be fully connected in the next update. For now, please feel free to send text requests."
            );
            return;
          }

          // Run through NEXA Agent Orchestrator
          const result = await orchestrator.processMessage({
            phoneNumber: msg.senderPhoneNumber,
            name: msg.senderName,
            text: msg.text,
            channel: 'whatsapp',
            whatsappMessageId: msg.whatsappMessageId,
            interactiveButtonId: msg.interactiveSelection?.id,
            whatsappClient: whatsapp,
          });

          // Send response back to user
          if (result.requiresApproval && result.approvalPrompt && result.approvalId) {
            // Send interactive Approve / Reject buttons
            await whatsapp.sendApprovalRequest(
              msg.senderPhoneNumber,
              result.approvalPrompt,
              result.approvalId
            );
          } else if (result.replyText) {
            // Send standard response text
            await whatsapp.sendText(msg.senderPhoneNumber, result.replyText);
          }
        } catch (err: any) {
          console.error('[WhatsApp Worker Error]', err);
          await whatsapp.sendText(
            msg.senderPhoneNumber,
            'I encountered an unexpected issue while processing your request. Please try again in a moment.'
          );
        }
      })().catch((e) => console.error('[WhatsApp Unhandled Async Error]', e));
    }
  });
}
