import 'dotenv/config';
import { loadConfig } from '@nexa/shared';
import { createDatabaseRepository } from '@nexa/database';
import { createAIProvider } from '@nexa/ai';
import { createDefaultToolRegistry } from '@nexa/tools';
import { PlaywrightBrowserService } from '@nexa/browser';
import { WhatsAppGateway } from '@nexa/whatsapp';
import { InMemoryRateLimiter } from '@nexa/security';
import { buildApp } from './app.js';

async function bootstrap() {
  const config = loadConfig(process.env);

  console.log('----------------------------------------------------');
  console.log('  NEXA - Personal AI Agent Server Initializing');
  console.log('----------------------------------------------------');

  // 1. Initialize Database
  const db = createDatabaseRepository({
    supabaseUrl: config.SUPABASE_URL,
    supabaseKey: config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_ANON_KEY,
  });

  // 2. Initialize AI Provider (Gemini or Mock fallback)
  const aiProvider = createAIProvider({
    apiKey: config.GEMINI_API_KEY,
    model: config.GEMINI_MODEL,
  });
  console.log(`[NEXA] AI Provider initialized: ${aiProvider.name}`);

  // 3. Initialize Controlled Browser Automation
  const browserService = new PlaywrightBrowserService();

  // 4. Initialize Tool Registry with all initial tools
  const toolRegistry = createDefaultToolRegistry({
    db,
    browserService,
  });
  console.log(
    `[NEXA] Registered ${toolRegistry.getAllTools().length} tools: [${toolRegistry
      .getAllTools()
      .map((t) => t.name)
      .join(', ')}]`
  );

  // 5. Initialize WhatsApp Gateway
  const whatsapp = new WhatsAppGateway({
    verifyToken: config.WHATSAPP_VERIFY_TOKEN,
    appSecret: config.WHATSAPP_APP_SECRET,
    accessToken: config.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
  });

  // 6. Security Rate Limiter
  const rateLimiter = new InMemoryRateLimiter({
    maxRequests: config.RATE_LIMIT_MAX_REQUESTS_PER_MINUTE,
    windowMs: 60_000,
  });

  // 7. Build Fastify App
  const app = buildApp({
    db,
    aiProvider,
    toolRegistry,
    whatsapp,
    rateLimiter,
    maxAgentSteps: config.MAX_AGENT_STEPS,
  });

  // Graceful shutdown handling
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      console.log(`\nReceived ${signal}. Gracefully shutting down...`);
      await app.close();
      await browserService.close();
      process.exit(0);
    });
  }

  // Start Server
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    console.log(`[NEXA] Server listening on http://${config.HOST}:${config.PORT}`);
    console.log(`[NEXA] Health check: http://${config.HOST}:${config.PORT}/health`);
    console.log(`[NEXA] WhatsApp Webhook: http://${config.HOST}:${config.PORT}/webhook/whatsapp`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

bootstrap().catch((err) => {
  console.error('[FATAL] Failed to start NEXA:', err);
  process.exit(1);
});
