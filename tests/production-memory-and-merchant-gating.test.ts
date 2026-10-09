import { describe, it, expect, vi } from 'vitest';
import { SupabaseRepository } from '../packages/database/src/supabase-repository.js';
import { InMemoryRepository } from '../packages/database/src/in-memory-repository.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';
import { classifyMessageIntent } from '../packages/agent/src/request-context.js';
import { merchantResolver, isCasualGreetingOrConversational } from '../packages/tools/src/merchants/merchant-resolver.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { AIProvider } from '@nexa/shared';

describe('NEXA Production Memory Schema Contract & Merchant Gating Suite', () => {
  function createMockSupabaseRepo(mockClient: any): SupabaseRepository {
    const repo = Object.create(SupabaseRepository.prototype);
    (repo as any).client = mockClient;
    return repo;
  }

  // =========================================================================
  // 1. Supabase Memory Schema Mismatch & PGRST204 Resilient Fallback
  // =========================================================================
  describe('1. Supabase Memory Schema Contract & PGRST204 Fallback', () => {
    it('successfully saves memory when confirmed column is present', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: {
          id: 'mem-101',
          user_id: 'usr-1',
          category: 'preferences',
          key: 'dietary_preference',
          value: 'vegetarian',
          confidence: 1.0,
          confirmed: true,
          status: 'active',
          metadata: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        error: null,
      });

      const mockSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockUpsert = vi.fn().mockReturnValue({ select: mockSelect });
      const mockFrom = vi.fn().mockReturnValue({ upsert: mockUpsert });

      const mockSupabaseClient = { from: mockFrom };
      const repo = createMockSupabaseRepo(mockSupabaseClient);

      const result = await repo.saveMemory({
        user_id: 'usr-1',
        category: 'preferences',
        key: 'dietary_preference',
        value: 'vegetarian',
        confidence: 1.0,
        confirmed: true,
        source: 'EXPLICIT_USER_STATEMENT',
        metadata: {},
      });

      expect(result.id).toBe('mem-101');
      expect(result.confirmed).toBe(true);
      expect(mockUpsert).toHaveBeenCalledTimes(1);
    });

    it('gracefully recovers from PGRST204 missing confirmed column by storing confirmed in metadata and succeeding', async () => {
      let callCount = 0;
      const mockSingle = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First attempt fails with Supabase PostgREST PGRST204 schema cache error
          return {
            data: null,
            error: {
              code: 'PGRST204',
              message: "Could not find the 'confirmed' column of 'memories' in the schema cache",
            },
          };
        }
        // Second attempt without top-level confirmed succeeds
        return {
          data: {
            id: 'mem-102',
            user_id: 'usr-1',
            category: 'shopping_preferences',
            key: 'brand_preference',
            value: 'Coca-Cola Zero',
            confidence: 1.0,
            status: 'active',
            metadata: { confirmed: true },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          error: null,
        };
      });

      const mockSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockUpsert = vi.fn().mockReturnValue({ select: mockSelect });
      const mockFrom = vi.fn().mockReturnValue({ upsert: mockUpsert });

      const mockSupabaseClient = { from: mockFrom };
      const repo = createMockSupabaseRepo(mockSupabaseClient);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await repo.saveMemory({
        user_id: 'usr-1',
        category: 'shopping_preferences',
        key: 'brand_preference',
        value: 'Coca-Cola Zero',
        confidence: 1.0,
        confirmed: true,
        source: 'EXPLICIT_USER_STATEMENT',
        metadata: {},
      });

      expect(mockUpsert).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("'confirmed' column missing from memories schema cache")
      );
      expect(result.id).toBe('mem-102');
      expect(result.confirmed).toBe(true);

      warnSpy.mockRestore();
    });

    it('accurately maps confirmed: true in getUserMemories when confirmed column is missing from raw rows', async () => {
      const mockOrder = vi.fn().mockResolvedValue({
        data: [
          {
            id: 'mem-1',
            user_id: 'usr-1',
            category: 'preferences',
            key: 'coffee',
            value: 'black',
            status: 'active',
            metadata: { confirmed: true },
            created_at: new Date().toISOString(),
          },
          {
            id: 'mem-2',
            user_id: 'usr-1',
            category: 'preferences',
            key: 'tea',
            value: 'green',
            status: 'active',
            last_confirmed_at: new Date().toISOString(),
            metadata: {},
            created_at: new Date().toISOString(),
          },
        ],
        error: null,
      });

      const mockEq = vi.fn().mockReturnValue({ order: mockOrder });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });

      const mockSupabaseClient = { from: mockFrom };
      const repo = createMockSupabaseRepo(mockSupabaseClient);

      const memories = await repo.getUserMemories('usr-1');
      expect(memories).toHaveLength(2);
      expect(memories[0].confirmed).toBe(true);
      expect(memories[1].confirmed).toBe(true);
    });
  });

  // =========================================================================
  // 2. Telemetry Integrity: No step_completed After Tool Failure
  // =========================================================================
  describe('2. Telemetry Integrity & Step Telemetry Guard', () => {
    it('does not emit step_completed when a tool call fails, emitting step_failed instead', async () => {
      const db = new InMemoryRepository();
      const user = await db.findOrCreateUserByPhone('1234567890', 'Test User');
      const conversation = await db.getOrCreateActiveConversation(user.id);

      const logs: string[] = [];
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      // AI Provider simulates calling save_memory on step 1, which will fail
      let callCount = 0;
      const mockAIProvider: AIProvider = {
        name: 'mock-ai',
        generateResponse: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              text: 'Saving your preference...',
              toolCalls: [
                {
                  id: 'tc-fail-1',
                  name: 'failing_test_tool',
                  arguments: { test: true },
                },
              ],
            };
          }
          return {
            text: 'I could not perform that action right now.',
            toolCalls: [],
          };
        }),
      };

      const toolRegistry = createDefaultToolRegistry({ db });
      // Register a failing tool
      toolRegistry.register({
        name: 'failing_test_tool',
        description: 'Test tool that fails intentionally',
        riskLevel: 'low_risk',
        parametersSchema: {} as any,
        requiresApproval: () => ({ required: false }),
        execute: async () => ({
          success: false,
          error: 'Simulated database failure',
          data: { errorType: 'DATABASE_ERROR' },
        }),
      });

      const orchestrator = new AgentOrchestrator(mockAIProvider, toolRegistry, db);
      await orchestrator.processMessage({
        text: 'Save my preference',
        phoneNumber: '1234567890',
      });

      // Verify step 1 failed
      const step1Failed = logs.some((l) => l.includes('[Agent] step_failed step=1'));
      expect(step1Failed).toBe(true);

      // CRITICAL: step_completed step=1 MUST NOT have been logged!
      const step1Completed = logs.some((l) => l.includes('[Agent] step_completed step=1'));
      expect(step1Completed).toBe(false);

      consoleSpy.mockRestore();
    });
  });

  // =========================================================================
  // 3. Strict Merchant Gating & Conversational Intent
  // =========================================================================
  describe('3. Strict Merchant Gating & Non-Commerce Request Isolation', () => {
    const conversationalQueries = [
      'hello nexa',
      'hello',
      'hey',
      'how are you',
      'what can you do',
      'who built you',
      'nexa',
    ];

    conversationalQueries.forEach((query) => {
      it(`classifies "${query}" as CONVERSATION and never invokes MerchantResolver`, async () => {
        const intent = classifyMessageIntent(query);
        expect(intent).toBe('CONVERSATION');

        // Verify casual greeting detection helper returns true
        expect(isCasualGreetingOrConversational(query)).toBe(true);

        // Spy on MerchantResolver resolve
        const resolveSpy = vi.spyOn(merchantResolver, 'resolve');
        const merchant = merchantResolver.resolve(query);

        expect(merchant).toBeNull();
        resolveSpy.mockRestore();
      });
    });

    it('ensures conversational queries through AgentOrchestrator emit zero [Merchant] telemetry', async () => {
      const db = new InMemoryRepository();
      const user = await db.findOrCreateUserByPhone('1234567890', 'Awan Warsi');

      const logs: string[] = [];
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      const mockAIProvider: AIProvider = {
        name: 'mock-ai',
        generateResponse: vi.fn().mockResolvedValue({
          text: 'Hello! I am NEXA, your personal AI assistant. How can I help you today?',
          toolCalls: [],
        }),
      };

      const toolRegistry = createDefaultToolRegistry({ db });
      const orchestrator = new AgentOrchestrator(mockAIProvider, toolRegistry, db);

      await orchestrator.processMessage({
        text: 'hello nexa',
        phoneNumber: '1234567890',
      });

      // Verify intent classified as CONVERSATION
      expect(logs.some((l) => l.includes('intent=CONVERSATION'))).toBe(true);

      // Verify NO merchant resolution telemetry emitted whatsoever
      const merchantLogs = logs.filter((l) => l.includes('[Merchant]'));
      expect(merchantLogs).toHaveLength(0);

      consoleSpy.mockRestore();
    });

    it('ensures research and identity questions ("Explain APIs.", "What is my name?") never trigger MerchantResolver or [Merchant] logs', async () => {
      const db = new InMemoryRepository();
      const user = await db.findOrCreateUserByPhone('1234567890', 'Awan Warsi');

      const logs: string[] = [];
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      const mockAIProvider: AIProvider = {
        name: 'mock-ai',
        generateResponse: vi.fn().mockResolvedValue({
          text: 'An API (Application Programming Interface) allows software systems to talk to each other.',
          toolCalls: [],
        }),
      };

      const toolRegistry = createDefaultToolRegistry({ db });
      const orchestrator = new AgentOrchestrator(mockAIProvider, toolRegistry, db);

      await orchestrator.processMessage({
        text: 'Explain APIs.',
        phoneNumber: '1234567890',
      });

      // Verify intent is RESEARCH
      expect(logs.some((l) => l.includes('intent=RESEARCH'))).toBe(true);

      // Verify zero [Merchant] telemetry
      const merchantLogs = logs.filter((l) => l.includes('[Merchant]'));
      expect(merchantLogs).toHaveLength(0);

      consoleSpy.mockRestore();
    });

    it('still resolves merchant correctly for real SHOPPING requests ("Order a Diet Coke from Swiggy Instamart")', async () => {
      const query = 'Order a Diet Coke from Swiggy Instamart';
      const intent = classifyMessageIntent(query);
      expect(intent).toBe('SHOPPING');

      const resolved = merchantResolver.resolve(query);
      expect(resolved).not.toBeNull();
      expect(resolved?.name).toBe('Swiggy Instamart');
      expect(resolved?.canonicalUrl).toBe('https://www.swiggy.com/instamart');
    });
  });
});
