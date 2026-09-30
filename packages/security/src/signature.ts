import crypto from 'node:crypto';
import { WebhookVerificationError } from '@nexa/shared';

/**
 * Validates Meta WhatsApp Webhook X-Hub-Signature-256 header.
 * Uses timing-safe string comparison to prevent side-channel timing attacks.
 */
export function verifyMetaSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  appSecret: string | undefined
): boolean {
  if (!appSecret) {
    throw new WebhookVerificationError('WHATSAPP_APP_SECRET is not configured on server.');
  }

  if (!signatureHeader) {
    throw new WebhookVerificationError('Missing X-Hub-Signature-256 header in request.');
  }

  // Header format is sha256=<hash>
  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') {
    throw new WebhookVerificationError('Malformed X-Hub-Signature-256 header format.');
  }

  const expectedSignature = parts[1];
  const hmac = crypto.createHmac('sha256', appSecret);
  const calculatedSignature = hmac.update(rawBody).digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf-8');
  const calculatedBuffer = Buffer.from(calculatedSignature, 'utf-8');

  if (expectedBuffer.length !== calculatedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, calculatedBuffer);
}
