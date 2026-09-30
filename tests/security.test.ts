import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  redactString,
  redactObject,
  verifyMetaSignature,
  InMemoryRateLimiter,
  PermissionEngine,
} from '../packages/security/src/index.js';
import { SecurityViolationError } from '../packages/shared/src/index.js';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { createMemoryTools } from '../packages/tools/src/tools/memory-tools.js';

describe('Security & Privacy Suite', () => {
  describe('Secret Redactor', () => {
    it('should mask credit cards, CVVs, passwords, and API keys in strings', () => {
      const sensitiveText =
        'My card is 4532 1234 5678 9012, cvv: 123, and my password is SecretPassword123! with sk-1234567890abcdef1234567890';
      const redacted = redactString(sensitiveText);

      expect(redacted).not.toContain('4532 1234 5678 9012');
      expect(redacted).not.toContain('SecretPassword123!');
      expect(redacted).not.toContain('sk-1234567890abcdef1234567890');
      expect(redacted).toContain('[REDACTED_CARD]');
      expect(redacted).toContain('[REDACTED_PASSWORD]');
    });

    it('should mask sensitive keys in nested objects', () => {
      const payload = {
        user: 'alice',
        credentials: {
          accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          password: 'super-secret-password',
        },
        metadata: {
          note: 'regular note',
        },
      };

      const redacted = redactObject(payload) as any;
      expect(redacted.credentials.accessToken).toBe('[REDACTED_SENSITIVE_FIELD]');
      expect(redacted.credentials.password).toBe('[REDACTED_SENSITIVE_FIELD]');
      expect(redacted.metadata.note).toBe('regular note');
    });
  });

  describe('WhatsApp HMAC Signature Verification', () => {
    const appSecret = 'test_meta_app_secret_12345';
    const rawBody = JSON.stringify({ object: 'whatsapp_business_account' });

    it('should return true for valid HMAC-SHA256 signature', () => {
      const validHash = crypto
        .createHmac('sha256', appSecret)
        .update(rawBody)
        .digest('hex');
      const signatureHeader = `sha256=${validHash}`;

      const isValid = verifyMetaSignature(rawBody, signatureHeader, appSecret);
      expect(isValid).toBe(true);
    });

    it('should return false for invalid signature', () => {
      const invalidSignature = 'sha256=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
      const isValid = verifyMetaSignature(rawBody, invalidSignature, appSecret);
      expect(isValid).toBe(false);
    });
  });

  describe('Rate Limiter', () => {
    it('should allow requests within limit and block when exceeded', () => {
      const limiter = new InMemoryRateLimiter({ windowMs: 1000, maxRequests: 2 });
      const key = 'user_phone_1';

      expect(limiter.check(key).allowed).toBe(true);
      expect(limiter.check(key).allowed).toBe(true);
      expect(limiter.check(key).allowed).toBe(false);
    });
  });

  describe('Memory Credential Filtering', () => {
    it('should reject saving passwords or OTPs as long-term memories', async () => {
      const db = new InMemoryRepository();
      const user = await db.findOrCreateUserByPhone('+15551234567');
      const conversation = await db.getOrCreateActiveConversation(user.id);
      const [saveMemoryTool] = createMemoryTools(db);

      const context = {
        user,
        conversation,
        sourceChannel: 'whatsapp' as const,
      };

      await expect(
        saveMemoryTool.execute(
          {
            category: 'fact',
            key: 'account_password',
            value: 'mySecretPassword123',
            confidence: 1,
          },
          context
        )
      ).rejects.toThrow(SecurityViolationError);
    });
  });
});
