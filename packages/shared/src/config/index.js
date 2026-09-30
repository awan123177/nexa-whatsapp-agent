"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigSchema = void 0;
exports.loadConfig = loadConfig;
const zod_1 = require("zod");
exports.ConfigSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'test', 'production']).default('development'),
    PORT: zod_1.z.coerce.number().default(3000),
    HOST: zod_1.z.string().default('0.0.0.0'),
    LOG_LEVEL: zod_1.z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    // Gemini AI
    GEMINI_API_KEY: zod_1.z.string().min(1, 'GEMINI_API_KEY is required for AI operations').optional(),
    GEMINI_MODEL: zod_1.z.string().default('gemini-2.5-flash'),
    // WhatsApp Cloud API
    WHATSAPP_ACCESS_TOKEN: zod_1.z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: zod_1.z.string().optional(),
    WHATSAPP_BUSINESS_ACCOUNT_ID: zod_1.z.string().optional(),
    WHATSAPP_VERIFY_TOKEN: zod_1.z.string().optional(),
    WHATSAPP_APP_SECRET: zod_1.z.string().optional(),
    // Supabase Database
    SUPABASE_URL: zod_1.z.string().url().optional(),
    SUPABASE_ANON_KEY: zod_1.z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: zod_1.z.string().optional(),
    // Search Providers (Optional)
    TAVILY_API_KEY: zod_1.z.string().optional(),
    SERPER_API_KEY: zod_1.z.string().optional(),
    // Agent Config
    MAX_AGENT_STEPS: zod_1.z.coerce.number().default(10),
    RATE_LIMIT_MAX_REQUESTS_PER_MINUTE: zod_1.z.coerce.number().default(30),
    APPROVAL_TIMEOUT_MINUTES: zod_1.z.coerce.number().default(60),
});
function loadConfig(env = process.env) {
    const result = exports.ConfigSchema.safeParse(env);
    if (!result.success) {
        const formattedErrors = result.error.errors
            .map((err) => `  - ${err.path.join('.')}: ${err.message}`)
            .join('\n');
        throw new Error(`Configuration Validation Error:\n${formattedErrors}`);
    }
    return result.data;
}
//# sourceMappingURL=index.js.map