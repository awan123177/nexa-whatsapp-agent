import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  WhatsAppCloudApiClient,
  WhatsAppGateway,
} from '../packages/whatsapp/src/index.js';
import {
  cleanCredential,
  cleanPhoneNumberId,
  sanitizeRecipientPhone,
  maskPhoneNumber,
  logWhatsAppConfigStatus,
  loadConfig,
  NexaError,
} from '../packages/shared/src/index.js';
import { redactString } from '../packages/security/src/index.js';
import { MockAIProvider } from '../packages/ai/src/index.js';
import { buildApp } from '../apps/api/src/app.js';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';

describe('WhatsApp Autonomous Failure & Outbound Messaging Regression Suite', () => {
  const TEST_ACCESS_TOKEN = 'EAABtest_token_secret_1234567890abcdefgh';
  const TEST_PHONE_NUMBER_ID = '109988776655443';
  const TEST_WABA_ID = '209988776655443';
  const TEST_APP_SECRET = 'meta_test_secret_key_888';
  const TEST_VERIFY_TOKEN = 'nexa_webhook_secret_verify_token_777';

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function generateSignature(payload: string, secret: string): string {
    const hash = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return `sha256=${hash}`;
  }

  // 1. Successful outbound text message
  it('1. Successful outbound text message confirms acceptance from Meta and verifies outbound wamid', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          messaging_product: 'whatsapp',
          contacts: [{ input: '15551234567', wa_id: '15551234567' }],
          messages: [{ id: 'wamid.HBgLMDExMjM0NTY3_OUTBOUND' }],
        }),
    } as any);

    const client = new WhatsAppCloudApiClient({
      accessToken: TEST_ACCESS_TOKEN,
      phoneNumberId: TEST_PHONE_NUMBER_ID,
      allowSimulation: false,
    });

    const result = await client.sendTextMessage('+1 (555) 123-4567', 'Hello from NEXA!', {
      correlationId: 'corr_test_success_1',
    });

    expect(result.messages[0].id).toBe('wamid.HBgLMDExMjM0NTY3_OUTBOUND');

    // Verify fetch call URL, headers, and payload
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `https://graph.facebook.com/v21.0/${TEST_PHONE_NUMBER_ID}/messages`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: '+15551234567',
          type: 'text',
          text: {
            preview_url: false,
            body: 'Hello from NEXA!',
          },
        }),
      })
    );

    // Verify safe logging confirmed acceptance
    const logs = consoleSpy.mock.calls.map((c) => c[0]);
    expect(
      logs.some((l) => typeof l === 'string' && l.includes('Outbound message accepted by Meta'))
    ).toBe(true);
    expect(
      logs.some((l) => typeof l === 'string' && l.includes('outbound_wamid=wamid.HBgLMDExMjM0NTY3_OUTBOUND'))
    ).toBe(true);
    // Recipient should be masked
    expect(
      logs.some((l) => typeof l === 'string' && l.includes('recipient=155***4567'))
    ).toBe(true);
  });

  // 2. Meta error code 100 handling (OAuthException / Authorization Error)
  it('2. Meta error code 100 throws WHATSAPP_OAUTH_ERROR and logs diagnostics safely', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () =>
        JSON.stringify({
          error: {
            message: 'Authorization Error',
            type: 'OAuthException',
            code: 100,
            error_subcode: 33,
            error_data: { messaging_product: 'whatsapp', details: 'Cannot send message to this recipient' },
            fbtrace_id: 'FbTrace_Code100_XYZ',
          },
        }),
    } as any);

    const client = new WhatsAppCloudApiClient({
      accessToken: TEST_ACCESS_TOKEN,
      phoneNumberId: TEST_PHONE_NUMBER_ID,
      allowSimulation: false,
    });

    let caughtError: any;
    try {
      await client.sendTextMessage('15551234567', 'Testing error code 100', {
        correlationId: 'corr_code_100_test',
      });
    } catch (err: any) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(NexaError);
    expect(caughtError.code).toBe('WHATSAPP_OAUTH_ERROR');
    expect(caughtError.statusCode).toBe(400);
    expect(caughtError.metaError).toBeDefined();
    expect(caughtError.metaError.code).toBe(100);
    expect(caughtError.metaError.subcode).toBe(33);
    expect(caughtError.metaError.fbtraceId).toBe('FbTrace_Code100_XYZ');

    // Verify diagnostic error log contains error details without leaking token
    const errorLogs = errorSpy.mock.calls.map((c) => c[0]);
    expect(
      errorLogs.some(
        (l) =>
          typeof l === 'string' &&
          l.includes('Meta API error during sendTextMessage') &&
          l.includes('status=400') &&
          l.includes('error_code=100') &&
          l.includes('error_subcode=33') &&
          l.includes('fbtrace_id=FbTrace_Code100_XYZ')
      )
    ).toBe(true);

    // Verify token is NOT logged in console.error
    expect(errorLogs.some((l) => typeof l === 'string' && l.includes(TEST_ACCESS_TOKEN))).toBe(false);
  });

  // 3. Invalid or expired token responses (Code 190)
  it('3. Invalid or expired token response (Code 190) maps to WHATSAPP_TOKEN_EXPIRED', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () =>
        JSON.stringify({
          error: {
            message: 'Error validating access token: Session has expired on Monday, 10-Nov-26 00:00:00 PST.',
            type: 'OAuthException',
            code: 190,
            error_subcode: 463,
            fbtrace_id: 'FbTrace_Expired_999',
          },
        }),
    } as any);

    const client = new WhatsAppCloudApiClient({
      accessToken: TEST_ACCESS_TOKEN,
      phoneNumberId: TEST_PHONE_NUMBER_ID,
      allowSimulation: false,
    });

    await expect(
      client.sendTextMessage('15551234567', 'Testing expired token', {
        correlationId: 'corr_expired_token_test',
      })
    ).rejects.toMatchObject({
      code: 'WHATSAPP_TOKEN_EXPIRED',
      statusCode: 401,
      metaError: expect.objectContaining({
        code: 190,
        subcode: 463,
        fbtraceId: 'FbTrace_Expired_999',
      }),
    });
  });

  // 4. Missing or mismatched phone number ID
  it('4. Missing or mismatched phone number ID is safely validated and warned', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Case A: Missing phone number ID throws MISSING_PHONE_NUMBER_ID
    const clientNoPhone = new WhatsAppCloudApiClient({
      accessToken: TEST_ACCESS_TOKEN,
      allowSimulation: false,
    });

    await expect(
      clientNoPhone.sendTextMessage('15551234567', 'Missing phone ID')
    ).rejects.toMatchObject({
      code: 'MISSING_PHONE_NUMBER_ID',
      statusCode: 400,
    });

    // Case B: Mismatched phone number ID logs diagnostic warning
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          messaging_product: 'whatsapp',
          messages: [{ id: 'wamid.out_override' }],
        }),
    } as any);

    const clientWithPhone = new WhatsAppCloudApiClient({
      accessToken: TEST_ACCESS_TOKEN,
      phoneNumberId: 'CONFIGURED_PHONE_123',
      businessAccountId: TEST_WABA_ID,
      allowSimulation: false,
    });

    await clientWithPhone.sendTextMessage('15551234567', 'Testing override', {
      phoneNumberId: 'INBOUND_OVERRIDE_456',
      correlationId: 'corr_override_test',
    });

    const warnLogs = warnSpy.mock.calls.map((c) => c[0]);
    expect(
      warnLogs.some(
        (l) =>
          typeof l === 'string' &&
          l.includes('Configured PHONE_NUMBER_ID (CONFIGURED_PHONE_123) differs from override (INBOUND_OVERRIDE_456)')
      )
    ).toBe(true);

    // Case C: Target phone number ID matching WABA ID triggers WABA misconfiguration warning
    const clientWabaMatch = new WhatsAppCloudApiClient({
      accessToken: TEST_ACCESS_TOKEN,
      phoneNumberId: TEST_WABA_ID, // mistakenly configured as WABA ID
      businessAccountId: TEST_WABA_ID,
      allowSimulation: false,
    });

    await clientWabaMatch.sendTextMessage('15551234567', 'Testing WABA match warning');
    expect(
      warnSpy.mock.calls.some(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('matches WHATSAPP_BUSINESS_ACCOUNT_ID. WhatsApp Cloud API /messages requires a Phone Number ID, not a WABA ID.')
      )
    ).toBe(true);
  });

  // 5. Missing required environment variables
  it('5. Missing required environment variables throws in non-simulation and logs safe presence check', async () => {
    // When simulation is disabled, missing access token throws MISSING_ACCESS_TOKEN
    const client = new WhatsAppCloudApiClient({
      phoneNumberId: TEST_PHONE_NUMBER_ID,
      allowSimulation: false,
    });

    await expect(
      client.sendTextMessage('15551234567', 'Missing access token')
    ).rejects.toMatchObject({
      code: 'MISSING_ACCESS_TOKEN',
      statusCode: 500,
    });

    // Test safe configuration logging helper
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logWhatsAppConfigStatus({
      NODE_ENV: 'production',
      WHATSAPP_ACCESS_TOKEN: undefined,
      WHATSAPP_PHONE_NUMBER_ID: '12345',
      WHATSAPP_BUSINESS_ACCOUNT_ID: '12345', // identical to trigger warning
      WHATSAPP_VERIFY_TOKEN: undefined,
      WHATSAPP_APP_SECRET: undefined,
      WHATSAPP_GRAPH_API_VERSION: 'v21.0',
    } as any);

    const logs = logSpy.mock.calls.map((c) => c[0]);
    expect(logs.some((l) => typeof l === 'string' && l.includes('WHATSAPP_ACCESS_TOKEN: MISSING'))).toBe(true);
    expect(logs.some((l) => typeof l === 'string' && l.includes('WHATSAPP_PHONE_NUMBER_ID: configured'))).toBe(true);

    // Warning for identical WABA and phone number ID
    expect(
      warnSpy.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('WHATSAPP_PHONE_NUMBER_ID is identical to WHATSAPP_BUSINESS_ACCOUNT_ID')
      )
    ).toBe(true);
  });

  // 6. Invalid recipient or malformed payload
  it('6. Invalid recipient throws INVALID_RECIPIENT_PHONE before network call', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    const client = new WhatsAppCloudApiClient({
      accessToken: TEST_ACCESS_TOKEN,
      phoneNumberId: TEST_PHONE_NUMBER_ID,
      allowSimulation: false,
    });

    // Test non-digit string
    await expect(client.sendTextMessage('invalid-phone', 'Hi')).rejects.toMatchObject({
      code: 'INVALID_RECIPIENT_PHONE',
      statusCode: 400,
    });

    // Test too short
    await expect(client.sendTextMessage('123', 'Hi')).rejects.toMatchObject({
      code: 'INVALID_RECIPIENT_PHONE',
      statusCode: 400,
    });

    // Test empty
    await expect(client.sendTextMessage('', 'Hi')).rejects.toMatchObject({
      code: 'INVALID_RECIPIENT_PHONE',
      statusCode: 400,
    });

    // Ensure no network calls were made for invalid recipients
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 7. Agent exception after the webhook has been acknowledged
  it('7. Agent exception after webhook has been acknowledged logs diagnostics and sends user failure notice', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const db = new InMemoryRepository();
    // Pre-confirm user identity so orchestrator proceeds to AI execution
    const user = await db.findOrCreateUserByPhone('15551239999', 'Alice');
    await db.updateUser(user.id, { preferred_name: 'Alice', name_confirmed: true });

    const toolRegistry = createDefaultToolRegistry({ db });
    const whatsapp = new WhatsAppGateway({
      appSecret: TEST_APP_SECRET,
    });

    // Mock orchestrator throwing an exception during asynchronous execution
    const orchestratorError = new Error('Database connection timeout during execution');
    vi.spyOn(db, 'saveMessage').mockRejectedValueOnce(orchestratorError);

    const failingAi = new MockAIProvider(async () => {
      throw orchestratorError;
    });

    const sendSpy = vi.spyOn(whatsapp, 'sendText');

    const app = buildApp({
      db,
      aiProvider: failingAi,
      toolRegistry,
      whatsapp,
    });

    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: TEST_WABA_ID,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: TEST_PHONE_NUMBER_ID,
                  display_phone_number: '15550001111',
                },
                contacts: [{ profile: { name: 'Alice' }, wa_id: '15551239999' }],
                messages: [
                  {
                    from: '15551239999',
                    id: 'wamid.test_agent_failure_001',
                    timestamp: '1740000000',
                    type: 'text',
                    text: { body: 'What is the weather today?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const signature = generateSignature(payload, TEST_APP_SECRET);

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
      },
      payload,
    });

    // Fastify acknowledged Meta immediately with 200 OK
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('received');

    // Allow async execution to process
    await new Promise((r) => setTimeout(r, 60));

    // Verify agent_processing_failure was logged
    const errLogs = errorSpy.mock.calls.map((c) => c[0]);
    expect(
      errLogs.some(
        (l) =>
          typeof l === 'string' &&
          l.includes('agent_processing_failure') &&
          l.includes('inbound_wamid=wamid.test_agent_failure_001') &&
          l.includes('Database connection timeout during execution')
      )
    ).toBe(true);

    // Verify user-facing friendly error message was sent via WhatsApp
    expect(sendSpy).toHaveBeenCalledWith(
      '15551239999',
      expect.stringContaining('I encountered an unexpected issue while processing your request'),
      expect.anything()
    );

    await app.close();
  });

  // 8. Status-only webhook events
  it('8. Status-only webhook events return 200 ignored_non_message_event without invoking agent', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const whatsapp = new WhatsAppGateway({ appSecret: TEST_APP_SECRET });
    const aiProvider = new MockAIProvider(async () => ({ text: 'ok' }));

    const app = buildApp({
      db,
      aiProvider,
      toolRegistry,
      whatsapp,
    });

    const statusPayload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: TEST_WABA_ID,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: TEST_PHONE_NUMBER_ID,
                  display_phone_number: '15550001111',
                },
                statuses: [
                  {
                    id: 'wamid.HBgL_status_receipt',
                    status: 'delivered',
                    timestamp: '1740000000',
                    recipient_id: '15551239999',
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const signature = generateSignature(statusPayload, TEST_APP_SECRET);

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
      },
      payload: statusPayload,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ignored_non_message_event');

    await app.close();
  });

  // 9. Invalid webhook signatures
  it('9. Invalid webhook signatures are rejected with 401 Unauthorized', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const whatsapp = new WhatsAppGateway({ appSecret: TEST_APP_SECRET });
    const aiProvider = new MockAIProvider(async () => ({ text: 'ok' }));

    const app = buildApp({
      db,
      aiProvider,
      toolRegistry,
      whatsapp,
    });

    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=invalid_signature_hex_0000000000000000000000000000000000000000',
      },
      payload,
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('Unauthorized signature');

    await app.close();
  });

  // 10. Duplicate inbound webhook delivery
  it('10. Duplicate inbound webhook delivery is acknowledged with 200 but not re-executed', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const whatsapp = new WhatsAppGateway({
      appSecret: TEST_APP_SECRET,
    });

    const aiProvider = new MockAIProvider(async (messages) => ({
      text: `Echo: ${messages[messages.length - 1]?.content}`,
    }));

    const sendSpy = vi.spyOn(whatsapp, 'sendText');

    const app = buildApp({
      db,
      aiProvider,
      toolRegistry,
      whatsapp,
    });

    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: TEST_WABA_ID,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: TEST_PHONE_NUMBER_ID,
                  display_phone_number: '15550001111',
                },
                contacts: [{ profile: { name: 'Duplicate Tester' }, wa_id: '15551234444' }],
                messages: [
                  {
                    from: '15551234444',
                    id: 'wamid.test_dedup_regression_999',
                    timestamp: '1740000000',
                    type: 'text',
                    text: { body: 'First delivery of message' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const signature = generateSignature(payload, TEST_APP_SECRET);

    // First request
    const res1 = await app.inject({
      method: 'POST',
      url: '/webhook/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
      },
      payload,
    });
    expect(res1.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 60));
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Second duplicate request with exact same wamid
    const res2 = await app.inject({
      method: 'POST',
      url: '/webhook/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
      },
      payload,
    });
    expect(res2.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 60));
    // Reply was still sent ONLY once
    expect(sendSpy).toHaveBeenCalledTimes(1);

    await app.close();
  });

  // 11. Safe logging that never exposes secrets
  it('11. Safe logging redacts Meta access tokens, Bearer headers, and masks user phone numbers', () => {
    // Test token redactor
    const rawMetaToken = 'EAABtesttoken1234567890abcdefghijklmnopqrstuvwxyz';
    const rawBearerString = `Authorization: Bearer ${rawMetaToken}`;

    // Standalone Meta access token matches [REDACTED_META_TOKEN]
    expect(redactString(rawMetaToken)).toBe('[REDACTED_META_TOKEN]');

    // Bearer header with token is safely redacted and never contains the raw token
    const redactedBearer = redactString(rawBearerString);
    expect(redactedBearer).not.toContain(rawMetaToken);
    expect(redactedBearer).toContain('Bearer [REDACTED_TOKEN]');

    // Test phone number masking
    expect(maskPhoneNumber('15551234567')).toBe('155***4567');
    expect(maskPhoneNumber('+91 98765 43210')).toBe('919***3210');
    expect(maskPhoneNumber('123')).toBe('***');
    expect(maskPhoneNumber(null)).toBe('unknown');

    // Test credential cleaning
    expect(cleanCredential('  "EAAB123" \n')).toBe('EAAB123');
    expect(cleanCredential(" 'Bearer EAAB456' ")).toBe('EAAB456');
    expect(cleanPhoneNumberId(' "10998877" ')).toBe('10998877');
    expect(sanitizeRecipientPhone('+1 (555) 123-4567')).toBe('+15551234567');
    expect(sanitizeRecipientPhone('15551234567')).toBe('15551234567');
  });
});
