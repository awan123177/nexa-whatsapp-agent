import { GoogleGenAI } from '@google/genai';
import {
  AIProvider,
  AIMessage,
  AICompletionOptions,
  AIResponse,
  AIToolCall,
  NexaError,
} from '@nexa/shared';
import { redactString } from '@nexa/security';

export interface GeminiProviderOptions {
  apiKey: string;
  defaultModel?: string;
  fallbackModel?: string;
  maxRetries?: number;
  sleepFn?: (ms: number) => Promise<void>;
  generateContentFn?: (params: any) => Promise<any>;
}

/**
 * Extracts numeric HTTP status code from error object or error message.
 */
export function extractStatusCode(error: any): number | null {
  if (!error) return null;
  if (typeof error.status === 'number') return error.status;
  if (typeof error.statusCode === 'number') return error.statusCode;
  if (typeof error.response?.status === 'number') return error.response.status;
  if (typeof error.code === 'number') return error.code;

  const msg = typeof error.message === 'string' ? error.message : '';
  const match = msg.match(/\b(503|429|500|502|504|400|401|403|404)\b/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Determines whether an error is a permanent client/auth error that must NOT be retried.
 */
export function isPermanentError(error: any): boolean {
  if (!error) return false;
  const status = extractStatusCode(error);
  if (status !== null) {
    if (status === 400 || status === 401 || status === 403 || status === 404) {
      return true;
    }
  }

  const msg = (typeof error.message === 'string' ? error.message : '').toLowerCase();
  if (
    msg.includes('api_key_invalid') ||
    msg.includes('invalid api key') ||
    msg.includes('invalid_api_key') ||
    msg.includes('unauthenticated') ||
    msg.includes('permission_denied') ||
    msg.includes('permission denied') ||
    msg.includes('invalid argument') ||
    msg.includes('invalid_argument') ||
    msg.includes('malformed') ||
    msg.includes('bad request') ||
    msg.includes('not found') ||
    msg.includes('entity not found')
  ) {
    return true;
  }

  return false;
}

/**
 * Determines whether an error is a transient server or rate limit error suitable for retry.
 */
export function isTransientError(error: any): boolean {
  if (!error) return false;

  // Never retry permanent client/auth errors
  if (isPermanentError(error)) {
    return false;
  }

  const status = extractStatusCode(error);
  if (status !== null) {
    if (
      status === 503 || // 503 UNAVAILABLE
      status === 429 || // 429 RESOURCE_EXHAUSTED / Rate limit
      status === 500 || // 500 Internal Server Error
      status === 502 || // 502 Bad Gateway
      status === 504    // 504 Gateway Timeout
    ) {
      return true;
    }
  }

  const msg = (typeof error.message === 'string' ? error.message : '').toLowerCase();
  const code = (typeof error.code === 'string' ? error.code : '').toLowerCase();

  if (
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('resource_exhausted') ||
    msg.includes('resourceexhausted') ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    msg.includes('overloaded') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('timeout') ||
    msg.includes('deadline_exceeded') ||
    msg.includes('internal') ||
    msg.includes('bad gateway') ||
    msg.includes('gateway timeout') ||
    code === 'unavailable' ||
    code === 'resource_exhausted' ||
    code === 'econnreset' ||
    code === 'etimedout'
  ) {
    return true;
  }

  return false;
}

/**
 * Parses a Retry-After header value (in seconds or HTTP date string) into milliseconds.
 */
export function parseRetryAfter(value: string | number): number | null {
  if (typeof value === 'number') {
    return value > 0 ? Math.round(value * 1000) : null;
  }
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  const seconds = parseFloat(trimmed);
  if (!isNaN(seconds) && isFinite(seconds) && seconds > 0) {
    return Math.round(seconds * 1000);
  }

  const parsedDate = Date.parse(trimmed);
  if (!isNaN(parsedDate)) {
    const diff = parsedDate - Date.now();
    return diff > 0 ? diff : 0;
  }

  return null;
}

/**
 * Extracts Retry-After information from error properties, headers, or messages.
 */
export function extractRetryAfter(error: any): string | number | null {
  if (!error) return null;

  if (error.retryAfter !== undefined) {
    return error.retryAfter;
  }

  const headers = error.headers || error.response?.headers;
  if (headers) {
    if (typeof headers.get === 'function') {
      const val = headers.get('retry-after') || headers.get('Retry-After');
      if (val) return val;
    } else if (typeof headers === 'object') {
      const val = headers['retry-after'] || headers['Retry-After'];
      if (val) return val;
    }
  }

  const msg = typeof error.message === 'string' ? error.message : '';
  const match = msg.match(/retry[- ]after[:\s]+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)?/i);
  if (match && match[1]) {
    return parseFloat(match[1]);
  }

  return null;
}

/**
 * Calculates exponential backoff delay with random jitter and optional Retry-After support.
 *
 * Requirements:
 * - attempt 1: 1–2 seconds (1000ms base + 0..1000ms jitter)
 * - attempt 2: 2–4 seconds (2000ms base + 0..2000ms jitter)
 * - attempt 3: 4–8 seconds (4000ms base + 0..4000ms jitter)
 */
export function calculateRetryDelay(
  attempt: number,
  retryAfterHeader?: string | number | null
): number {
  if (retryAfterHeader !== undefined && retryAfterHeader !== null) {
    const parsed = parseRetryAfter(retryAfterHeader);
    if (parsed !== null && parsed > 0) {
      // Add a small jitter (100–500ms) to prevent synchronized retry spikes
      const jitter = Math.floor(Math.random() * 400) + 100;
      return Math.min(parsed + jitter, 60_000);
    }
  }

  const normalizedAttempt = Math.max(1, Math.min(attempt, 5));
  const baseDelay = 1000 * Math.pow(2, normalizedAttempt - 1);
  const jitter = Math.random() * baseDelay;
  return Math.round(baseDelay + jitter);
}

export class GeminiProvider implements AIProvider {
  public readonly name = 'gemini';
  private client: GoogleGenAI;
  private defaultModel: string;
  private fallbackModel: string;
  private maxRetries: number;
  private sleepFn: (ms: number) => Promise<void>;
  private generateContentFn?: (params: any) => Promise<any>;

  constructor(options: GeminiProviderOptions) {
    if (!options.apiKey) {
      throw new NexaError('Gemini API key is required.', {
        code: 'MISSING_API_KEY',
        statusCode: 500,
      });
    }
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
    this.defaultModel = options.defaultModel || 'gemini-3.8-flash';
    this.fallbackModel = options.fallbackModel || 'gemini-3.7-flash';
    this.maxRetries = options.maxRetries ?? 3;
    this.sleepFn = options.sleepFn || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.generateContentFn = options.generateContentFn;
  }

  public getDefaultModel(): string {
    return this.defaultModel;
  }

  public getFallbackModel(): string {
    return this.fallbackModel;
  }

  async generateResponse(
    messages: AIMessage[],
    options: AICompletionOptions = {}
  ): Promise<AIResponse> {
    const primaryModel = options.model || this.defaultModel;
    const fallbackModel =
      options.fallbackModel !== undefined ? options.fallbackModel : this.fallbackModel;

    const modelsToTry = [primaryModel];
    if (fallbackModel && fallbackModel !== primaryModel) {
      modelsToTry.push(fallbackModel);
    }

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

    let lastError: any = null;

    for (let mIdx = 0; mIdx < modelsToTry.length; mIdx++) {
      const currentModel = modelsToTry[mIdx];
      const isLastModel = mIdx === modelsToTry.length - 1;

      let attempt = 0;
      // Model retry loop: attempt 1 initial, then up to maxRetries retries
      while (attempt <= this.maxRetries) {
        attempt++;
        console.log(`[Gemini] attempt=${attempt} model=${currentModel}`);

        const generateParams = {
          model: currentModel,
          contents,
          config: {
            systemInstruction: options.systemInstruction || undefined,
            temperature: options.temperature ?? 0.2,
            maxOutputTokens: options.maxTokens ?? 2048,
            tools:
              functionDeclarations && functionDeclarations.length > 0
                ? [{ functionDeclarations: functionDeclarations as any }]
                : undefined,
          },
        };

        try {
          const response = this.generateContentFn
            ? await this.generateContentFn(generateParams)
            : await this.client.models.generateContent(generateParams);

          console.log('[Gemini] success');

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
          lastError = error;

          // Never retry permanent client/auth/validation errors (400, 401, 403, 404, invalid API key)
          if (isPermanentError(error)) {
            this.handleFinalError(error);
          }

          const isTransient = isTransientError(error);
          if (!isTransient) {
            this.handleFinalError(error);
          }

          const status = extractStatusCode(error) || 503;

          // If current model still has retries remaining
          if (attempt <= this.maxRetries) {
            const retryAfter = extractRetryAfter(error);
            const delayMs = calculateRetryDelay(attempt, retryAfter);
            console.log(`[Gemini] transient_error status=${status} retry_in_ms=${delayMs}`);
            await this.sleepFn(delayMs);
          } else {
            // Retries for current model exhausted
            if (!isLastModel) {
              const nextModel = modelsToTry[mIdx + 1];
              console.log(
                `[Gemini] fallback_model_switch from=${currentModel} to=${nextModel}`
              );
            }
          }
        }
      }
    }

    // All models and retries exhausted; return safe user-facing error
    this.handleFinalError(lastError || new Error('All Gemini retry attempts exhausted.'));
  }

  private handleFinalError(error: any): never {
    const errMsg = redactString(error?.message || 'Unknown Gemini API error');
    const status = extractStatusCode(error);

    // 1. Quota / Rate limit (429 / RESOURCE_EXHAUSTED)
    if (
      status === 429 ||
      errMsg.includes('ResourceExhausted') ||
      errMsg.includes('429') ||
      errMsg.toLowerCase().includes('rate limit')
    ) {
      throw new NexaError('Gemini API quota exhausted or rate limit hit.', {
        code: 'AI_RATE_LIMIT',
        statusCode: 429,
        userFacingMessage: 'NEXA is currently experiencing high load. Please try again in a moment.',
      });
    }

    // 2. Service Unavailable / High demand (503)
    if (
      status === 503 ||
      errMsg.includes('503') ||
      errMsg.toLowerCase().includes('unavailable') ||
      errMsg.toLowerCase().includes('high demand')
    ) {
      throw new NexaError('Gemini API is temporarily unavailable due to high demand.', {
        code: 'AI_SERVICE_UNAVAILABLE',
        statusCode: 503,
        userFacingMessage: 'NEXA is currently experiencing high load. Please try again in a moment.',
      });
    }

    // 3. Client permanent authentication error (401)
    if (
      status === 401 ||
      errMsg.includes('401') ||
      errMsg.toLowerCase().includes('unauthenticated') ||
      errMsg.toLowerCase().includes('invalid api key') ||
      errMsg.toLowerCase().includes('api_key_invalid')
    ) {
      throw new NexaError('Invalid or unauthorized Gemini API key.', {
        code: 'AI_AUTH_FAILED',
        statusCode: 401,
        userFacingMessage: 'AI authentication error. Please contact system administrator.',
      });
    }

    // 4. Client forbidden (403)
    if (
      status === 403 ||
      errMsg.includes('403') ||
      errMsg.toLowerCase().includes('permission_denied')
    ) {
      throw new NexaError('Gemini API access forbidden.', {
        code: 'AI_PERMISSION_DENIED',
        statusCode: 403,
        userFacingMessage: 'AI permission error. Please contact system administrator.',
      });
    }

    // 5. Default safe failure (existing safe user-facing error)
    throw new NexaError(`Gemini generation error: ${errMsg}`, {
      code: 'AI_GENERATION_FAILED',
      statusCode: 502,
      userFacingMessage: 'I had trouble communicating with the AI service. Please try again shortly.',
    });
  }

  private formatMessagesForGemini(messages: AIMessage[]): any[] {
    const formatted: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
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
