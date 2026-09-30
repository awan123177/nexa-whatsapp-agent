import { z } from 'zod';
import { User, Conversation, ChannelType, ApprovalImpactLevel } from './models.js';

export type ToolRiskLevel = 'read_only' | 'low_risk' | 'medium_risk' | 'high_risk' | 'critical';

export interface ToolExecutionContext {
  user: User;
  conversation: Conversation;
  messageId?: string;
  sourceChannel: ChannelType;
  isUserConfirmed?: boolean;
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  userFacingMessage?: string;
  requiresFollowUp?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ApprovalRequirement {
  required: boolean;
  reason?: string;
  impactLevel?: ApprovalImpactLevel;
  formatConfirmationPrompt?: (args: any, context: ToolExecutionContext) => string;
}

export interface BaseTool<TArgs = any, TResult = unknown> {
  name: string;
  description: string;
  riskLevel: ToolRiskLevel;
  parametersSchema: z.ZodType<TArgs>;
  
  // Dynamic or static check if confirmation is required before execution
  requiresApproval: (args: TArgs, context: ToolExecutionContext) => ApprovalRequirement | Promise<ApprovalRequirement>;
  
  // Execution logic
  execute: (args: TArgs, context: ToolExecutionContext) => Promise<ToolResult<TResult>>;
}
