import {
  WhatsAppWebhookPayload,
  NormalizedIncomingMessage,
} from '@nexa/shared';

export class WhatsAppPayloadParser {
  /**
   * Parses raw Meta Cloud API webhook JSON and extracts normalized user messages.
   * Gracefully ignores delivery receipts (statuses), system changes, or empty arrays.
   */
  public static parse(payload: any): NormalizedIncomingMessage[] {
    if (!payload || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
      return [];
    }

    const messages: NormalizedIncomingMessage[] = [];

    for (const entry of payload.entry) {
      if (!Array.isArray(entry.changes)) continue;

      for (const change of entry.changes) {
        if (change.field !== 'messages' || !change.value) continue;

        const val = change.value;
        const phoneNumberId = val.metadata?.phone_number_id || '';
        const contacts = val.contacts || [];
        const rawMessages = val.messages || [];

        // Map contact profiles
        const contactMap = new Map<string, string>();
        for (const contact of contacts) {
          if (contact.wa_id && contact.profile?.name) {
            contactMap.set(contact.wa_id, contact.profile.name);
          }
        }

        for (const msg of rawMessages) {
          const senderWaId = msg.from;
          const senderName = contactMap.get(senderWaId) || senderWaId;

          const normalized: NormalizedIncomingMessage = {
            whatsappMessageId: msg.id,
            senderPhoneNumber: senderWaId,
            senderName,
            phoneNumberId,
            type: 'unsupported',
            rawPayload: msg,
          };

          if (msg.type === 'text' && msg.text?.body) {
            normalized.type = 'text';
            normalized.text = msg.text.body.trim();
          } else if (msg.type === 'interactive' && msg.interactive) {
            normalized.type = 'interactive';
            if (msg.interactive.button_reply) {
              normalized.text = msg.interactive.button_reply.title;
              normalized.interactiveSelection = {
                id: msg.interactive.button_reply.id,
                title: msg.interactive.button_reply.title,
              };
            } else if (msg.interactive.list_reply) {
              normalized.text = msg.interactive.list_reply.title;
              normalized.interactiveSelection = {
                id: msg.interactive.list_reply.id,
                title: msg.interactive.list_reply.title,
              };
            }
          } else if (msg.type === 'image' && msg.image) {
            normalized.type = 'image';
            normalized.text = msg.image.caption || '';
            normalized.media = {
              id: msg.image.id,
              mimeType: msg.image.mime_type,
              caption: msg.image.caption,
            };
          } else if (msg.type === 'audio' && msg.audio) {
            normalized.type = 'audio';
            normalized.media = {
              id: msg.audio.id,
              mimeType: msg.audio.mime_type,
            };
          } else if (msg.type === 'document' && msg.document) {
            normalized.type = 'document';
            normalized.text = msg.document.caption || '';
            normalized.media = {
              id: msg.document.id,
              mimeType: msg.document.mime_type,
              caption: msg.document.caption,
              filename: msg.document.filename,
            };
          }

          messages.push(normalized);
        }
      }
    }

    return messages;
  }
}
