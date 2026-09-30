import { z } from 'zod';
import { BaseTool, ToolExecutionContext, ToolResult } from '@nexa/shared';

export function createApprovalTool(): BaseTool {
  return {
    name: 'request_user_confirmation',
    description: 'Requests explicit human confirmation from the user on WhatsApp before executing a sensitive, financial, or irreversible action (e.g. ticket purchase, booking payment, sending formal messages).',
    riskLevel: 'high_risk',
    parametersSchema: z.object({
      actionSummary: z.string().describe('Clear explanation of what action is about to be taken (e.g. Booking flight AI-101 for ₹18,450)'),
      impactLevel: z.enum(['low', 'medium', 'high', 'critical']).default('high').describe('The risk or financial impact level'),
      details: z.record(z.unknown()).optional().describe('Structured metadata about the pending action'),
    }),
    requiresApproval: (args) => ({
      required: true,
      impactLevel: args.impactLevel as any,
      reason: 'Explicit human authorization requested by the agent.',
      formatConfirmationPrompt: () =>
        `${args.actionSummary}\n\nDo you want me to proceed? (Reply 'Yes' or 'Approve' to confirm, or 'No' / 'Cancel' to reject)`,
    }),
    execute: async (args: { actionSummary: string; details?: Record<string, unknown> }, context: ToolExecutionContext): Promise<ToolResult> => {
      // If we reached here, the user has already approved!
      return {
        success: true,
        data: {
          confirmed: true,
          actionSummary: args.actionSummary,
          confirmedBy: context.user.phone_number,
        },
        userFacingMessage: `Action approved and proceeding: ${args.actionSummary}`,
      };
    },
  };
}
