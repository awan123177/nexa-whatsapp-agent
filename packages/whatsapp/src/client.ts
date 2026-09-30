import { NexaError } from '@nexa/shared';

export interface WhatsAppClientOptions {
  accessToken?: string;
  phoneNumberId?: string;
  graphApiVersion?: string;
}

export class WhatsAppCloudApiClient {
  private accessToken?: string;
  private phoneNumberId?: string;
  private baseUrl: string;

  constructor(options: WhatsAppClientOptions = {}) {
    this.accessToken = options.accessToken;
    this.phoneNumberId = options.phoneNumberId;
    const version = options.graphApiVersion || 'v21.0';
    this.baseUrl = `https://graph.facebook.com/${version}`;
  }

  public isConfigured(): boolean {
    return Boolean(this.accessToken && this.phoneNumberId);
  }

  async sendTextMessage(to: string, text: string): Promise<any> {
    if (!this.isConfigured()) {
      console.warn(
        `[WhatsApp Client] No credentials configured. Simulating outgoing message to ${to}: "${text.slice(0, 80)}..."`
      );
      return { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id: `sim_${Date.now()}` }] };
    }

    const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: {
        preview_url: false,
        body: text,
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new NexaError(`WhatsApp API send error: ${JSON.stringify(data)}`, {
        code: 'WHATSAPP_API_ERROR',
        statusCode: res.status,
      });
    }

    return data;
  }

  async uploadMedia(
    buffer: Buffer,
    mimeType: string,
    filename: string
  ): Promise<{ mediaId: string }> {
    if (!this.isConfigured()) {
      console.warn(
        `[WhatsApp Client] No credentials configured. Simulating media upload for ${filename} (${mimeType})`
      );
      return { mediaId: `sim_media_${Date.now()}` };
    }

    const url = `${this.baseUrl}/${this.phoneNumberId}/media`;
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
    formData.append('type', mimeType);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: formData,
    });

    const data = (await res.json()) as any;
    if (!res.ok) {
      throw new NexaError(`WhatsApp API media upload error: ${JSON.stringify(data)}`, {
        code: 'WHATSAPP_MEDIA_UPLOAD_FAILED',
        statusCode: res.status,
      });
    }

    return { mediaId: data.id };
  }

  async sendImageMessage(
    to: string,
    mediaIdOrUrl: string,
    caption?: string
  ): Promise<any> {
    if (!this.isConfigured()) {
      console.warn(
        `[WhatsApp Client] No credentials configured. Simulating outgoing image to ${to}: media=${mediaIdOrUrl}, caption="${caption || ''}"`
      );
      return {
        messaging_product: 'whatsapp',
        contacts: [{ input: to, wa_id: to }],
        messages: [{ id: `sim_img_${Date.now()}` }],
      };
    }

    const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
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
      to,
      type: 'image',
      image: imagePayload,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new NexaError(`WhatsApp API send image error: ${JSON.stringify(data)}`, {
        code: 'WHATSAPP_API_ERROR',
        statusCode: res.status,
      });
    }

    return data;
  }

  async sendInteractiveButtons(
    to: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>
  ): Promise<any> {
    if (!this.isConfigured()) {
      console.warn(`[WhatsApp Client] Simulating interactive buttons to ${to}: ${bodyText}`);
      return { messaging_product: 'whatsapp', messages: [{ id: `sim_${Date.now()}` }] };
    }

    const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
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

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new NexaError(`WhatsApp interactive message error: ${JSON.stringify(data)}`, {
        code: 'WHATSAPP_API_ERROR',
        statusCode: res.status,
      });
    }

    return data;
  }

  async markAsRead(messageId: string): Promise<any> {
    if (!this.isConfigured()) return { success: true };

    const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
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
      return await res.json();
    } catch (err: any) {
      console.warn(`[WhatsApp Client] Failed to mark message ${messageId} as read: ${err.message}`);
      return null;
    }
  }
}
