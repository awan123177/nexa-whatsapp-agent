import { describe, it, expect } from 'vitest';
import { WhatsAppGateway, WhatsAppPayloadParser } from '../packages/whatsapp/src/index.js';

describe('WhatsApp Gateway & Webhook Suite', () => {
  const verifyToken = 'nexa_webhook_secret_verify_token_777';
  const appSecret = 'meta_app_secret_test';
  const gateway = new WhatsAppGateway({
    verifyToken,
    appSecret,
  });

  describe('GET Webhook Verification', () => {
    it('should verify challenge with valid token and mode', () => {
      const query = {
        'hub.mode': 'subscribe',
        'hub.verify_token': verifyToken,
        'hub.challenge': '11559933',
      };

      const result = gateway.verifyWebhookChallenge(query);
      expect(result.isValid).toBe(true);
      expect(result.challenge).toBe('11559933');
    });

    it('should reject invalid verify token', () => {
      const query = {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong_token',
        'hub.challenge': '11559933',
      };

      const result = gateway.verifyWebhookChallenge(query);
      expect(result.isValid).toBe(false);
    });
  });

  describe('POST Webhook Payload Parsing', () => {
    it('should parse incoming text messages correctly', () => {
      const samplePayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_123',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15550001111',
                    phone_number_id: 'PHONE_ID_999',
                  },
                  contacts: [
                    {
                      profile: { name: 'John Doe' },
                      wa_id: '15551234567',
                    },
                  ],
                  messages: [
                    {
                      from: '15551234567',
                      id: 'wamid.HBgLMDExMjM0NTY3',
                      timestamp: '1740000000',
                      type: 'text',
                      text: {
                        body: 'Find me a flight to Dubai next Friday',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const parsed = WhatsAppPayloadParser.parse(samplePayload);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].senderPhoneNumber).toBe('15551234567');
      expect(parsed[0].senderName).toBe('John Doe');
      expect(parsed[0].text).toBe('Find me a flight to Dubai next Friday');
      expect(parsed[0].whatsappMessageId).toBe('wamid.HBgLMDExMjM0NTY3');
    });

    it('should parse interactive quick-reply button clicks', () => {
      const buttonPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_123',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    phone_number_id: 'PHONE_ID_999',
                    display_phone_number: '15550001111',
                  },
                  contacts: [{ profile: { name: 'Alice' }, wa_id: '15559876543' }],
                  messages: [
                    {
                      from: '15559876543',
                      id: 'wamid.HBgLMDk4NzY1NDM=',
                      timestamp: '1740000001',
                      type: 'interactive',
                      interactive: {
                        type: 'button_reply',
                        button_reply: {
                          id: 'approve_approval_123',
                          title: 'Approve',
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const parsed = WhatsAppPayloadParser.parse(buttonPayload);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].type).toBe('interactive');
      expect(parsed[0].interactiveSelection?.id).toBe('approve_approval_123');
      expect(parsed[0].interactiveSelection?.title).toBe('Approve');
    });

    it('should ignore status receipt events (sent, delivered, read)', () => {
      const statusPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_123',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    phone_number_id: 'PHONE_ID_999',
                    display_phone_number: '15550001111',
                  },
                  statuses: [
                    {
                      id: 'wamid.HBgL...',
                      status: 'delivered',
                      timestamp: '1740000002',
                      recipient_id: '15551234567',
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const parsed = WhatsAppPayloadParser.parse(statusPayload);
      expect(parsed).toHaveLength(0);
    });
  });
});
