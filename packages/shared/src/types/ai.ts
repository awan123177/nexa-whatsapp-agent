export type AIMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AIToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
  rawPart?: any;
}

export interface AIToolResult {
  toolCallId: string;
  name: string;
  result: unknown;
  isError?: boolean;
}

export interface AIMediaPart {
  mimeType: string;
  data: string; // Base64-encoded binary data
}

export interface AIMessage {
  role: AIMessageRole;
  content: string;
  name?: string;
  toolCalls?: AIToolCall[];
  toolResults?: AIToolResult[];
  rawModelContent?: any;
  rawModelParts?: any[];
  media?: AIMediaPart;
}

export interface AIToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type ThinkingLevel = 'low' | 'medium' | 'high';

export interface AICompletionOptions {
  model?: string;
  fallbackModel?: string;
  thinkingLevel?: ThinkingLevel;
  temperature?: number;
  maxTokens?: number;
  systemInstruction?: string;
  tools?: AIToolDeclaration[];
  currentUserText?: string;
  currentUserMedia?: AIMediaPart;
  requestTimeoutMs?: number;
  overallDeadlineMs?: number;
  rawHistory?: any[];
  isToolUse?: boolean;
  isCommerceTask?: boolean;
  isSimpleChat?: boolean;
}

export interface AIResponse {
  text: string;
  toolCalls?: AIToolCall[];
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  rawModelContent?: any;
  rawModelParts?: any[];
}

export interface AIProvider {
  name: string;
  generateResponse(messages: AIMessage[], options?: AICompletionOptions): Promise<AIResponse>;
}

