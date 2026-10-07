export type AIMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AIToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AIToolResult {
  toolCallId: string;
  name: string;
  result: unknown;
  isError?: boolean;
}

export interface AIMessage {
  role: AIMessageRole;
  content: string;
  name?: string;
  toolCalls?: AIToolCall[];
  toolResults?: AIToolResult[];
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

export interface AICompletionOptions {
  model?: string;
  fallbackModel?: string;
  temperature?: number;
  maxTokens?: number;
  systemInstruction?: string;
  tools?: AIToolDeclaration[];
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
}

export interface AIProvider {
  name: string;
  generateResponse(messages: AIMessage[], options?: AICompletionOptions): Promise<AIResponse>;
}
