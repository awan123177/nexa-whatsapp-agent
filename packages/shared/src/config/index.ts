import { z } from 'zod';

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Gemini AI
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required for AI operations').optional(),
  GEMINI_MODEL: z.string().default('gemini-3.7-flash'),
  GEMINI_FALLBACK_MODEL: z.string().default('gemini-3.8-flash'),
  GEMINI_THINKING_LEVEL: z.enum(['low', 'medium', 'high']).default('low'),

  // WhatsApp Cloud API
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),

  // Supabase Database
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // Google OAuth (Gmail)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),

  // Data Security
  ENCRYPTION_KEY: z.string().optional(),

  // Search Providers (Optional)
  TAVILY_API_KEY: z.string().optional(),
  SERPER_API_KEY: z.string().optional(),

  // Agent Config
  MAX_AGENT_STEPS: z.coerce.number().default(5),
  TOOL_TIMEOUT_MS: z.coerce.number().default(7000),
  TOTAL_AGENT_DEADLINE_MS: z.coerce.number().default(22000),
  RATE_LIMIT_MAX_REQUESTS_PER_MINUTE: z.coerce.number().default(30),
  APPROVAL_TIMEOUT_MINUTES: z.coerce.number().default(60),
});

export type NexaConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env = process.env): NexaConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const formattedErrors = result.error.errors
      .map((err) => `  - ${err.path.join('.')}: ${err.message}`)
      .join('\n');
    throw new Error(`Configuration Validation Error:\n${formattedErrors}`);
  }
  return result.data;
}
