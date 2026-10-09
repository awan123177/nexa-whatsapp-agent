import { z } from 'zod';
import { BaseTool, ToolExecutionContext, ToolResult, SecurityViolationError } from '@nexa/shared';
import { IDatabaseRepository, MemoryService } from '@nexa/database';

const FORBIDDEN_MEMORY_PATTERNS = [
  /\b(?:\d[ -]*?){13,16}\b/, // Credit card numbers
  /(cvv|cvc)/i,
  /(password|passwd|\bpin\b)/i,
  /(otp|one[- ]time[- ]password|verification\s*code)/i,
  /(bearer\s+[a-z0-9_-]{20,})/i,
  /(sk-[a-zA-Z0-9]{20,})/,
  /(AIza[0-9A-Za-z-_]{35})/,
  /(private[-_]?key|secret[-_]?key)/i,
];

const MEMORY_CATEGORIES = [
  'identity',
  'personal_profile',
  'profile',
  'feedback_correction',
  'episodic_experience',
  'procedural_workflow',
  'preferences',
  'communication_style',
  'travel_preferences',
  'shopping_preferences',
  'food_preferences',
  'work_preferences',
  'important_context',
  'saved_places',
  'saved_airports',
  'saved_merchants',
  'wallet_preferences',
  'booking_preferences',
  'other_user_preferences',
  'preference',
  'travel',
  'fact',
  'work',
] as const;

export function createMemoryTools(db: IDatabaseRepository): BaseTool[] {
  const memoryService = new MemoryService(db);

  const saveMemoryTool: BaseTool = {
    name: 'save_memory',
    description:
      'Saves important user preferences, personal details, travel habits, or recurring instructions to long-term memory. NEVER save passwords, OTPs, or financial secrets.',
    riskLevel: 'low_risk',
    parametersSchema: z.object({
      category: z.enum(MEMORY_CATEGORIES).describe('Category of the memory'),
      key: z.string().min(2).max(100).describe('Short descriptive key (e.g. dietary_preference, seat_preference, home_city)'),
      value: z.string().min(1).max(1000).describe('The memory value to save'),
      confidence: z.number().min(0).max(1).default(1.0).describe('Confidence score from 0 to 1'),
      source: z
        .enum([
          'EXPLICIT_USER_STATEMENT',
          'USER_CORRECTION',
          'VERIFIED_TASK_OUTCOME',
          'REPEATED_OBSERVATION',
          'USER_CONFIRMED_INFERENCE',
          'USER_PROVIDED',
        ])
        .optional()
        .describe('Origin of this memory'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (
      args: {
        category: typeof MEMORY_CATEGORIES[number];
        key: string;
        value: string;
        confidence: number;
        source?: any;
      },
      context: ToolExecutionContext
    ): Promise<ToolResult> => {
      // 1. Strict safety check: Never store sensitive credentials, OTPs, or passwords
      const combined = `${args.key} ${args.value}`.toLowerCase();
      for (const pattern of FORBIDDEN_MEMORY_PATTERNS) {
        if (pattern.test(combined)) {
          throw new SecurityViolationError(
            'Cannot store passwords, OTPs, payment credentials, or authentication tokens in memory.'
          );
        }
      }

      // 2. Persist memory via MemoryService
      try {
        const memory = await memoryService.saveMemory({
          userId: context.user.id,
          category: args.category,
          key: args.key,
          value: args.value,
          confidence: args.confidence,
          source: args.source || 'USER_PROVIDED',
          confirmed: true,
          sourceMessageId: context.messageId || null,
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
      } catch (err: any) {
        if (err instanceof SecurityViolationError) {
          throw err;
        }
        console.error(`[Memory] save_memory failed: ${err.message}`);
        return {
          success: false,
          error: err.message,
          data: {
            success: false,
            errorType: 'DATABASE_ERROR',
            retriable: false,
            message: err.message,
          },
          userFacingMessage: `I encountered an issue saving your preference to memory right now.`,
        };
      }
    },
  };

  const getMemoryTool: BaseTool = {
    name: 'get_memory',
    description: 'Retrieves stored user memories and preferences by category or all memories.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      category: z.enum(MEMORY_CATEGORIES).optional().describe('Optional category filter'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (
      args: { category?: typeof MEMORY_CATEGORIES[number] },
      context: ToolExecutionContext
    ): Promise<ToolResult> => {
      const memories = await db.getUserMemories(context.user.id, args.category);
      console.log('[Memory] read_success');
      console.log(`[Memory] user_memory_available=${memories.length > 0}`);
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

  const forgetMemoryTool: BaseTool = {
    name: 'forget_memory',
    description: 'Forgets or deletes a stored user preference or memory.',
    riskLevel: 'low_risk',
    parametersSchema: z.object({
      key: z.string().optional().describe('Key or description of the memory to forget'),
      forgetAll: z.boolean().optional().describe('Whether to forget all memories for this user'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (
      args: { key?: string; forgetAll?: boolean },
      context: ToolExecutionContext
    ): Promise<ToolResult> => {
      if (args.forgetAll) {
        const count = await memoryService.forgetAllMemories(context.user.id);
        return {
          success: true,
          data: { cleared: count },
          userFacingMessage: "I've forgotten everything I remembered about you. Your memory profile is now clean.",
        };
      }

      if (args.key) {
        const deleted = await memoryService.forgetMemory(context.user.id, args.key);
        return {
          success: deleted,
          data: { deleted, key: args.key },
          userFacingMessage: deleted
            ? `I've forgotten your preference for "${args.key}".`
            : `I couldn't find a stored memory matching "${args.key}".`,
        };
      }

      return {
        success: false,
        error: 'Either "key" or "forgetAll" must be specified.',
      };
    },
  };

  return [saveMemoryTool, getMemoryTool, forgetMemoryTool];
}
