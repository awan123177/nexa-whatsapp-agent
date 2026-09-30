import { GoogleGenAI } from '@google/genai';
import {
  AIProvider,
  AIMessage,
  AICompletionOptions,
  AIResponse,
  AIToolCall,
  NexaError,
} from '@nexa/shared';

export class GeminiProvider implements AIProvider {
  public readonly name = 'gemini';
  private client: GoogleGenAI;
  private defaultModel: string;

  constructor(options: { apiKey: string; defaultModel?: string }) {
    if (!options.apiKey) {
      throw new NexaError('Gemini API key is required.', {
        code: 'MISSING_API_KEY',
        statusCode: 500,
      });
    }
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
    this.defaultModel = options.defaultModel || 'gemini-2.5-flash';
  }

  async generateResponse(
    messages: AIMessage[],
    options: AICompletionOptions = {}
  ): Promise<AIResponse> {
    try {
      const model = options.model || this.defaultModel;

      // Map Nexa tools to Gemini function declarations
      const functionDeclarations = options.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'OBJECT',
          properties: tool.parameters.properties,
          required: tool.parameters.required || [],
        },
      }));

      // Convert Nexa messages to Gemini contents format
      const contents = this.formatMessagesForGemini(messages);

      const response = await this.client.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: options.systemInstruction || undefined,
          temperature: options.temperature ?? 0.2,
          maxOutputTokens: options.maxTokens ?? 2048,
          tools: functionDeclarations && functionDeclarations.length > 0
            ? [{ functionDeclarations: functionDeclarations as any }]
            : undefined,
        },
      });

      const toolCalls: AIToolCall[] = [];
      const functionCalls = response.functionCalls;

      if (functionCalls && Array.isArray(functionCalls)) {
        for (const call of functionCalls) {
          toolCalls.push({
            id: (call as any).id || `call_${Math.random().toString(36).substring(2, 9)}`,
            name: call.name || '',
            arguments: (call.args as Record<string, unknown>) || {},
          });
        }
      }

      return {
        text: response.text || '',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: (response as any).candidates?.[0]?.finishReason,
        usage: {
          promptTokens: (response as any).usageMetadata?.promptTokenCount || 0,
          completionTokens: (response as any).usageMetadata?.candidatesTokenCount || 0,
          totalTokens: (response as any).usageMetadata?.totalTokenCount || 0,
        },
      };
    } catch (error: any) {
      const errMsg = error?.message || 'Unknown Gemini API error';
      // Specific error classification
      if (errMsg.includes('ResourceExhausted') || errMsg.includes('429')) {
        throw new NexaError('Gemini API quota exhausted or rate limit hit.', {
          code: 'AI_RATE_LIMIT',
          statusCode: 429,
          userFacingMessage: 'NEXA is currently experiencing high load. Please try again in a moment.',
        });
      }
      throw new NexaError(`Gemini generation error: ${errMsg}`, {
        code: 'AI_GENERATION_FAILED',
        statusCode: 502,
        userFacingMessage: 'I had trouble communicating with the AI service. Please try again shortly.',
      });
    }
  }

  private formatMessagesForGemini(messages: AIMessage[]): any[] {
    const formatted: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // System instructions are passed separately in Gemini config
        continue;
      }

      if (msg.role === 'user') {
        formatted.push({
          role: 'user',
          parts: [{ text: msg.content }],
        });
      } else if (msg.role === 'assistant') {
        const parts: any[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: {
                name: tc.name,
                args: tc.arguments,
              },
            });
          }
        }
        formatted.push({
          role: 'model',
          parts,
        });
      } else if (msg.role === 'tool') {
        // Tool results response
        const parts: any[] = [];
        if (msg.toolResults && msg.toolResults.length > 0) {
          for (const tr of msg.toolResults) {
            parts.push({
              functionResponse: {
                name: tr.name,
                response: {
                  result: tr.result,
                  isError: tr.isError || false,
                },
              },
            });
          }
        }
        formatted.push({
          role: 'user',
          parts,
        });
      }
    }

    return formatted;
  }
}
