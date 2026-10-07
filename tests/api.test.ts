import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildApp } from '../apps/api/src/app.js';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { WhatsAppGateway } from '../packages/whatsapp/src/gateway.js';

describe('Fastify REST & Webhook API Suite', () => {
  let app: ReturnType<typeof buildApp>;
  let whatsapp: WhatsAppGateway;
  const verifyToken = 'test_verify_token_123';

  beforeEach(() => {
    const db = new InMemoryRepository();
    const aiProvider = new MockAIProvider(async (messages) => ({
      text: `Echo: ${messages[messages.length - 1]?.content}`,
    }));
    const toolRegistry = createDefaultToolRegistry({ db });
    whatsapp = new WhatsAppGateway({ verifyToken });

    app = buildApp({
      db,
      aiProvider,
      toolRegistry,
      whatsapp,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /health returns healthy status and metadata', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('healthy');
    expect(body.service).toBe('NEXA Agent API');
    expect(body.integrations).toHaveProperty('googleOAuthConfigured');
  });

  it('GET /webhook/whatsapp returns challenge on valid token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=test_challenge_999`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('test_challenge_999');
  });

  it('GET /webhook/whatsapp returns 403 on invalid token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=test_challenge_999',
    });

    expect(response.statusCode).toBe(403);
  });

  it('POST /webhook/whatsapp accepts valid payload and responds 200 immediately', async () => {
    const samplePayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: 'PHONE_1',
                  display_phone_number: '15551234567',
                },
                contacts: [{ profile: { name: 'Alice' }, wa_id: '15551234567' }],
                messages: [
                  {
                    from: '15551234567',
                    id: 'wamid.test_001',
                    timestamp: '1740000000',
                    type: 'text',
                    text: { body: 'Hello NEXA via Webhook' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const response = await app.inject({
      method: 'POST',
      url: '/webhook/whatsapp',
      payload: samplePayload,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('received');
  });

  it('POST /api/v1/chat processes direct HTTP chat messages', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: {
        phoneNumber: '+15559998888',
        name: 'DirectUser',
        message: 'Can you assist me?',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.replyText).toContain('Echo: Can you assist me?');
    expect(body.conversationId).toBeDefined();
  });

  it('duplicate webhook event does not send duplicate reply', async () => {
    const sendSpy = vi.spyOn(whatsapp, 'sendText');

    const samplePayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: 'PHONE_1',
                  display_phone_number: '15550001111',
                },
                contacts: [{ profile: { name: 'Alice' }, wa_id: '15551234567' }],
                messages: [
                  {
                    from: '15551234567',
                    id: 'wamid.test_duplicate_wamid',
                    timestamp: '1740000000',
                    type: 'text',
                    text: { body: 'Hello deduplication test' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    // First webhook delivery
    const res1 = await app.inject({
      method: 'POST',
      url: '/webhook/whatsapp',
      payload: samplePayload,
    });
    expect(res1.statusCode).toBe(200);

    // Allow async worker to complete
    await new Promise((r) => setTimeout(r, 60));

    // Second webhook delivery with the exact same wamid
    const res2 = await app.inject({
      method: 'POST',
      url: '/webhook/whatsapp',
      payload: samplePayload,
    });
    expect(res2.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 60));

    // Verify WhatsApp reply was sent ONLY once
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      '15551234567',
      expect.stringContaining('Echo: Hello deduplication test')
    );

    sendSpy.mockRestore();
  });

  it('concurrent duplicate webhook events do not send duplicate reply', async () => {
    const sendSpy = vi.spyOn(whatsapp, 'sendText');

    const samplePayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: 'PHONE_1',
                  display_phone_number: '15550001111',
                },
                contacts: [{ profile: { name: 'Bob' }, wa_id: '15559876543' }],
                messages: [
                  {
                    from: '15559876543',
                    id: 'wamid.test_concurrent_dup_wamid',
                    timestamp: '1740000000',
                    type: 'text',
                    text: { body: 'Concurrent test message' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    // Send two webhook requests concurrently
    const [res1, res2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/webhook/whatsapp',
        payload: samplePayload,
      }),
      app.inject({
        method: 'POST',
        url: '/webhook/whatsapp',
        payload: samplePayload,
      }),
    ]);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 60));

    // Exactly one reply sent
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      '15559876543',
      expect.stringContaining('Echo: Concurrent test message')
    );

    sendSpy.mockRestore();
  });
});
