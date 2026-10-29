import {
  NexaError,
  cleanCredential,
  cleanPhoneNumberId,
  sanitizeRecipientPhone,
  maskPhoneNumber,
} from '@nexa/shared';

export interface WhatsAppClientOptions {
  accessToken?: string;
  phoneNumberId?: string;
  businessAccountId?: string;
  graphApiVersion?: string;
  allowSimulation?: boolean;
}

export interface OutboundSendOptions {
  phoneNumberId?: string;
  correlationId?: string;
}

export class WhatsAppCloudApiClient {
  public readonly accessToken?: string;
  public readonly phoneNumberId?: string;
  public readonly businessAccountId?: string;
  public readonly graphApiVersion: string;
  public readonly allowSimulation: boolean;
  private readonly baseUrl: string;

  constructor(options: WhatsAppClientOptions = {}) {
    this.accessToken = cleanCredential(options.accessToken);
    this.phoneNumberId = cleanPhoneNumberId(options.phoneNumberId);
    this.businessAccountId = cleanPhoneNumberId(options.businessAccountId);
    this.graphApiVersion = cleanCredential(options.graphApiVersion) || 'v21.0';
    this.baseUrl = `https://graph.facebook.com/${this.graphApiVersion}`;

    // Simulation is NEVER allowed in production to prevent silent delivery claims.
    // In test/dev, simulation is permitted if explicitly enabled or if credentials are omitted.
    const isProd = process.env.NODE_ENV === 'production';
    if (isProd) {
      this.allowSimulation = false;
    } else {
      this.allowSimulation = options.allowSimulation ?? !this.isConfigured();
    }
  }

  public isConfigured(): boolean {
    return Boolean(this.accessToken && this.phoneNumberId);
  }

  private resolvePhoneNumberId(overrideId?: string, correlationId?: string): string {
    const targetId = overrideId ? cleanPhoneNumberId(overrideId) : this.phoneNumberId;

    if (!targetId) {
      throw new NexaError('WhatsApp phone number ID is missing. WHATSAPP_PHONE_NUMBER_ID is required to send messages.', {
        code: 'MISSING_PHONE_NUMBER_ID',
        statusCode: 400,
      });
    }

    if (overrideId && this.phoneNumberId && overrideId !== this.phoneNumberId) {
      console.warn(
        `[WhatsApp Client] Warning: Configured PHONE_NUMBER_ID (${this.phoneNumberId}) differs from override (${overrideId}). Using ${targetId}. correlation_id=${correlationId || 'none'}`
      );
    }

    if (this.businessAccountId && targetId === this.businessAccountId) {
      console.warn(
        `[WhatsApp Client] Warning: Target phoneNumberId (${targetId}) matches WHATSAPP_BUSINESS_ACCOUNT_ID. WhatsApp Cloud API /messages requires a Phone Number ID, not a WABA ID. correlation_id=${correlationId || 'none'}`
      );
    }

    return targetId;
  }

  private ensureCredentials(correlationId?: string): void {
    if (!this.accessToken) {
      if (this.allowSimulation) return;
      throw new NexaError('WhatsApp access token is missing. WHATSAPP_ACCESS_TOKEN is required to send messages.', {
        code: 'MISSING_ACCESS_TOKEN',
        statusCode: 500,
      });
    }
  }

