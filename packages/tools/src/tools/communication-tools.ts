import { z } from 'zod';
import { BaseTool, ToolExecutionContext, ToolResult } from '@nexa/shared';
import { IDatabaseRepository } from '@nexa/database';
import { GoogleOAuthService } from './google-oauth.js';
import { GmailEmailProvider } from './gmail-provider.js';

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
  private connectUrl?: string;

  constructor(connectUrl?: string) {
    this.connectUrl = connectUrl;
  }

  async readEmails(_params: { query?: string; limit?: number }): Promise<EmailMessage[]> {
    const hint = this.connectUrl
      ? ` Please connect your Gmail account securely using this authorization link: ${this.connectUrl}`
      : ' Please connect your Gmail or Outlook account via OAuth settings to enable reading emails.';
    throw new Error(`Email account is not connected.${hint}`);
  }

  async sendEmail(_params: { to: string; subject: string; body: string; cc?: string[] }): Promise<{ messageId: string; status: string }> {
    const hint = this.connectUrl
      ? ` Please connect your Gmail account securely using this authorization link: ${this.connectUrl}`
      : ' Please connect your email provider via OAuth to authorize sending messages.';
    throw new Error(`Email account is not connected.${hint}`);
  }
}

export interface CommunicationToolsOptions {
  emailProvider?: EmailProvider;
  db?: IDatabaseRepository;
  oauthService?: GoogleOAuthService;
  providerResolver?: (userId: string) => Promise<EmailProvider>;
}

export function createCommunicationTools(
  providerOrOptions?: EmailProvider | CommunicationToolsOptions
): BaseTool[] {
  let staticProvider: EmailProvider | undefined;
  let options: CommunicationToolsOptions | undefined;

  if (providerOrOptions) {
    if ('readEmails' in providerOrOptions || 'sendEmail' in providerOrOptions) {
      staticProvider = providerOrOptions as EmailProvider;
    } else {
      options = providerOrOptions as CommunicationToolsOptions;
      staticProvider = options.emailProvider;
    }
  }

  const resolveProvider = async (context: ToolExecutionContext): Promise<EmailProvider> => {
    if (staticProvider) {
      return staticProvider;
    }

    if (options?.providerResolver && context.user?.id) {
      return options.providerResolver(context.user.id);
    }

    if (options?.db && options?.oauthService && context.user?.id) {
      const account = await options.db.getConnectedAccount(context.user.id, 'google');
      if (account && account.status === 'active') {
        return new GmailEmailProvider({
          getAccessToken: () => options!.oauthService!.getValidAccessToken(context.user.id),
          fetchFn: options!.oauthService!.getFetchFn(),
        });
      }
      try {
        const connectToken = options.oauthService.createConnectSessionToken(context.user.id);
        const baseUrl = process.env.BASE_URL || `http://${process.env.HOST || 'localhost'}:${process.env.PORT || '3000'}`;
        const connectUrl = `${baseUrl.replace(/\/+$/, '')}/auth/google/start?token=${encodeURIComponent(connectToken)}&redirect=true`;
        return new DisconnectedEmailProvider(connectUrl);
      } catch {
        return new DisconnectedEmailProvider();
      }
    }

    return new DisconnectedEmailProvider();
  };
  const readEmailTool: BaseTool = {
    name: 'read_email',
    description: 'Reads recent emails or searches user inbox when an email provider is connected.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      query: z.string().optional().describe('Search query (e.g. from:uber or subject:receipt)'),
      limit: z.number().min(1).max(20).default(5).describe('Number of emails to fetch'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { query?: string; limit?: number }, context: ToolExecutionContext): Promise<ToolResult> => {
      try {
        const provider = await resolveProvider(context);
        const emails = await provider.readEmails(args);
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
    execute: async (args: any, context: ToolExecutionContext): Promise<ToolResult> => {
      try {
        const provider = await resolveProvider(context);
        const res = await provider.sendEmail(args);
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
