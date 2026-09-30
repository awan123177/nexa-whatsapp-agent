import { z } from 'zod';
import { BaseTool, ToolExecutionContext, ToolResult, SecurityViolationError } from '@nexa/shared';
import { IDatabaseRepository } from '@nexa/database';

const FORBIDDEN_MEMORY_PATTERNS = [
  /(?:\d[ -]*?){13,16}/, // Credit card numbers
  /(cvv|cvc)/i,
  /(password|passwd|pin)/i,
  /(otp|one[- ]time[- ]password|verification\s*code)/i,
  /(bearer\s+[a-z0-9_-]{20,})/i,
  /(sk-[a-zA-Z0-9]{20,})/,
  /(AIza[0-9A-Za-z-_]{35})/,
];

export function createMemoryTools(db: IDatabaseRepository): BaseTool[] {
  const saveMemoryTool: BaseTool = {
    name: 'save_memory',
    description: 'Saves important user preferences, personal details, travel habits, or recurring instructions to long-term memory. NEVER save passwords, OTPs, or financial secrets.',
    riskLevel: 'low_risk',
    parametersSchema: z.object({
      category: z.enum(['preference', 'travel', 'profile', 'fact', 'work']).describe('Category of the memory'),
      key: z.string().min(2).max(100).describe('Short descriptive key (e.g. dietary_preference, seat_preference, home_city)'),
      value: z.string().min(1).max(1000).describe('The memory value to save'),
      confidence: z.number().min(0).max(1).default(1.0).describe('Confidence score from 0 to 1'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { category: 'preference' | 'travel' | 'profile' | 'fact' | 'work'; key: string; value: string; confidence: number }, context: ToolExecutionContext): Promise<ToolResult> => {
      // 1. Strict safety check: Never store sensitive credentials, OTPs, or passwords
      const combined = `${args.key} ${args.value}`.toLowerCase();
      for (const pattern of FORBIDDEN_MEMORY_PATTERNS) {
        if (pattern.test(combined)) {
          throw new SecurityViolationError(
            'Cannot store passwords, OTPs, payment credentials, or authentication tokens in memory.'
          );
        }
      }

      // 2. Persist memory
      const memory = await db.saveMemory({
        user_id: context.user.id,
        category: args.category,
        key: args.key,
        value: args.value,
        confidence: args.confidence,
        source_message_id: context.messageId || null,
        metadata: {
          savedViaChannel: context.sourceChannel,
        },
      });

      return {
        success: true,
        data: {
          id: memory.id,
          key: memory.key,
          value: memory.value,
        },
        userFacingMessage: `I've remembered that for you (${args.key}: "${args.value}").`,
      };
    },
  };

  const getMemoryTool: BaseTool = {
    name: 'get_memory',
    description: 'Retrieves stored user memories and preferences by category or all memories.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      category: z.enum(['preference', 'travel', 'profile', 'fact', 'work']).optional().describe('Optional category filter'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { category?: 'preference' | 'travel' | 'profile' | 'fact' | 'work' }, context: ToolExecutionContext): Promise<ToolResult> => {
      const memories = await db.getUserMemories(context.user.id, args.category);
      return {
        success: true,
        data: {
          count: memories.length,
          memories: memories.map((m) => ({
            category: m.category,
            key: m.key,
            value: m.value,
            updatedAt: m.updated_at,
          })),
        },
      };
    },
  };

  return [saveMemoryTool, getMemoryTool];
}
