import { describe, it, expect, vi } from 'vitest';
import { WhatsAppPayloadParser } from '../packages/whatsapp/src/parser.js';
import { WhatsAppMediaService } from '../packages/whatsapp/src/media-service.js';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';
import { GeminiProvider } from '../packages/ai/src/gemini-provider.js';
import { buildApp } from '../apps/api/src/app.js';
import { WhatsAppGateway } from '../packages/whatsapp/src/gateway.js';

describe('Voice Notes End-to-End Suite', () => {
  it('WhatsAppPayloadParser correctly parses audio message payload', () => {
    const rawMetaPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15551234567',
                  phone_number_id: 'PHONE_NUMBER_ID',
                },
                contacts: [
                  {
                    profile: { name: 'Awan' },
                    wa_id: '919876543210',
                  },
                ],
                messages: [
                  {
                    from: '919876543210',
                    id: 'wamid.HBgMOTExOTg3NjU0MzIxMBUCABIYFjNBRjFBQzI5M0Q0',
                    timestamp: '1740000000',
                    type: 'audio',
                    audio: {
                      id: 'media_audio_id_12345',
                      mime_type: 'audio/ogg; codecs=opus',
                    },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const parsed = WhatsAppPayloadParser.parse(rawMetaPayload);
    expect(parsed.length).toBe(1);
    expect(parsed[0].type).toBe('audio');
    expect(parsed[0].senderPhoneNumber).toBe('919876543210');
    expect(parsed[0].senderName).toBe('Awan');
    expect(parsed[0].media?.id).toBe('media_audio_id_12345');
    expect(parsed[0].media?.mimeType).toBe('audio/ogg; codecs=opus');
  });

  it('AgentOrchestrator receives audioBuffer and supplies multimodal audio to AIProvider', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });

    let capturedMessages: any[] = [];
    let capturedOptions: any = null;

    const mockAi: any = {
      name: 'gemini',
      generateResponse: vi.fn(async (messages: any[], options: any) => {
        capturedMessages = messages;
        capturedOptions = options;
        return {
          text: 'I heard your voice note! You asked about tomorrow schedule.',
        };
      }),
    };

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    const dummyAudioBytes = Buffer.from('RIFF....WAVEfmt....data....fakeoggopus');
    const result = await orchestrator.processMessage({
      phoneNumber: '+919876543210',
      name: 'Awan',
      text: '',
      audioBuffer: dummyAudioBytes,
      audioMimeType: 'audio/ogg; codecs=opus',
      whatsappMessageId: 'wamid.voice1',
    });

    expect(result.replyText).toContain('I heard your voice note');
    expect(capturedMessages.length).toBeGreaterThan(0);

    const userTurn = capturedMessages.find((m) => m.role === 'user');
    expect(userTurn).toBeDefined();
    expect(userTurn.media).toBeDefined();
    expect(userTurn.media.mimeType).toBe('audio/ogg; codecs=opus');
    expect(userTurn.media.data).toBe(dummyAudioBytes.toString('base64'));

    expect(capturedOptions.currentUserMedia).toBeDefined();
    expect(capturedOptions.currentUserMedia.mimeType).toBe('audio/ogg; codecs=opus');
  });

  it('GeminiProvider converts user AIMediaPart to Gemini inlineData part', async () => {
    let capturedGenerateContentParams: any = null;

    const dummyAudioBuffer = Buffer.from('mock-binary-audio-ogg-opus');
    const dummyBase64 = dummyAudioBuffer.toString('base64');

    const provider = new GeminiProvider({
      apiKey: 'test-api-key',
      defaultModel: 'gemini-3.5-flash-lite',
      generateContentFn: async (params: any) => {
        capturedGenerateContentParams = params;
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: 'Understood your voice message clearly!',
                  },
                ],
              },
            },
          ],
        };
      },
    });

    const response = await provider.generateResponse([
      {
        role: 'user',
        content: 'Please process this voice message.',
        media: {
          mimeType: 'audio/ogg; codecs=opus',
          data: dummyBase64,
        },
      },
    ]);

    expect(response.text).toBe('Understood your voice message clearly!');
    expect(capturedGenerateContentParams).toBeDefined();
    expect(capturedGenerateContentParams.contents.length).toBe(1);

    const userContents = capturedGenerateContentParams.contents[0];
    expect(userContents.role).toBe('user');
    expect(userContents.parts.length).toBe(2);

    const inlineDataPart = userContents.parts.find((p: any) => p.inlineData);
    expect(inlineDataPart).toBeDefined();
    expect(inlineDataPart.inlineData.mimeType).toBe('audio/ogg; codecs=opus');
    expect(inlineDataPart.inlineData.data).toBe(dummyBase64);
  });

  it('Webhook route handles audio webhook, downloads media, and responds via WhatsApp', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });

    const mockAi: any = {
      name: 'gemini',
      generateResponse: vi.fn(async () => ({
        text: 'Hello from voice response!',
      })),
    };

    const mockWhatsapp: any = new WhatsAppGateway();
    const sentMessages: { to: string; text: string }[] = [];
    mockWhatsapp.sendText = vi.fn(async (to: string, text: string) => {
      sentMessages.push({ to, text });
      return { success: true };
    });
    mockWhatsapp.markRead = vi.fn(async () => ({ success: true }));

    const dummyAudioBuffer = Buffer.from('mock-audio-data-test');
    mockWhatsapp.mediaService.downloadMedia = vi.fn(async (mediaId: string) => {
      expect(mediaId).toBe('audio_media_999');
      return {
        id: mediaId,
        mimeType: 'audio/ogg; codecs=opus',
        buffer: dummyAudioBuffer,
        fileSizeBytes: dummyAudioBuffer.length,
      };
    });

    const app = buildApp({
      db,
      aiProvider: mockAi,
      toolRegistry,
      whatsapp: mockWhatsapp,
    });

    const audioPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                contacts: [{ wa_id: '919876543210', profile: { name: 'Awan' } }],
                messages: [
                  {
                    from: '919876543210',
                    id: 'wamid.audio.test.1',
                    type: 'audio',
                    audio: {
                      id: 'audio_media_999',
                      mime_type: 'audio/ogg; codecs=opus',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/whatsapp',
      payload: audioPayload,
    });

    expect(res.statusCode).toBe(200);

    // Wait for async worker
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockWhatsapp.mediaService.downloadMedia).toHaveBeenCalledWith('audio_media_999');
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toBe('Hello from voice response!');
  });
});
