import { z } from 'zod';
import { BaseTool, ToolExecutionContext, ToolResult } from '@nexa/shared';

export const confirmationDetailsSchema = z.record(z.unknown());
export type ConfirmationDetails = Record<string, unknown>;

export const requestUserConfirmationParametersSchema = z.object({
  actionSummary: z
    .string()
    .describe('Clear explanation of what action is about to be taken (e.g. Booking flight AI-101 for ₹18,450)'),
  impactLevel: z
    .enum(['low', 'medium', 'high', 'critical'])
    .default('high')
    .describe('The risk or financial impact level'),
  details: z
    .preprocess((val) => {
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object') return parsed;
          } catch {}
        }
        return { summary: trimmed };
      }
      if (val === undefined || val === null) return {};
      return val;
    }, z.record(z.unknown()).default({}))
    .describe('Structured metadata about the pending action'),
});

export type RequestUserConfirmationInput = z.infer<typeof requestUserConfirmationParametersSchema>;

export function createApprovalTool(): BaseTool {
  return {
    name: 'request_user_confirmation',
    description:
      'Requests explicit human confirmation from the user on WhatsApp before executing a sensitive, financial, or irreversible action (e.g. ticket purchase, booking payment, sending formal messages).',
    riskLevel: 'high_risk',
    parametersSchema: requestUserConfirmationParametersSchema,
    requiresApproval: (args) => ({
      required: true,
      impactLevel: (args.impactLevel as any) || 'high',
      reason: 'Explicit human authorization requested by the agent.',
      formatConfirmationPrompt: () =>
        `${args.actionSummary}\n\nDo you want me to proceed? (Reply 'Yes' or 'Approve' to confirm, or 'No' / 'Cancel' to reject)`,
    }),
    execute: async (
      args: { actionSummary: string; impactLevel?: string; details?: Record<string, unknown> },
      context: ToolExecutionContext
    ): Promise<ToolResult> => {
      // If we reached here, the user has already approved!
      return {
        success: true,
        data: {
          confirmed: true,
          actionSummary: args.actionSummary,
          confirmedBy: context.user.phone_number,
          details: args.details || {},
        },
        userFacingMessage: `Action approved and proceeding: ${args.actionSummary}`,
      };
    },
  };
}
