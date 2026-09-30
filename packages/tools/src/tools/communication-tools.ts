import { z } from 'zod';
import { BaseTool, ToolExecutionContext, ToolResult } from '@nexa/shared';

export interface EmailMessage {
  id: string;
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  date: string;
}

export interface EmailProvider {
  readEmails(params: { query?: string; limit?: number }): Promise<EmailMessage[]>;
  sendEmail(params: { to: string; subject: string; body: string; cc?: string[] }): Promise<{ messageId: string; status: string }>;
}

export class DisconnectedEmailProvider implements EmailProvider {
  async readEmails(_params: { query?: string; limit?: number }): Promise<EmailMessage[]> {
    throw new Error(
      'Email account is not connected. Please connect your Gmail or Outlook account via OAuth settings to enable reading emails.'
    );
  }

  async sendEmail(_params: { to: string; subject: string; body: string; cc?: string[] }): Promise<{ messageId: string; status: string }> {
    throw new Error(
      'Email account is not connected. Please connect your email provider via OAuth to authorize sending messages.'
    );
  }
}

export function createCommunicationTools(emailProvider: EmailProvider = new DisconnectedEmailProvider()): BaseTool[] {
  const readEmailTool: BaseTool = {
    name: 'read_email',
    description: 'Reads recent emails or searches user inbox when an email provider is connected.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      query: z.string().optional().describe('Search query (e.g. from:uber or subject:receipt)'),
      limit: z.number().min(1).max(20).default(5).describe('Number of emails to fetch'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { query?: string; limit?: number }, _context: ToolExecutionContext): Promise<ToolResult> => {
      try {
        const emails = await emailProvider.readEmails(args);
        return { success: true, data: { emails } };
      } catch (err: any) {
        return {
          success: false,
          error: err.message,
          userFacingMessage: err.message,
        };
      }
    },
  };

  const sendEmailTool: BaseTool = {
    name: 'send_email',
    description: 'Sends an email to a recipient. ALWAYS requires explicit user confirmation before dispatch.',
    riskLevel: 'high_risk',
    parametersSchema: z.object({
      to: z.string().email().describe('Recipient email address'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Body content of the email'),
      cc: z.array(z.string().email()).optional().describe('Optional CC email addresses'),
    }),
    requiresApproval: (args) => ({
      required: true,
      impactLevel: 'high',
      reason: 'Sending an email communicates externally on behalf of the user.',
      formatConfirmationPrompt: () =>
        `I am ready to send an email to *${args.to}* with subject "*${args.subject}*":\n\n"${args.body}"\n\nDo you confirm sending this email? (Reply 'Yes' to send or 'No' to cancel)`,
    }),
    execute: async (args: any, _context: ToolExecutionContext): Promise<ToolResult> => {
      try {
        const res = await emailProvider.sendEmail(args);
        return {
          success: true,
          data: res,
          userFacingMessage: `Email successfully sent to ${args.to} with subject "${args.subject}".`,
        };
      } catch (err: any) {
        return {
          success: false,
          error: err.message,
          userFacingMessage: err.message,
        };
      }
    },
  };

  return [readEmailTool, sendEmailTool];
}