  private async handleApiResponse(
    res: Response,
    correlationId: string,
    actionDesc: string
  ): Promise<any> {
    let data: any;
    if (typeof res.text === 'function') {
      const rawText = await res.text();
      try {
        data = JSON.parse(rawText);
      } catch {
        data = { raw: rawText };
      }
    } else if (typeof (res as any).json === 'function') {
      data = await (res as any).json();
    } else {
      data = {};
    }

    if (!res.ok) {
      const metaError = data?.error;
      const errorCode = metaError?.code;
      const errorSubcode = metaError?.error_subcode;
      const errorType = metaError?.type;
      const errorMessage = metaError?.message || res.statusText || 'Unknown Meta API error';
      const fbtraceId = metaError?.fbtrace_id;
      const details = metaError?.error_data?.details;

      console.error(
        `[WhatsApp Client] Meta API error during ${actionDesc}: correlation_id=${correlationId} http_status=${res.status} error_code=${errorCode || 'none'} error_subcode=${errorSubcode || 'none'} type=${errorType || 'none'} message="${errorMessage}" fbtrace_id=${fbtraceId || 'none'}${details ? ` details="${details}"` : ''}`
      );

      let nexaErrorCode = 'WHATSAPP_API_ERROR';
      if (errorCode === 100) {
        nexaErrorCode = 'WHATSAPP_OAUTH_ERROR';
      } else if (errorCode === 190) {
        nexaErrorCode = 'WHATSAPP_TOKEN_EXPIRED';
      }

      const err = new NexaError(
        `WhatsApp API error during ${actionDesc} (HTTP ${res.status}, code ${errorCode || 'unknown'}): ${errorMessage}`,
        {
          code: nexaErrorCode,
          statusCode: res.status,
        }
      );
      (err as any).metaError = {
        httpStatus: res.status,
        code: errorCode,
        subcode: errorSubcode,
        type: errorType,
        message: errorMessage,
        fbtraceId,
        details,
      };
      throw err;
    }

    return data;
  }

  private verifyMessageAccepted(data: any, correlationId: string, recipientMasked: string): string {
    const messageId = data?.messages?.[0]?.id;
    if (!messageId) {
      console.warn(
        `[WhatsApp Client] Meta returned HTTP 200 but did not provide a confirmed message ID: correlation_id=${correlationId}`
      );
      throw new NexaError('Meta accepted request but did not return a confirmed message ID', {
        code: 'WHATSAPP_UNCONFIRMED_DELIVERY',
        statusCode: 502,
      });
    }

    console.log(
      `[WhatsApp Client] Outbound message accepted by Meta: correlation_id=${correlationId} outbound_wamid=${messageId} recipient=${recipientMasked}`
    );
    return messageId;
  }

