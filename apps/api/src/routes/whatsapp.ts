import { FastifyInstance } from 'fastify';
import { AgentOrchestrator } from '@nexa/agent';
import { WhatsAppGateway } from '@nexa/whatsapp';
import { InMemoryRateLimiter } from '@nexa/security';
import { NexaError } from '@nexa/shared';

export function registerWhatsAppRoutes(
  app: FastifyInstance,
  options: {
    orchestrator: AgentOrchestrator;
    whatsapp: WhatsAppGateway;
    rateLimiter: InMemoryRateLimiter;
    inFlightMessageIds?: Set<string>;
    completedMessageIds?: Map<string, { timestamp: number }>;
  }
) {
  const { orchestrator, whatsapp, rateLimiter } = options;
  const inFlightMessageIds = options.inFlightMessageIds || new Set<string>();
  const completedMessageIds = options.completedMessageIds || new Map<string, { timestamp: number }>();
  const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000; // 15 minutes TTL

  function cleanExpiredIdempotencyEntries() {
    const now = Date.now();
    for (const [id, record] of completedMessageIds.entries()) {
      if (now - record.timestamp > IDEMPOTENCY_TTL_MS) {
        completedMessageIds.delete(id);
      }
    }
  }

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
    const rawBody = (req as any).rawBody;

    if (rawBody === undefined || rawBody === null) {
      console.error('[WhatsApp Webhook] Missing raw request body for HMAC verification');
      return reply.status(400).send({ error: 'Missing raw request body' });
    }

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

    const webhookReceivedAt = Date.now();
    console.log(`[WhatsApp Path] webhook_received count=${incomingMessages.length}`);

    // 4. Asynchronously process incoming messages via Agent Orchestrator with idempotency guard
    for (const msg of incomingMessages) {
      const messageId = msg.whatsappMessageId;

      // Idempotency check: Ignore duplicate in-flight or already completed messages
      if (messageId) {
        cleanExpiredIdempotencyEntries();

        if (inFlightMessageIds.has(messageId)) {
          console.log(`[WhatsApp Webhook] Duplicate in-flight message ${messageId} ignored.`);
          continue;
        }

        if (completedMessageIds.has(messageId)) {
          console.log(`[WhatsApp Webhook] Duplicate already-completed message ${messageId} ignored.`);
          continue;
        }

        inFlightMessageIds.add(messageId);
      }

      (async () => {
        try {
          const agentStartedAt = Date.now();
          console.log(`[WhatsApp Path] agent_processing_start elapsed_ms=${agentStartedAt - webhookReceivedAt}`);

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

          let audioBuffer: Buffer | undefined;
          let audioMimeType: string | undefined;

          if (msg.type === 'audio' && msg.media?.id) {
            console.log(`[Voice] audio_received message_id=${msg.whatsappMessageId} mime_type=${msg.media.mimeType}`);
            console.log(`[Voice] download_start media_id=${msg.media.id}`);
            try {
              const downloaded = await whatsapp.mediaService.downloadMedia(msg.media.id);
              console.log(`[Voice] download_success media_id=${msg.media.id} size_bytes=${downloaded.fileSizeBytes}`);

              // Validate maximum size (16MB limit for Meta WhatsApp voice)
              const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
              if (downloaded.fileSizeBytes > MAX_AUDIO_BYTES) {
                console.warn(`[Voice] audio_size_exceeded size_bytes=${downloaded.fileSizeBytes}`);
                await whatsapp.sendText(
                  msg.senderPhoneNumber,
                  'That voice note is a bit too large for me to process. Please send a shorter voice note (under 16MB) or send text.'
                );
                return;
              }

              audioBuffer = downloaded.buffer;
              audioMimeType = downloaded.mimeType;
              console.log(`[Voice] processing_multimodal mime_type=${audioMimeType}`);
            } catch (err: any) {
              console.error(`[Voice] download_failed: ${err.message}`);
              await whatsapp.sendText(
                msg.senderPhoneNumber,
                "I couldn't download your voice note right now. Could you please send your request as text or try again?"
              );
              return;
            }
          } else if (!msg.text) {
            await whatsapp.sendText(
              msg.senderPhoneNumber,
              'I received your attachment! Please feel free to send text requests or voice notes.'
            );
            return;
          }

          // Run through NEXA Agent Orchestrator
          const result = await orchestrator.processMessage({
            phoneNumber: msg.senderPhoneNumber,
            whatsappProfileName: msg.senderName,
            text: msg.text || '',
            audioBuffer,
            audioMimeType,
            channel: 'whatsapp',
            whatsappMessageId: msg.whatsappMessageId,
            interactiveButtonId: msg.interactiveSelection?.id,
            whatsappClient: whatsapp,
            receivedAt: webhookReceivedAt,
          });

          const sendStartedAt = Date.now();
          console.log(`[WhatsApp Path] whatsapp_send_start elapsed_ms=${sendStartedAt - webhookReceivedAt}`);

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

          const sendCompletedAt = Date.now();
          console.log(
            `[WhatsApp Path] whatsapp_send_success send_latency_ms=${sendCompletedAt - sendStartedAt} total_latency_ms=${sendCompletedAt - webhookReceivedAt}`
          );

          // Mark message as completed in idempotency tracker
          if (messageId) {
            completedMessageIds.set(messageId, { timestamp: Date.now() });
          }
        } catch (err: any) {
          console.error('[WhatsApp Worker Error]', err);
          const userFacingMessage =
            err instanceof NexaError && err.userFacingMessage
              ? err.userFacingMessage
              : 'I encountered an unexpected issue while processing your request. Please try again in a moment.';
          await whatsapp.sendText(msg.senderPhoneNumber, userFacingMessage);

          if (messageId) {
            completedMessageIds.set(messageId, { timestamp: Date.now() });
          }
        } finally {
          if (messageId) {
            inFlightMessageIds.delete(messageId);
          }
        }
      })().catch((e) => console.error('[WhatsApp Unhandled Async Error]', e));
    }
  });
}
