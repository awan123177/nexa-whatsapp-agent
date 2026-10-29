import { FastifyInstance } from 'fastify';
import { AgentOrchestrator } from '@nexa/agent';
import { WhatsAppGateway } from '@nexa/whatsapp';
import { InMemoryRateLimiter } from '@nexa/security';
import { NexaError, maskPhoneNumber } from '@nexa/shared';

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
      console.log(`[WhatsApp Webhook] Verification successful. mode=${query['hub.mode'] || 'none'}`);
      // Return challenge as plain text with 200 OK
      return reply.type('text/plain').status(200).send(result.challenge);
    }

    console.warn(`[WhatsApp Webhook] Verification failed for mode=${query['hub.mode'] || 'none'} token_valid=false`);
    return reply.status(403).send('Forbidden: Invalid verification token');
  });

  /**
   * POST /webhook/whatsapp
   * Meta incoming webhook events (messages, button clicks, status updates).
   */
  app.post('/webhook/whatsapp', async (req, reply) => {
    const correlationId = `corr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody = (req as any).rawBody;

    if (rawBody === undefined || rawBody === null) {
      console.error(`[WhatsApp Webhook] Missing raw request body for HMAC verification. correlation_id=${correlationId}`);
      return reply.status(400).send({ error: 'Missing raw request body' });
    }

    // 1. Verify Webhook Signature
    const isSignatureValid = whatsapp.verifyRequestSignature(rawBody, signature);
    if (!isSignatureValid) {
      console.error(`[WhatsApp Webhook] Signature verification failed! correlation_id=${correlationId}`);
      return reply.status(401).send({ error: 'Unauthorized signature' });
    }

    // 2. Parse incoming messages from the payload
    const incomingMessages = whatsapp.parseWebhook(req.body);

    // If this was just a delivery status receipt (e.g. 'delivered', 'read'), return 200 immediately
    if (incomingMessages.length === 0) {
      console.log(`[WhatsApp Webhook] Status-only or non-message event ignored. correlation_id=${correlationId}`);
      return reply.status(200).send({ status: 'ignored_non_message_event' });
    }

    // 3. Immediately respond 200 OK to Meta to prevent retries/timeouts
    reply.status(200).send({ status: 'received' });

    const webhookReceivedAt = Date.now();
    console.log(`[WhatsApp Path] webhook_received correlation_id=${correlationId} count=${incomingMessages.length}`);

    // 4. Asynchronously process incoming messages via Agent Orchestrator with idempotency guard
    for (const msg of incomingMessages) {
      const messageId = msg.whatsappMessageId;
      const messageCorrelationId = `${correlationId}_${messageId || Math.random().toString(36).slice(2, 6)}`;
      const maskedSender = maskPhoneNumber(msg.senderPhoneNumber);

      // Check phone number ID compatibility between inbound webhook and configured ID
      const configuredPhoneId = whatsapp.getPhoneNumberId();
      if (configuredPhoneId && msg.phoneNumberId && configuredPhoneId !== msg.phoneNumberId) {
        console.warn(
          `[WhatsApp Path] phone_number_id_mismatch correlation_id=${messageCorrelationId} configured=${configuredPhoneId} inbound_webhook=${msg.phoneNumberId}`
        );
      }

      // Idempotency check: Ignore duplicate in-flight or already completed messages
      if (messageId) {
        cleanExpiredIdempotencyEntries();

        if (inFlightMessageIds.has(messageId)) {
          console.log(`[WhatsApp Webhook] Duplicate in-flight message ignored: correlation_id=${messageCorrelationId} inbound_wamid=${messageId}`);
          continue;
        }

        if (completedMessageIds.has(messageId)) {
          console.log(`[WhatsApp Webhook] Duplicate already-completed message ignored: correlation_id=${messageCorrelationId} inbound_wamid=${messageId}`);
          continue;
        }

        inFlightMessageIds.add(messageId);
      }

      (async () => {
        const agentStartedAt = Date.now();
        console.log(
          `[WhatsApp Path] agent_processing_start correlation_id=${messageCorrelationId} inbound_wamid=${messageId || 'none'} sender=${maskedSender} type=${msg.type}`
        );

        try {
          // Check rate limit per phone number
          const rateCheck = rateLimiter.check(msg.senderPhoneNumber);
          if (!rateCheck.allowed) {
            console.warn(`[WhatsApp Path] rate_limit_exceeded correlation_id=${messageCorrelationId} sender=${maskedSender}`);
            await whatsapp.sendText(
              msg.senderPhoneNumber,
              'You have sent too many requests. Please wait a moment before sending another message.',
              { correlationId: messageCorrelationId, phoneNumberId: msg.phoneNumberId }
            );
            if (messageId) {
              completedMessageIds.set(messageId, { timestamp: Date.now() });
            }
            return;
          }

          // Acknowledge receipt by marking as read
          if (msg.whatsappMessageId) {
            await whatsapp.markRead(msg.whatsappMessageId, {
              correlationId: messageCorrelationId,
              phoneNumberId: msg.phoneNumberId,
            });
          }

          let audioBuffer: Buffer | undefined;
          let audioMimeType: string | undefined;

          if (msg.type === 'audio' && msg.media?.id) {
            console.log(`[Voice] audio_received correlation_id=${messageCorrelationId} message_id=${msg.whatsappMessageId} mime_type=${msg.media.mimeType}`);
            console.log(`[Voice] download_start correlation_id=${messageCorrelationId} media_id=${msg.media.id}`);
            try {
              const downloaded = await whatsapp.mediaService.downloadMedia(msg.media.id);
              console.log(`[Voice] download_success correlation_id=${messageCorrelationId} media_id=${msg.media.id} size_bytes=${downloaded.fileSizeBytes}`);

              // Validate maximum size (16MB limit for Meta WhatsApp voice)
              const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
              if (downloaded.fileSizeBytes > MAX_AUDIO_BYTES) {
                console.warn(`[Voice] audio_size_exceeded correlation_id=${messageCorrelationId} size_bytes=${downloaded.fileSizeBytes}`);
                await whatsapp.sendText(
                  msg.senderPhoneNumber,
                  'That voice note is a bit too large for me to process. Please send a shorter voice note (under 16MB) or send text.',
                  { correlationId: messageCorrelationId, phoneNumberId: msg.phoneNumberId }
                );
                if (messageId) {
                  completedMessageIds.set(messageId, { timestamp: Date.now() });
                }
                return;
              }

              audioBuffer = downloaded.buffer;
              audioMimeType = downloaded.mimeType;
              console.log(`[Voice] processing_multimodal correlation_id=${messageCorrelationId} mime_type=${audioMimeType}`);
            } catch (err: any) {
              console.error(`[Voice] download_failed correlation_id=${messageCorrelationId}: ${err.message}`);
              await whatsapp.sendText(
                msg.senderPhoneNumber,
                "I couldn't download your voice note right now. Could you please send your request as text or try again?",
                { correlationId: messageCorrelationId, phoneNumberId: msg.phoneNumberId }
              );
              if (messageId) {
                completedMessageIds.set(messageId, { timestamp: Date.now() });
              }
              return;
            }
          } else if (!msg.text) {
            await whatsapp.sendText(
              msg.senderPhoneNumber,
              'I received your attachment! Please feel free to send text requests or voice notes.',
              { correlationId: messageCorrelationId, phoneNumberId: msg.phoneNumberId }
            );
            if (messageId) {
              completedMessageIds.set(messageId, { timestamp: Date.now() });
            }
            return;
          }

          // Run through NEXA Agent Orchestrator with isolated error capture
          let result: any;
          try {
            result = await orchestrator.processMessage({
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
          } catch (agentErr: any) {
            const agentDuration = Date.now() - agentStartedAt;
            console.error(
              `[WhatsApp Path] agent_processing_failure correlation_id=${messageCorrelationId} inbound_wamid=${messageId || 'none'} duration_ms=${agentDuration} error_name=${agentErr.name} error_message="${agentErr.message}"`
            );

            // Determine safe user-facing message
            let userFacingMessage =
              agentErr instanceof NexaError && agentErr.userFacingMessage
                ? agentErr.userFacingMessage
                : undefined;

            if (!userFacingMessage) {
              const msgLower = (agentErr?.message || '').toLowerCase();
              if (msgLower.includes('gemini') || msgLower.includes('ai') || msgLower.includes('model')) {
                userFacingMessage = "I'm having trouble reaching my AI service right now. Give me a moment and try again.";
              } else if (msgLower.includes('browser') || msgLower.includes('chromium') || msgLower.includes('playwright') || msgLower.includes('obscura')) {
                userFacingMessage = "I couldn't open that site right now.";
              } else if (msgLower.includes('search') || msgLower.includes('duckduckgo')) {
                userFacingMessage = "I couldn't reach live web search right now, so I don't want to give you outdated information.";
              } else if (msgLower.includes('booking') || msgLower.includes('flight') || msgLower.includes('hotel')) {
                userFacingMessage = "I couldn't verify the booking, so I haven't marked it as booked.";
              } else if (msgLower.includes('payment') || msgLower.includes('wallet') || msgLower.includes('transfer')) {
                userFacingMessage = "The payment didn't complete, so I haven't marked it as successful.";
              } else {
                userFacingMessage = 'I encountered an unexpected issue while processing your request. Please try again in a moment.';
              }
            }

            // Attempt to deliver friendly error notification to user via WhatsApp
            try {
              console.log(
                `[WhatsApp Path] sending_agent_failure_notice correlation_id=${messageCorrelationId} inbound_wamid=${messageId || 'none'}`
              );
              await whatsapp.sendText(msg.senderPhoneNumber, userFacingMessage, {
                correlationId: messageCorrelationId,
                phoneNumberId: msg.phoneNumberId,
              });
            } catch (fallbackSendErr: any) {
              console.error(
                `[WhatsApp Path] agent_failure_notice_delivery_failed correlation_id=${messageCorrelationId} inbound_wamid=${messageId || 'none'} error="${fallbackSendErr.message}"`
              );
            }

            // Mark completed so duplicate deliveries don't re-trigger the failing task
            if (messageId) {
              completedMessageIds.set(messageId, { timestamp: Date.now() });
            }
            return;
          }

          const agentCompletedAt = Date.now();
          console.log(
            `[WhatsApp Path] agent_processing_complete correlation_id=${messageCorrelationId} inbound_wamid=${messageId || 'none'} duration_ms=${agentCompletedAt - agentStartedAt} steps=${result?.stepsCount ?? 0}`
          );

          // Outbound Reply Delivery with isolated error capture
          const sendStartedAt = Date.now();
          try {
            if (result.requiresApproval && result.approvalPrompt && result.approvalId) {
              console.log(
                `[WhatsApp Path] outbound_send_attempt correlation_id=${messageCorrelationId} inbound_wamid=${messageId || 'none'} type=approval`
              );
              await whatsapp.sendApprovalRequest(
                msg.senderPhoneNumber,
                result.approvalPrompt,
                result.approvalId,
                { correlationId: messageCorrelationId, phoneNumberId: msg.phoneNumberId }
              );
            } else if (result.replyText) {
              console.log(
                `[WhatsApp Path] outbound_send_attempt correlation_id=${messageCorrelationId} inbound_wamid=${messageId || 'none'} type=text`
              );
              await whatsapp.sendText(
                msg.senderPhoneNumber,
                result.replyText,
                { correlationId: messageCorrelationId, phoneNumberId: msg.phoneNumberId }
              );
            } else {
              console.log(
                `[WhatsApp Path] outbound_send_skipped correlation_id=${messageCorrelationId} inbound_wamid=${messageId || 'none'} reason=empty_reply_text`
              );
            }

            const sendCompletedAt = Date.now();
            console.log(
              `[WhatsApp Path] outbound_send_success correlation_id=${messageCorrelationId} inbound_wamid=${messageId || 'none'} send_latency_ms=${sendCompletedAt - sendStartedAt} total_latency_ms=${sendCompletedAt - webhookReceivedAt}`
            );

            // Mark message as completed in idempotency tracker
            if (messageId) {
              completedMessageIds.set(messageId, { timestamp: Date.now() });
            }
          } catch (outboundErr: any) {
            console.error(
              `[WhatsApp Path] outbound_send_failure correlation_id=${messageCorrelationId} inbound_wamid=${messageId || 'none'} error_name=${outboundErr.name} error_message="${outboundErr.message}"`
            );
            // Mark completed to bound retries on client-side duplicate deliveries
            if (messageId) {
              completedMessageIds.set(messageId, { timestamp: Date.now() });
            }
            throw outboundErr;
          }
        } catch (unhandledErr: any) {
          console.error(
            `[WhatsApp Path] unhandled_async_error correlation_id=${messageCorrelationId} inbound_wamid=${messageId || 'none'}:`,
            unhandledErr
          );
        } finally {
          if (messageId) {
            inFlightMessageIds.delete(messageId);
          }
        }
      })().catch((e) => {
        console.error(`[WhatsApp Path] fatal_async_rejection correlation_id=${messageCorrelationId}:`, e);
      });
    }
  });
}
