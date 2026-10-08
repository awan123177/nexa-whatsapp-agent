import { z } from 'zod';

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Gemini AI
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required for AI operations').optional(),
  GEMINI_MODEL: z.string().default('gemini-3.7-flash'),
  GEMINI_FALLBACK_MODEL: z.string().default('gemini-3.6-flash'),
  GEMINI_THINKING_LEVEL: z.enum(['low', 'medium', 'high']).default('low'),
  GEMINI_SDK_TIMEOUT_MS: z.coerce.number().default(30000),
  GEMINI_ATTEMPT_TIMEOUT_MS: z.coerce.number().default(10000),
  GEMINI_TOOL_ATTEMPT_TIMEOUT_MS: z.coerce.number().default(18000),

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
  COMMERCE_TASK_MAX_STEPS: z.coerce.number().default(25),
  TOOL_TIMEOUT_MS: z.coerce.number().default(7000),
  TOTAL_AGENT_DEADLINE_MS: z.coerce.number().default(22000),
  COMMERCE_TASK_DEADLINE_MS: z.coerce.number().default(120000),
  BROWSER_NAVIGATION_TIMEOUT_MS: z.coerce.number().default(25000),
  BROWSER_CLICK_TIMEOUT_MS: z.coerce.number().default(12000),
  BROWSER_TYPE_TIMEOUT_MS: z.coerce.number().default(12000),
  BROWSER_READ_TIMEOUT_MS: z.coerce.number().default(12000),
  BROWSER_SCREENSHOT_TIMEOUT_MS: z.coerce.number().default(12000),
  BROWSER_ACTION_TIMEOUT_MS: z.coerce.number().default(12000),
  WEB_SEARCH_TIMEOUT_MS: z.coerce.number().default(10000),
  RATE_LIMIT_MAX_REQUESTS_PER_MINUTE: z.coerce.number().default(30),
  APPROVAL_TIMEOUT_MINUTES: z.coerce.number().default(60),
});

export const GEMINI_SDK_TIMEOUT_MS = 30000;
export const GEMINI_SDK_TIMEOUT = GEMINI_SDK_TIMEOUT_MS;
export const GEMINI_ATTEMPT_TIMEOUT_MS = 10000;
export const GEMINI_ATTEMPT_TIMEOUT = GEMINI_ATTEMPT_TIMEOUT_MS;
export const GEMINI_TOOL_ATTEMPT_TIMEOUT_MS = 18000;
export const GEMINI_TOOL_ATTEMPT_TIMEOUT = GEMINI_TOOL_ATTEMPT_TIMEOUT_MS;

export const BROWSER_NAVIGATION_TIMEOUT_MS = 25000;
export const BROWSER_CLICK_TIMEOUT_MS = 12000;
export const BROWSER_TYPE_TIMEOUT_MS = 12000;
export const BROWSER_READ_TIMEOUT_MS = 12000;
export const BROWSER_SCREENSHOT_TIMEOUT_MS = 12000;
export const BROWSER_ACTION_TIMEOUT_MS = 12000;
export const BROWSER_TIMEOUT_MS = 25000;
export const BROWSER_TIMEOUT = BROWSER_NAVIGATION_TIMEOUT_MS;

export const WEB_SEARCH_TIMEOUT_MS = 10000;
export const DEFAULT_TOOL_TIMEOUT_MS = 7000;
export const TOOL_TIMEOUT_MS = 7000;
export const TOOL_TIMEOUT = TOOL_TIMEOUT_MS;

export const BROWSER_READINESS_TIMEOUT_MS = 8000;
export const BROWSER_READINESS_TIMEOUT = BROWSER_READINESS_TIMEOUT_MS;
export const COMPUTER_USE_TASK_DEADLINE_MS = 60000;
export const COMPUTER_USE_DEADLINE_MS = COMPUTER_USE_TASK_DEADLINE_MS;
export const REQUEST_MESSAGE_DEADLINE_MS = 22000;
export const AGENT_PLANNING_DEADLINE_MS = 15000;

export const TOTAL_AGENT_DEADLINE_MS = 22000;
export const AGENT_TOTAL_DEADLINE_MS = TOTAL_AGENT_DEADLINE_MS;
export const AGENT_TOTAL_DEADLINE = TOTAL_AGENT_DEADLINE_MS;
export const COMMERCE_TASK_DEADLINE_MS = 120000;
export const MAX_AGENT_STEPS = 5;
export const COMMERCE_TASK_MAX_STEPS = 25;

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
