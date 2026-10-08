import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { verifyMetaSignature } from '../packages/security/src/signature.js';
import { WhatsAppGateway } from '../packages/whatsapp/src/gateway.js';
import { buildApp } from '../apps/api/src/app.js';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';

describe('WhatsApp Security & Raw-Body Webhook Verification Suite', () => {
  const APP_SECRET = 'meta_test_secret_key_12345';
  const RAW_PAYLOAD = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [],
  });

  function generateMetaSignature(body: string | Buffer, secret: string): string {
    const hash = crypto.createHmac('sha256', secret).update(body).digest('hex');
    return `sha256=${hash}`;
  }

  it('verifyMetaSignature accurately verifies valid HMAC-SHA256 signature', () => {
    const validHeader = generateMetaSignature(RAW_PAYLOAD, APP_SECRET);
    const result = verifyMetaSignature(RAW_PAYLOAD, validHeader, APP_SECRET);
    expect(result).toBe(true);
  });

  it('verifyMetaSignature fails when payload bytes are altered or whitespace changed', () => {
    const validHeader = generateMetaSignature(RAW_PAYLOAD, APP_SECRET);
    const alteredPayload = RAW_PAYLOAD + ' '; // Added space
    const result = verifyMetaSignature(alteredPayload, validHeader, APP_SECRET);
    expect(result).toBe(false);
  });

  it('verifyMetaSignature fails when secret is different', () => {
    const validHeader = generateMetaSignature(RAW_PAYLOAD, APP_SECRET);
    const result = verifyMetaSignature(RAW_PAYLOAD, validHeader, 'wrong_secret');
    expect(result).toBe(false);
  });

  it('verifyMetaSignature throws WebhookVerificationError on malformed header', () => {
    expect(() => {
      verifyMetaSignature(RAW_PAYLOAD, 'malformed-signature', APP_SECRET);
    }).toThrow('Malformed X-Hub-Signature-256');
  });

  it('WhatsAppGateway logs [WhatsApp Security] telemetry during verification', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const gateway = new WhatsAppGateway({ appSecret: APP_SECRET });

    const validHeader = generateMetaSignature(RAW_PAYLOAD, APP_SECRET);
    const isValid = gateway.verifyRequestSignature(RAW_PAYLOAD, validHeader);

    expect(isValid).toBe(true);

    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    expect(logCalls.some((l) => typeof l === 'string' && l.includes('[WhatsApp Security] signature_present=true'))).toBe(true);
    expect(logCalls.some((l) => typeof l === 'string' && l.includes('raw_body_length='))).toBe(true);
    expect(logCalls.some((l) => typeof l === 'string' && l.includes('[WhatsApp Security] signature_valid=true'))).toBe(true);

    consoleSpy.mockRestore();
  });

  it('Fastify route rejects invalid signature with 401 Unauthorized', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const whatsapp = new WhatsAppGateway({ appSecret: APP_SECRET });
    const mockAi: any = { name: 'mock', generateResponse: vi.fn() };

    const app = buildApp({
      db,
      aiProvider: mockAi,
      toolRegistry,
      whatsapp,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=invalidhex00000000000000000000000000000000000000000000000000000000',
      },
      payload: RAW_PAYLOAD,
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('Unauthorized signature');
  });

  it('Fastify route accepts valid signature and responds 200 OK', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const whatsapp = new WhatsAppGateway({ appSecret: APP_SECRET });
    const mockAi: any = { name: 'mock', generateResponse: vi.fn() };

    const app = buildApp({
      db,
      aiProvider: mockAi,
      toolRegistry,
      whatsapp,
    });

    const validSignature = generateMetaSignature(RAW_PAYLOAD, APP_SECRET);

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': validSignature,
      },
      payload: RAW_PAYLOAD,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ignored_non_message_event');
  });
});
