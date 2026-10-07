import { AIProvider } from '@nexa/shared';
import { GeminiProvider } from './gemini-provider.js';
import { MockAIProvider } from './mock-provider.js';

export function createAIProvider(options: {
  apiKey?: string;
  model?: string;
  fallbackModel?: string;
  forceMock?: boolean;
}): AIProvider {
  if (options.forceMock || !options.apiKey) {
    if (!options.forceMock) {
      console.warn(
        '[NEXA AI] GEMINI_API_KEY is not set. Defaulting to MockAIProvider for offline testing.'
      );
    }
    return new MockAIProvider();
  }

  return new GeminiProvider({
    apiKey: options.apiKey,
    defaultModel: options.model,
    fallbackModel: options.fallbackModel,
  });
}