  async sendTextMessage(
    to: string,
    text: string,
    options?: OutboundSendOptions
  ): Promise<any> {
    const correlationId = options?.correlationId || `req_${Date.now()}`;
    const cleanTo = sanitizeRecipientPhone(to);
    if (!cleanTo) {
      throw new NexaError(`Invalid recipient phone number: "${to}". Must contain digits with country code.`, {
        code: 'INVALID_RECIPIENT_PHONE',
        statusCode: 400,
      });
    }

    const maskedPhone = maskPhoneNumber(cleanTo);

    if (!this.accessToken || (!this.phoneNumberId && !options?.phoneNumberId)) {
      if (this.allowSimulation) {
        console.warn(
          `[WhatsApp Client] No credentials configured. Simulating outgoing message: correlation_id=${correlationId} to=${maskedPhone}`
        );
        return {
          messaging_product: 'whatsapp',
          contacts: [{ input: cleanTo, wa_id: cleanTo }],
          messages: [{ id: `sim_${Date.now()}` }],
          simulated: true,
        };
      }
    }

    const targetPhoneNumberId = this.resolvePhoneNumberId(options?.phoneNumberId, correlationId);
    this.ensureCredentials(correlationId);

    const url = `${this.baseUrl}/${targetPhoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'text',
      text: {
        preview_url: false,
        body: text,
      },
    };

    console.log(
      `[WhatsApp Client] Outbound send attempt: correlation_id=${correlationId} recipient=${maskedPhone} phone_number_id=${targetPhoneNumberId} type=text`
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (networkErr: any) {
      console.error(
        `[WhatsApp Client] Network failure: correlation_id=${correlationId} error="${networkErr.message}"`
      );
      throw new NexaError(`WhatsApp API network failure: ${networkErr.message}`, {
        code: 'WHATSAPP_NETWORK_ERROR',
        statusCode: 503,
      });
    }

    const data = await this.handleApiResponse(res, correlationId, 'sendTextMessage');
    this.verifyMessageAccepted(data, correlationId, maskedPhone);
    return data;
  }

  async uploadMedia(
    buffer: Buffer,
    mimeType: string,
    filename: string,
    options?: OutboundSendOptions
  ): Promise<{ mediaId: string }> {
    const correlationId = options?.correlationId || `req_${Date.now()}`;

    if (!this.accessToken || (!this.phoneNumberId && !options?.phoneNumberId)) {
      if (this.allowSimulation) {
        console.warn(
          `[WhatsApp Client] No credentials configured. Simulating media upload: correlation_id=${correlationId} filename=${filename}`
        );
        return { mediaId: `sim_media_${Date.now()}` };
      }
    }

    const targetPhoneNumberId = this.resolvePhoneNumberId(options?.phoneNumberId, correlationId);
    this.ensureCredentials(correlationId);

    const url = `${this.baseUrl}/${targetPhoneNumberId}/media`;
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
    formData.append('type', mimeType);

    console.log(
      `[WhatsApp Client] Upload media attempt: correlation_id=${correlationId} filename=${filename} mime=${mimeType} phone_number_id=${targetPhoneNumberId}`
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: formData,
      });
    } catch (networkErr: any) {
      console.error(
        `[WhatsApp Client] Network failure uploading media: correlation_id=${correlationId} error="${networkErr.message}"`
      );
      throw new NexaError(`WhatsApp API media upload network failure: ${networkErr.message}`, {
        code: 'WHATSAPP_NETWORK_ERROR',
        statusCode: 503,
      });
    }

    const data = await this.handleApiResponse(res, correlationId, 'uploadMedia');
    if (!data.id) {
      throw new NexaError('WhatsApp media upload succeeded but returned no media ID', {
        code: 'WHATSAPP_MEDIA_UPLOAD_FAILED',
        statusCode: 502,
      });
    }

    console.log(
      `[WhatsApp Client] Media upload success: correlation_id=${correlationId} mediaId=${data.id}`
    );
    return { mediaId: data.id };
  }

  async sendImageMessage(
    to: string,
    mediaIdOrUrl: string,
    caption?: string,
    options?: OutboundSendOptions
  ): Promise<any> {
    const correlationId = options?.correlationId || `req_${Date.now()}`;
    const cleanTo = sanitizeRecipientPhone(to);
    if (!cleanTo) {
      throw new NexaError(`Invalid recipient phone number: "${to}". Must contain digits with country code.`, {
        code: 'INVALID_RECIPIENT_PHONE',
        statusCode: 400,
      });
    }

    const maskedPhone = maskPhoneNumber(cleanTo);

    if (!this.accessToken || (!this.phoneNumberId && !options?.phoneNumberId)) {
      if (this.allowSimulation) {
        console.warn(
          `[WhatsApp Client] No credentials configured. Simulating outgoing image: correlation_id=${correlationId} to=${maskedPhone}`
        );
        return {
          messaging_product: 'whatsapp',
          contacts: [{ input: cleanTo, wa_id: cleanTo }],
          messages: [{ id: `sim_img_${Date.now()}` }],
          simulated: true,
        };
      }
    }

    const targetPhoneNumberId = this.resolvePhoneNumberId(options?.phoneNumberId, correlationId);
    this.ensureCredentials(correlationId);

    const url = `${this.baseUrl}/${targetPhoneNumberId}/messages`;
    const isUrl = mediaIdOrUrl.startsWith('http://') || mediaIdOrUrl.startsWith('https://');
    const imagePayload: Record<string, string> = isUrl
      ? { link: mediaIdOrUrl }
      : { id: mediaIdOrUrl };

    if (caption) {
      imagePayload.caption = caption;
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'image',
      image: imagePayload,
    };

    console.log(
      `[WhatsApp Client] Outbound send attempt: correlation_id=${correlationId} recipient=${maskedPhone} phone_number_id=${targetPhoneNumberId} type=image`
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (networkErr: any) {
      console.error(
        `[WhatsApp Client] Network failure: correlation_id=${correlationId} error="${networkErr.message}"`
      );
      throw new NexaError(`WhatsApp API network failure: ${networkErr.message}`, {
        code: 'WHATSAPP_NETWORK_ERROR',
        statusCode: 503,
      });
    }

    const data = await this.handleApiResponse(res, correlationId, 'sendImageMessage');
    this.verifyMessageAccepted(data, correlationId, maskedPhone);
    return data;
  }

  async sendInteractiveButtons(
    to: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>,
    options?: OutboundSendOptions
  ): Promise<any> {
    const correlationId = options?.correlationId || `req_${Date.now()}`;
    const cleanTo = sanitizeRecipientPhone(to);
    if (!cleanTo) {
      throw new NexaError(`Invalid recipient phone number: "${to}". Must contain digits with country code.`, {
        code: 'INVALID_RECIPIENT_PHONE',
        statusCode: 400,
      });
    }

    const maskedPhone = maskPhoneNumber(cleanTo);

    if (!this.accessToken || (!this.phoneNumberId && !options?.phoneNumberId)) {
      if (this.allowSimulation) {
        console.warn(
          `[WhatsApp Client] No credentials configured. Simulating interactive buttons: correlation_id=${correlationId} to=${maskedPhone}`
        );
        return {
          messaging_product: 'whatsapp',
          contacts: [{ input: cleanTo, wa_id: cleanTo }],
          messages: [{ id: `sim_${Date.now()}` }],
          simulated: true,
        };
      }
    }

    const targetPhoneNumberId = this.resolvePhoneNumberId(options?.phoneNumberId, correlationId);
    this.ensureCredentials(correlationId);

    const url = `${this.baseUrl}/${targetPhoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.slice(0, 3).map((btn) => ({
            type: 'reply',
            reply: {
              id: btn.id,
              title: btn.title.slice(0, 20),
            },
          })),
        },
      },
    };

    console.log(
      `[WhatsApp Client] Outbound send attempt: correlation_id=${correlationId} recipient=${maskedPhone} phone_number_id=${targetPhoneNumberId} type=interactive`
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (networkErr: any) {
      console.error(
        `[WhatsApp Client] Network failure: correlation_id=${correlationId} error="${networkErr.message}"`
      );
      throw new NexaError(`WhatsApp API network failure: ${networkErr.message}`, {
        code: 'WHATSAPP_NETWORK_ERROR',
        statusCode: 503,
      });
    }

    const data = await this.handleApiResponse(res, correlationId, 'sendInteractiveButtons');
    this.verifyMessageAccepted(data, correlationId, maskedPhone);
    return data;
  }

  async markAsRead(
    messageId: string,
    options?: OutboundSendOptions
  ): Promise<any> {
    const correlationId = options?.correlationId || `req_${Date.now()}`;
    if (!this.accessToken) {
      return { success: true, simulated: true };
    }

    let targetPhoneNumberId: string;
    try {
      targetPhoneNumberId = this.resolvePhoneNumberId(options?.phoneNumberId, correlationId);
    } catch {
      return null;
    }

    const url = `${this.baseUrl}/${targetPhoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const rawText = typeof res.text === 'function' ? await res.text() : JSON.stringify(await (res as any).json());
        let parsed: any;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = { raw: rawText };
        }
        const err = parsed?.error;
        console.warn(
          `[WhatsApp Client] Failed to mark message ${messageId} as read: status=${res.status} code=${err?.code} subcode=${err?.error_subcode} message="${err?.message}" fbtrace_id=${err?.fbtrace_id} correlation_id=${correlationId}`
        );
        return null;
      }
      return typeof (res as any).json === 'function' ? await (res as any).json() : { success: true };
    } catch (err: any) {
      console.warn(
        `[WhatsApp Client] Failed to mark message ${messageId} as read: ${err.message} correlation_id=${correlationId}`
      );
      return null;
    }
  }
}
