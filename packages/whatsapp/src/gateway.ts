import { verifyMetaSignature } from '@nexa/security';
import {
  NormalizedIncomingMessage,
  WebhookVerificationError,
} from '@nexa/shared';
import { WhatsAppPayloadParser } from './parser.js';
import { WhatsAppCloudApiClient } from './client.js';
import { WhatsAppMediaService } from './media-service.js';

export interface WhatsAppGatewayConfig {
  verifyToken?: string;
  appSecret?: string;
  accessToken?: string;
  phoneNumberId?: string;
}

export class WhatsAppGateway {
  public readonly client: WhatsAppCloudApiClient;
  public readonly mediaService: WhatsAppMediaService;
  private verifyToken?: string;
  private appSecret?: string;

  constructor(config: WhatsAppGatewayConfig = {}) {
    this.verifyToken = config.verifyToken;
    this.appSecret = config.appSecret;
    this.client = new WhatsAppCloudApiClient({
      accessToken: config.accessToken,
      phoneNumberId: config.phoneNumberId,
    });
    this.mediaService = new WhatsAppMediaService(config.accessToken);
  }

  /**
   * Verifies incoming GET challenge from Meta during webhook registration.
   */
  public verifyWebhookChallenge(query: {
    'hub.mode'?: string;
    'hub.verify_token'?: string;
    'hub.challenge'?: string;
  }): { isValid: boolean; challenge?: string } {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token === this.verifyToken && challenge) {
      return { isValid: true, challenge };
    }

    return { isValid: false };
  }

  /**
   * Verifies the authenticity of incoming Meta webhook POST requests using HMAC-SHA256.
   */
  public verifyRequestSignature(
    rawBody: string | Buffer,
    signatureHeader: string | undefined
  ): boolean {
    if (!this.appSecret) {
      console.warn(
        '[WhatsAppGateway] WHATSAPP_APP_SECRET is not configured. Skipping HMAC signature check.'
      );
      return true;
    }

    try {
      return verifyMetaSignature(rawBody, signatureHeader, this.appSecret);
    } catch (err: any) {
      console.error(`[WhatsAppGateway] Signature verification failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Normalizes incoming Meta webhook payload into standard messages.
   */
  public parseWebhook(body: any): NormalizedIncomingMessage[] {
    return WhatsAppPayloadParser.parse(body);
  }

  /**
   * Sends a text message to a user WhatsApp number.
   */
  async sendText(to: string, message: string): Promise<any> {
    return this.client.sendTextMessage(to, message);
  }

  /**
   * Sends an interactive confirmation prompt with Approve and Cancel buttons.
   */
  async sendApprovalRequest(
    to: string,
    prompt: string,
    approvalId: string
  ): Promise<any> {
    return this.client.sendInteractiveButtons(to, prompt, [
      { id: `approve_${approvalId}`, title: 'Approve' },
      { id: `reject_${approvalId}`, title: 'Cancel' },
    ]);
  }

  /**
   * Marks a WhatsApp message as read to acknowledge receipt.
   */
  async markRead(messageId: string): Promise<any> {
    return this.client.markAsRead(messageId);
  }

  /**
   * Uploads binary media to Meta WhatsApp Cloud API.
   */
  async uploadMedia(
    buffer: Buffer,
    mimeType: string,
    filename: string
  ): Promise<{ mediaId: string }> {
    return this.client.uploadMedia(buffer, mimeType, filename);
  }

  /**
   * Sends an image message to a user WhatsApp number via Meta Cloud API.
   */
  async sendImageMessage(
    to: string,
    mediaIdOrUrl: string,
    caption?: string
  ): Promise<any> {
    return this.client.sendImageMessage(to, mediaIdOrUrl, caption);
  }

  /**
   * Alias for sendImageMessage.
   */
  async sendImage(
    to: string,
    mediaIdOrUrl: string,
    caption?: string
  ): Promise<any> {
    return this.client.sendImageMessage(to, mediaIdOrUrl, caption);
  }
}
