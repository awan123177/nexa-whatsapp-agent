import {
  AIProvider,
  AIMessage,
  AICompletionOptions,
  AIResponse,
  AIToolCall,
} from '@nexa/shared';

export interface MockAIHandler {
  (messages: AIMessage[], options?: AICompletionOptions): Promise<AIResponse> | AIResponse;
}

export class MockAIProvider implements AIProvider {
  public readonly name = 'mock';
  private customHandler?: MockAIHandler;
  private queuedResponses: AIResponse[] = [];

  constructor(handler?: MockAIHandler) {
    this.customHandler = handler;
  }

  public setHandler(handler: MockAIHandler): void {
    this.customHandler = handler;
  }

  public queueResponse(response: AIResponse): void {
    this.queuedResponses.push(response);
  }

  public clearQueue(): void {
    this.queuedResponses = [];
  }

  async generateResponse(
    messages: AIMessage[],
    options: AICompletionOptions = {}
  ): Promise<AIResponse> {
    if (this.queuedResponses.length > 0) {
      return this.queuedResponses.shift()!;
    }

    if (this.customHandler) {
      return this.customHandler(messages, options);
    }

    const lastMessage = messages[messages.length - 1];

    // Default mock response: echo or simple answer
    return {
      text: `[NEXA Mock Response] Received: ${lastMessage?.content || '(empty)'}`,
      usage: {
        promptTokens: 10,
        completionTokens: 10,
        totalTokens: 20,
      },
    };
  }
}
