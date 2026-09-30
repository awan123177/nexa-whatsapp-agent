export interface WhatsAppProfile {
    name: string;
}
export interface WhatsAppContact {
    profile: WhatsAppProfile;
    wa_id: string;
}
export interface WhatsAppTextPayload {
    body: string;
}
export interface WhatsAppMediaPayload {
    id: string;
    mime_type: string;
    sha256?: string;
    caption?: string;
    filename?: string;
}
export interface WhatsAppButtonReplyPayload {
    id: string;
    title: string;
}
export interface WhatsAppInteractivePayload {
    type: 'button_reply' | 'list_reply';
    button_reply?: WhatsAppButtonReplyPayload;
    list_reply?: {
        id: string;
        title: string;
        description?: string;
    };
}
export interface WhatsAppIncomingMessage {
    from: string;
    id: string;
    timestamp: string;
    type: 'text' | 'image' | 'audio' | 'document' | 'video' | 'interactive' | 'location' | 'contacts';
    text?: WhatsAppTextPayload;
    image?: WhatsAppMediaPayload;
    audio?: WhatsAppMediaPayload;
    document?: WhatsAppMediaPayload;
    interactive?: WhatsAppInteractivePayload;
}
export interface WhatsAppWebhookValue {
    messaging_product: 'whatsapp';
    metadata: {
        display_phone_number: string;
        phone_number_id: string;
    };
    contacts?: WhatsAppContact[];
    messages?: WhatsAppIncomingMessage[];
    statuses?: Array<{
        id: string;
        status: 'sent' | 'delivered' | 'read' | 'failed';
        timestamp: string;
        recipient_id: string;
    }>;
}
export interface WhatsAppWebhookChange {
    field: 'messages';
    value: WhatsAppWebhookValue;
}
export interface WhatsAppWebhookEntry {
    id: string;
    changes: WhatsAppWebhookChange[];
}
export interface WhatsAppWebhookPayload {
    object: 'whatsapp_business_account';
    entry: WhatsAppWebhookEntry[];
}
export interface NormalizedIncomingMessage {
    whatsappMessageId: string;
    senderPhoneNumber: string;
    senderName: string;
    phoneNumberId: string;
    type: 'text' | 'image' | 'audio' | 'document' | 'interactive' | 'unsupported';
    text?: string;
    media?: {
        id: string;
        mimeType: string;
        caption?: string;
        filename?: string;
    };
    interactiveSelection?: {
        id: string;
        title: string;
    };
    rawPayload: Record<string, unknown>;
}
export interface OutgoingWhatsAppMessage {
    to: string;
    text?: string;
    interactive?: {
        type: 'button';
        bodyText: string;
        buttons: Array<{
            id: string;
            title: string;
        }>;
    };
    media?: {
        type: 'image' | 'audio' | 'document';
        url: string;
        caption?: string;
        filename?: string;
    };
}
//# sourceMappingURL=whatsapp.d.ts.map