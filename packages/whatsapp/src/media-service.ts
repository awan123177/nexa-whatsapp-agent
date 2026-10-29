import {
  NexaError,
  cleanCredential,
  cleanPhoneNumberId,
} from '@nexa/shared';

export interface DownloadedMedia {
  id: string;
  mimeType: string;
  buffer: Buffer;
  fileSizeBytes: number;
}

export interface IMediaService {
  downloadMedia(mediaId: string): Promise<DownloadedMedia>;
  transcribeAudio(media: DownloadedMedia): Promise<string>;
  uploadMedia(buffer: Buffer, mimeType: string, filename: string, phoneNumberId?: string): Promise<{ mediaId: string }>;
}

export class WhatsAppMediaService implements IMediaService {
  private accessToken?: string;
  private graphApiVersion: string;

  constructor(accessToken?: string, graphApiVersion = 'v21.0') {
    this.accessToken = cleanCredential(accessToken);
    this.graphApiVersion = cleanCredential(graphApiVersion) || 'v21.0';
  }

  async downloadMedia(mediaId: string): Promise<DownloadedMedia> {
    if (!this.accessToken) {
      throw new NexaError('Cannot download WhatsApp media: WHATSAPP_ACCESS_TOKEN not configured.', {
        code: 'MISSING_CREDENTIALS',
        statusCode: 500,
      });
    }

    // Step 1: Retrieve media URL
    const metaUrl = `https://graph.facebook.com/${this.graphApiVersion}/${mediaId}`;
    const infoRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!infoRes.ok) {
      const rawText = await infoRes.text();
      let metaErr: any;
      try { metaErr = JSON.parse(rawText)?.error; } catch { metaErr = { message: rawText }; }
      console.error(
        `[WhatsApp Media] Failed to fetch media metadata: id=${mediaId} status=${infoRes.status} code=${metaErr?.code} message="${metaErr?.message}" fbtrace_id=${metaErr?.fbtrace_id}`
      );
      throw new NexaError(`Failed to fetch media metadata for ID ${mediaId}: ${metaErr?.message || infoRes.statusText}`, {
        code: 'MEDIA_FETCH_FAILED',
        statusCode: infoRes.status,
      });
    }

    const info = (await infoRes.json()) as any;
    const downloadUrl = info.url;
    const mimeType = info.mime_type;

    // Step 2: Download raw binary bytes
    const mediaRes = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!mediaRes.ok) {
      console.error(
        `[WhatsApp Media] Failed to download media bytes: id=${mediaId} status=${mediaRes.status}`
      );
      throw new NexaError(`Failed to download binary media content from Meta CDN: ${mediaRes.statusText}`, {
        code: 'MEDIA_DOWNLOAD_FAILED',
        statusCode: mediaRes.status,
      });
    }

    const arrayBuffer = await mediaRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      id: mediaId,
      mimeType,
      buffer,
      fileSizeBytes: buffer.length,
    };
  }

  async uploadMedia(
    buffer: Buffer,
    mimeType: string,
    filename: string,
    phoneNumberId?: string
  ): Promise<{ mediaId: string }> {
    if (!this.accessToken) {
      throw new NexaError('Cannot upload WhatsApp media: WHATSAPP_ACCESS_TOKEN not configured.', {
        code: 'MISSING_CREDENTIALS',
        statusCode: 500,
      });
    }

    const cleanId = cleanPhoneNumberId(phoneNumberId);
    if (!cleanId) {
      throw new NexaError('Cannot upload WhatsApp media: phoneNumberId is required.', {
        code: 'MISSING_PHONE_NUMBER_ID',
        statusCode: 400,
      });
    }

    const url = `https://graph.facebook.com/${this.graphApiVersion}/${cleanId}/media`;
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

    const rawText = await res.text();
    let data: any;
    try { data = JSON.parse(rawText); } catch { data = { raw: rawText }; }

    if (!res.ok) {
      const metaErr = data?.error;
      console.error(
        `[WhatsApp Media] Failed to upload media: filename=${filename} status=${res.status} code=${metaErr?.code} message="${metaErr?.message}" fbtrace_id=${metaErr?.fbtrace_id}`
      );
      throw new NexaError(`Failed to upload media to WhatsApp: ${metaErr?.message || res.statusText}`, {
        code: 'MEDIA_UPLOAD_FAILED',
        statusCode: res.status,
      });
    }

    return { mediaId: data.id };
  }

  async transcribeAudio(_media: DownloadedMedia): Promise<string> {
    // Clean interface placeholder: Ready for Whisper / Gemini Audio API
    throw new NexaError(
      'Audio voice note transcription provider is not configured yet. Please send your message as text.',
      {
        code: 'TRANSCRIPTION_NOT_CONFIGURED',
        statusCode: 501,
        userFacingMessage: 'Voice notes will be supported soon! Please send your request as a text message for now.',
      }
    );
  }
}
