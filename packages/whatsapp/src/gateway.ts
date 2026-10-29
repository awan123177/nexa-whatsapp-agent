import { verifyMetaSignature } from '@nexa/security';
import {
  NormalizedIncomingMessage,
  cleanCredential,
  cleanPhoneNumberId,
} from '@nexa/shared';
import { WhatsAppPayloadParser } from './parser.js';
import { WhatsAppCloudApiClient, OutboundSendOptions } from './client.js';
import { WhatsAppMediaService } from './media-service.js';

export interface WhatsAppGatewayConfig {
  verifyToken?: string;
  appSecret?: string;
  accessToken?: string;
  phoneNumberId?: string;
  businessAccountId?: string;
  graphApiVersion?: string;
  allowSimulation?: boolean;
}

export class WhatsAppGateway {
  public readonly client: WhatsAppCloudApiClient;
  public readonly mediaService: WhatsAppMediaService;
  private verifyToken?: string;
  private appSecret?: string;

  constructor(config: WhatsAppGatewayConfig = {}) {
    this.verifyToken = cleanCredential(config.verifyToken);
    this.appSecret = cleanCredential(config.appSecret);
    this.client = new WhatsAppCloudApiClient({
      accessToken: config.accessToken,
      phoneNumberId: config.phoneNumberId,
      businessAccountId: config.businessAccountId,
      graphApiVersion: config.graphApiVersion,
      allowSimulation: config.allowSimulation,
    });
    this.mediaService = new WhatsAppMediaService(
      config.accessToken,
      config.graphApiVersion
    );
  }

  public getPhoneNumberId(): string | undefined {
    return this.client.phoneNumberId;
  }

  public getBusinessAccountId(): string | undefined {
    return this.client.businessAccountId;
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
    const token = cleanCredential(query['hub.verify_token']);
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
    const rawBodyLength = Buffer.isBuffer(rawBody)
      ? rawBody.length
      : Buffer.byteLength(rawBody || '', 'utf-8');
    const signaturePresent = Boolean(signatureHeader);
    console.log(
      `[WhatsApp Security] signature_present=${signaturePresent} raw_body_length=${rawBodyLength}`
    );

    if (!this.appSecret) {
      console.warn(
        '[WhatsAppGateway] WHATSAPP_APP_SECRET is not configured. Skipping HMAC signature check.'
      );
      console.log(`[WhatsApp Security] signature_valid=true`);
      return true;
    }

    try {
      const isValid = verifyMetaSignature(rawBody, signatureHeader, this.appSecret);
      console.log(`[WhatsApp Security] signature_valid=${isValid}`);
      return isValid;
    } catch (err: any) {
      console.error(`[WhatsAppGateway] Signature verification failed: ${err.message}`);
      console.log(`[WhatsApp Security] signature_valid=false`);
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
  async sendText(
    to: string,
    message: string,
    options?: OutboundSendOptions
  ): Promise<any> {
    return this.client.sendTextMessage(to, message, options);
  }

  /**
   * Sends an interactive confirmation prompt with Approve and Cancel buttons.
   */
  async sendApprovalRequest(
    to: string,
    prompt: string,
    approvalId: string,
    options?: OutboundSendOptions
  ): Promise<any> {
    return this.client.sendInteractiveButtons(
      to,
      prompt,
      [
        { id: `approve_${approvalId}`, title: 'Approve' },
        { id: `reject_${approvalId}`, title: 'Cancel' },
      ],
      options
    );
  }

  /**
   * Marks a WhatsApp message as read to acknowledge receipt.
   */
  async markRead(
    messageId: string,
    options?: OutboundSendOptions
  ): Promise<any> {
    return this.client.markAsRead(messageId, options);
  }

  /**
   * Uploads binary media to Meta WhatsApp Cloud API.
   */
  async uploadMedia(
    buffer: Buffer,
    mimeType: string,
    filename: string,
    options?: OutboundSendOptions
  ): Promise<{ mediaId: string }> {
    return this.client.uploadMedia(buffer, mimeType, filename, options);
  }

  /**
   * Sends an image message to a user WhatsApp number via Meta Cloud API.
   */
  async sendImageMessage(
    to: string,
    mediaIdOrUrl: string,
    caption?: string,
    options?: OutboundSendOptions
  ): Promise<any> {
    return this.client.sendImageMessage(to, mediaIdOrUrl, caption, options);
  }

  /**
   * Alias for sendImageMessage.
   */
  async sendImage(
    to: string,
    mediaIdOrUrl: string,
    caption?: string,
    options?: OutboundSendOptions
  ): Promise<any> {
    return this.client.sendImageMessage(to, mediaIdOrUrl, caption, options);
  }
}
