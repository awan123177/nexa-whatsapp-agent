import { NexaError } from '@nexa/shared';

export interface DownloadedMedia {
  id: string;
  mimeType: string;
  buffer: Buffer;
  fileSizeBytes: number;
}

export interface IMediaService {
  downloadMedia(mediaId: string): Promise<DownloadedMedia>;
  transcribeAudio(media: DownloadedMedia): Promise<string>;
}

export class WhatsAppMediaService implements IMediaService {
  constructor(private accessToken?: string) {}

  async downloadMedia(mediaId: string): Promise<DownloadedMedia> {
    if (!this.accessToken) {
      throw new NexaError('Cannot download WhatsApp media: WHATSAPP_ACCESS_TOKEN not configured.', {
        code: 'MISSING_CREDENTIALS',
        statusCode: 500,
      });
    }

    // Step 1: Retrieve media URL
    const metaUrl = `https://graph.facebook.com/v21.0/${mediaId}`;
    const infoRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!infoRes.ok) {
      throw new NexaError(`Failed to fetch media metadata for ID ${mediaId}`, {
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
      throw new NexaError(`Failed to download binary media content from Meta CDN`, {
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
