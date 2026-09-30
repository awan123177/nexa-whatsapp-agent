import { EmailMessage, EmailProvider } from './communication-tools.js';

export interface GmailEmailProviderOptions {
  accessToken?: string;
  getAccessToken?: () => Promise<string>;
  fetchFn?: typeof fetch;
}

export class GmailEmailProvider implements EmailProvider {
  private accessToken?: string;
  private getAccessTokenFn?: () => Promise<string>;
  private fetchFn: typeof fetch;

  constructor(options: GmailEmailProviderOptions) {
    this.accessToken = options.accessToken;
    this.getAccessTokenFn = options.getAccessToken;
    this.fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis);
  }

  private async resolveToken(): Promise<string> {
    if (this.getAccessTokenFn) {
      return this.getAccessTokenFn();
    }
    if (this.accessToken) {
      return this.accessToken;
    }
    throw new Error(
      'No valid Google access token available. Please connect your Gmail account via OAuth.'
    );
  }

  async readEmails(params: { query?: string; limit?: number }): Promise<EmailMessage[]> {
    const token = await this.resolveToken();
    const limit = Math.min(Math.max(1, params.limit || 5), 20);

    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    if (params.query) {
      listUrl.searchParams.set('q', params.query);
    }
    listUrl.searchParams.set('maxResults', String(limit));

    const listRes = await this.fetchFn(listUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!listRes.ok) {
      const err = await listRes.json().catch(() => ({}));
      const msg = (err as any)?.error?.message || `HTTP ${listRes.status}`;
      throw new Error(`Gmail API error fetching email list: ${msg}`);
    }

    const listData = await listRes.json();
    const messagesSummaries = (listData as any).messages || [];
    if (messagesSummaries.length === 0) {
      return [];
    }

    const emails: EmailMessage[] = [];

    for (const item of messagesSummaries.slice(0, limit)) {
      const detailUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=full`;
      const detailRes = await this.fetchFn(detailUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!detailRes.ok) {
        continue;
      }

      const detailData = await detailRes.json();
      const payload = (detailData as any).payload || {};
      const headers = (payload.headers || []) as Array<{ name: string; value: string }>;

      const getHeader = (name: string): string => {
        const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
        return found ? found.value : '';
      };

      const sender = getHeader('From') || 'Unknown';
      const recipient = getHeader('To') || 'Me';
      const subject = getHeader('Subject') || '(No Subject)';
      const date = getHeader('Date') || new Date().toISOString();
      const body = extractBodyFromPayload(payload) || (detailData as any).snippet || '';

      emails.push({
        id: (detailData as any).id,
        sender,
        recipient,
        subject,
        body: body.slice(0, 4000).trim(),
        date,
      });
    }

    return emails;
  }

  async sendEmail(params: {
    to: string;
    subject: string;
    body: string;
    cc?: string[];
  }): Promise<{ messageId: string; status: string }> {
    const token = await this.resolveToken();

    // Sanitize headers against CRLF injection attacks
    const sanitizedTo = params.to.replace(/[\r\n]+/g, '').trim();
    if (!sanitizedTo) {
      throw new Error('Invalid recipient email address.');
    }
    const sanitizedSubject = params.subject.replace(/[\r\n]+/g, ' ').trim();
    const sanitizedCc = params.cc
      ? params.cc.map((c) => c.replace(/[\r\n]+/g, '').trim()).filter(Boolean)
      : [];
    const normalizedBody = params.body.replace(/\r?\n/g, '\r\n');

    // Construct standard RFC 2822 email format
    const lines: string[] = [
      `To: ${sanitizedTo}`,
      ...(sanitizedCc.length > 0 ? [`Cc: ${sanitizedCc.join(', ')}`] : []),
      `Subject: =?utf-8?B?${Buffer.from(sanitizedSubject, 'utf-8').toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      normalizedBody,
    ];

    const rfc2822Message = lines.join('\r\n');
    const raw = Buffer.from(rfc2822Message, 'utf-8').toString('base64url');

    const sendRes = await this.fetchFn(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      }
    );

    if (!sendRes.ok) {
      const err = await sendRes.json().catch(() => ({}));
      const msg = (err as any)?.error?.message || `HTTP ${sendRes.status}`;
      throw new Error(`Failed to send email via Gmail API: ${msg}`);
    }

    const data = await sendRes.json();
    return {
      messageId: (data as any).id,
      status: 'sent',
    };
  }
}

/**
 * Extracts and decodes plain text or html email body from a Gmail message payload.
 */
function extractBodyFromPayload(payload: any): string {
  if (!payload) return '';

  // Direct body data
  if (payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  // Multipart parts
  if (payload.parts && Array.isArray(payload.parts)) {
    // 1. Prefer text/plain
    const plainPart = payload.parts.find((p: any) => p.mimeType === 'text/plain');
    if (plainPart && plainPart.body && plainPart.body.data) {
      return Buffer.from(plainPart.body.data, 'base64url').toString('utf-8');
    }

    // 2. Check text/html (strip HTML tags simply)
    const htmlPart = payload.parts.find((p: any) => p.mimeType === 'text/html');
    if (htmlPart && htmlPart.body && htmlPart.body.data) {
      const html = Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8');
      return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // 3. Recurse into nested parts (e.g. multipart/alternative)
    for (const part of payload.parts) {
      const nested = extractBodyFromPayload(part);
      if (nested) return nested;
    }
  }

  return '';
}
