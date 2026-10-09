import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SupabaseRepository } from '../packages/database/src/supabase-repository.js';
import { InMemoryRepository } from '../packages/database/src/in-memory-repository.js';
import { MemoryService } from '../packages/database/src/memory-service.js';
import { DuckDuckGoSearchProvider, createWebSearchTool } from '../packages/tools/src/tools/web-search.js';
import { createShoppingTools, clearUserCart, getUserCart } from '../packages/tools/src/tools/shopping-tools.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';
import { AIProvider, ToolExecutionContext, Memory } from '@nexa/shared';

describe('NEXA Reconciled Memory Schema Contract & Search Recovery Suite', () => {
  function createMockSupabaseRepo(mockClient: any): SupabaseRepository {
    const repo = Object.create(SupabaseRepository.prototype);
    (repo as any).client = mockClient;
    (repo as any).hasExtendedMemoryColumns = null;
    return repo;
  }

  // =========================================================================
  // 1. RECONCILED COMPLETE MEMORY SCHEMA CONTRACT
  // =========================================================================
  describe('1. Reconciled Memory Schema Contract (Eliminates Piecemeal Fallbacks)', () => {
    it('gracefully recovers when PostgREST schema cache is missing evidence_summary (production Oct 9 error)', async () => {
      let upsertCallCount = 0;
      let secondPayload: any = null;

      const mockSingle = vi.fn().mockImplementation(async () => {
        upsertCallCount++;
        if (upsertCallCount === 1) {
          // First attempt with full payload fails with PostgREST schema cache error for evidence_summary
          return {
            data: null,
            error: {
              code: 'PGRST204',
              message: "Could not find the 'evidence_summary' column of 'memories' in the schema cache",
            },
          };
        }
        // Second attempt with basePayload (all extended fields in metadata) succeeds
        return {
          data: {
            id: 'mem-201',
            user_id: 'usr-1',
            category: 'episodic_experience',
            key: 'task_screen_guard_1',
            value: JSON.stringify({ task: 'iPhone 16 screen guard', success: true }),
            confidence: 0.95,
            metadata: secondPayload?.metadata || {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          error: null,
        };
      });

      const mockSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockUpsert = vi.fn().mockImplementation((payload: any) => {
        if (upsertCallCount === 1) {
          secondPayload = payload;
        }
        return { select: mockSelect };
      });
      const mockFrom = vi.fn().mockReturnValue({ upsert: mockUpsert });

      const mockSupabaseClient = { from: mockFrom };
      const repo = createMockSupabaseRepo(mockSupabaseClient);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await repo.saveMemory({
        user_id: 'usr-1',
        category: 'episodic_experience',
        key: 'task_screen_guard_1',
        value: JSON.stringify({ task: 'iPhone 16 screen guard', success: true }),
        confidence: 0.95,
        source: 'VERIFIED_TASK_OUTCOME',
        confirmed: true,
        version: 1,
        evidence_summary: 'Task: Find 3-pack screen guard -> Success: true',
        sensitivity: 'low',
        status: 'active',
        metadata: {},
      });

      expect(upsertCallCount).toBe(2);
      expect(result.id).toBe('mem-201');
      // Extended fields were preserved inside metadata and unpacked back to top-level
      expect(result.evidence_summary).toBe('Task: Find 3-pack screen guard -> Success: true');
      expect(result.source).toBe('VERIFIED_TASK_OUTCOME');
      expect(result.confirmed).toBe(true);
      expect(result.status).toBe('active');

      // Verify secondPayload used only guaranteed base columns
      expect(secondPayload.evidence_summary).toBeUndefined();
      expect(secondPayload.source).toBeUndefined();
      expect(secondPayload.confirmed).toBeUndefined();
      expect(secondPayload.metadata.evidence_summary).toBe('Task: Find 3-pack screen guard -> Success: true');

      warnSpy.mockRestore();
    });

    it('caches hasExtendedMemoryColumns=false and directly uses basePayload for subsequent memory writes', async () => {
      let upsertCallCount = 0;

      const mockSingle = vi.fn().mockImplementation(async () => {
        upsertCallCount++;
        if (upsertCallCount === 1) {
          return {
            data: null,
            error: {
              code: 'PGRST204',
              message: "Could not find column in schema cache",
            },
          };
        }
        return {
          data: {
            id: `mem-${upsertCallCount}`,
            user_id: 'usr-1',
            category: 'preferences',
            key: `key_${upsertCallCount}`,
            value: 'val',
            confidence: 1.0,
            metadata: {},
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

      // Call 1: fails on full payload, falls back to base payload (2 calls)
      await repo.saveMemory({
        user_id: 'usr-1',
        category: 'preferences',
        key: 'key_1',
        value: 'val_1',
        confidence: 1.0,
        confirmed: true,
        evidence_summary: 'test 1',
        metadata: {},
      });
      expect(upsertCallCount).toBe(2);

      // Call 2: directly uses base payload, zero failing round-trips (1 call)
      await repo.saveMemory({
        user_id: 'usr-1',
        category: 'preferences',
        key: 'key_2',
        value: 'val_2',
        confidence: 1.0,
        confirmed: true,
        evidence_summary: 'test 2',
        metadata: {},
      });
      expect(upsertCallCount).toBe(3);

      warnSpy.mockRestore();
    });

    it('getUserMemories unpacks all extended fields from metadata when table columns are absent', async () => {
      const mockOrder = vi.fn().mockResolvedValue({
        data: [
          {
            id: 'mem-301',
            user_id: 'usr-1',
            category: 'preferences',
            key: 'screen_guard_type',
            value: 'tempered glass 3-pack',
            confidence: 1.0,
            metadata: {
              confirmed: true,
              source: 'USER_CORRECTION',
              version: 2,
              evidence_summary: 'User requested 3-pack explicitly',
              sensitivity: 'low',
              status: 'active',
              last_confirmed_at: '2026-10-09T10:00:00Z',
              correction_history: [
                { timestamp: '2026-10-09T09:00:00Z', previous_value: 'single pack' },
              ],
            },
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
      expect(memories).toHaveLength(1);
      const m = memories[0];
      expect(m.confirmed).toBe(true);
      expect(m.source).toBe('USER_CORRECTION');
      expect(m.version).toBe(2);
      expect(m.evidence_summary).toBe('User requested 3-pack explicitly');
      expect(m.status).toBe('active');
      expect(m.correction_history).toHaveLength(1);
      expect(m.last_confirmed_at).toBe('2026-10-09T10:00:00Z');
    });

    it('MemoryService records episodic experience and procedural workflows with resilient metadata contract', async () => {
      const db = new InMemoryRepository();
      const memoryService = new MemoryService(db);
      const user = await db.findOrCreateUserByPhone('9876543210', 'Alex');

      // Record episodic experience with evidenceSummary
      const experience = await memoryService.recordEpisodicExperience({
        userId: user.id,
        taskRequest: 'Find 3-pack iPhone 16 Pro Max screen guard under ₹1,500 on Amazon',
        approach: 'Direct browser navigation to Amazon -> search -> select 3-pack -> verify cart',
        toolsUsed: ['shopping_search', 'shopping_select_product', 'shopping_verify_cart'],
        outcome: '3-pack added to cart and verified within budget',
        success: true,
        learning: 'Direct merchant navigation is resilient to external search engine rate-limits',
        reusable: true,
      });

      expect(experience.category).toBe('episodic_experience');
      expect(experience.source).toBe('VERIFIED_TASK_OUTCOME');
      expect(experience.confidence).toBe(0.95);
      expect(experience.evidence_summary).toContain('Find 3-pack iPhone 16 Pro Max screen guard');

      // Retrieve memories and verify user isolation
      const relevant = await memoryService.getRelevantMemories(user.id, 'buy screen guard on amazon');
      expect(relevant.some((m) => m.category === 'episodic_experience')).toBe(true);

      // Verify other user cannot read this user's experience
      const otherUser = await db.findOrCreateUserByPhone('1112223334', 'Other');
      const otherMemories = await memoryService.getRelevantMemories(otherUser.id, 'buy screen guard on amazon');
      expect(otherMemories).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2. WEBSEARCH MULTI-TIER FALLBACK & BOUNDED TIMEOUT RECOVERY
  // =========================================================================
  describe('2. WebSearch Multi-Tier Fallback & Transient Timeout Recovery', () => {
    it('DuckDuckGoSearchProvider falls back to Lite endpoint when HTML endpoint fails', async () => {
      const provider = new DuckDuckGoSearchProvider();

      // Mock fetch: first call (HTML endpoint) fails with 403 / network error, second call (Lite endpoint) succeeds
      const originalFetch = global.fetch;
      let fetchCallCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: any, init?: any) => {
        fetchCallCount++;
        const urlStr = String(url);
        if (urlStr.includes('/html/')) {
          // Simulate DuckDuckGo rate limiting or 403 on cloud IP
          return {
            ok: false,
            status: 403,
            text: async () => 'Forbidden',
          };
        }
        if (urlStr.includes('/lite/')) {
          // Lite endpoint returns valid minimal HTML
          const liteHtml = `
            <html><body>
              <table class="results">
                <tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.amazon.in%2Fdp%2FB0DGL9V5">Spigen iPhone 16 Pro Max Screen Guard (3 Pack)</a></td></tr>
                <tr><td class="result-snippet">Tempered glass screen protector 3 pack for iPhone 16 Pro Max. Hardness 9H.</td></tr>
              </table>
            </body></html>
          `;
          return {
            ok: true,
            status: 200,
            text: async () => liteHtml,
          };
        }
        return { ok: false, status: 500, text: async () => '' };
      }) as any;

      try {
        const results = await provider.search('iPhone 16 Pro Max screen guard 3 pack', 3, { timeoutMs: 5000 });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].title).toContain('Spigen iPhone 16 Pro Max Screen Guard (3 Pack)');
        expect(results[0].url).toBe('https://www.amazon.in/dp/B0DGL9V5');
        expect(fetchCallCount).toBeGreaterThanOrEqual(2);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('web_search tool returns structured transient error with recovery action on timeout', async () => {
      const mockSearchProvider = {
        search: vi.fn().mockRejectedValue(new Error('Web search timed out after 4000ms')),
      };

      const tool = createWebSearchTool(mockSearchProvider);
      const executionContext: ToolExecutionContext = {
        user: { id: 'usr-1', phone_number: '123', role: 'user', status: 'active', preferences: {}, created_at: '', updated_at: '' },
        conversation: { id: 'conv-1', user_id: 'usr-1', channel: 'whatsapp', status: 'active', metadata: {}, created_at: '', updated_at: '' },
        messageId: 'msg-1',
        sourceChannel: 'whatsapp',
      };

      const result = await tool.execute(
        { query: 'buy iPhone 16 Pro Max screen guard amazon' },
        executionContext
      );

      expect(result.success).toBe(false);
      expect((result.data as any)?.errorType).toBe('TIMEOUT');
      expect((result.data as any)?.retriable).toBe(true);
      expect((result.data as any)?.suggestedAction).toContain('Amazon');
      expect(result.userFacingMessage).toContain('unable to retrieve results');
    });
  });

  // =========================================================================
  // 3. AMAZON SCREEN-GUARD WORKFLOW CONTINUITY & SEARCH TIMEOUT RECOVERY
  // =========================================================================
  describe('3. Amazon Screen-Guard Workflow Continuity with Search Timeout Recovery', () => {
    it('orchestrator does not abort task when web_search is disabled, successfully completing via direct Amazon shopping route', async () => {
      const db = new InMemoryRepository();
      const user = await db.findOrCreateUserByPhone('9988776655', 'Jordan');
      const conversation = await db.getOrCreateActiveConversation(user.id);
      clearUserCart(user.id);

      const logs: string[] = [];
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });

      // AI Provider simulates:
      // Turn 1: Model calls web_search (fails with timeout)
      // Turn 2: Model retries web_search (fails with timeout, gets disabled)
      // Turn 3: Model receives disabledMsg with Amazon guidance -> switches to shopping_search on Amazon
      // Turn 4: Model selects product (Spigen 3-pack screen guard, ₹899) and adds to cart
      // Turn 5: Model verifies cart with maxBudget=1500 and minPackSize=3 -> passes
      // Turn 6: Model calls shopping_checkout -> pauses for approval
      let stepCount = 0;
      const mockAIProvider: AIProvider = {
        name: 'mock-gemini',
        generateResponse: vi.fn().mockImplementation(async () => {
          stepCount++;
          if (stepCount === 1) {
            return {
              text: 'Searching for iPhone 16 Pro Max screen guards...',
              toolCalls: [{ id: 'tc-ws-1', name: 'web_search', arguments: { query: 'iPhone 16 Pro Max screen guard 3 pack amazon' } }],
            };
          }
          if (stepCount === 2) {
            return {
              text: 'Retrying search with rephrased query...',
              toolCalls: [{ id: 'tc-ws-2', name: 'web_search', arguments: { query: 'iPhone 16 Pro Max screen protector 3-pack amazon' } }],
            };
          }
          if (stepCount === 3) {
            // Model received disabled message with Amazon redirection; switches to shopping_search
            return {
              text: 'Web search timed out; searching Amazon store directly...',
              toolCalls: [{ id: 'tc-shop-1', name: 'shopping_search', arguments: { query: 'iPhone 16 Pro Max screen guard 3-pack', merchant: 'Amazon' } }],
            };
          }
          if (stepCount === 4) {
            // Add 3-pack Spigen screen guard for ₹899 to cart
            return {
              text: 'Found Spigen 3-Pack Screen Guard for ₹899 on Amazon. Adding to cart...',
              toolCalls: [
                {
                  id: 'tc-add-1',
                  name: 'shopping_add_to_cart',
                  arguments: {
                    productName: 'Spigen EZ Fit Tempered Glass Screen Protector for iPhone 16 Pro Max (3 Pack)',
                    price: 899,
                    merchant: 'Amazon',
                    quantity: 1,
                    packSize: 3,
                    currency: 'INR',
                  },
                },
              ],
            };
          }
          if (stepCount === 5) {
            // Verify cart satisfies ₹1,500 budget and 3-pack requirement
            return {
              text: 'Verifying cart items and budget limit...',
              toolCalls: [
                {
                  id: 'tc-ver-1',
                  name: 'shopping_verify_cart',
                  arguments: {
                    merchant: 'Amazon',
                    maxBudget: 1500,
                    minPackSize: 3,
                  },
                },
              ],
            };
          }
          if (stepCount === 6) {
            // Initiate checkout
            return {
              text: 'Proceeding to checkout for approval...',
              toolCalls: [
                {
                  id: 'tc-chk-1',
                  name: 'shopping_checkout',
                  arguments: {
                    merchant: 'Amazon',
                    amount: 899,
                    itemSummary: '1x Spigen Tempered Glass Screen Protector (3 Pack)',
                  },
                },
              ],
            };
          }
          return {
            text: 'Ready for confirmation.',
            toolCalls: [],
          };
        }),
      };

      const failingSearchProvider = {
        search: vi.fn().mockRejectedValue(new Error('Web search timed out after 3000ms')),
      };

      const toolRegistry = createDefaultToolRegistry({
        db,
        searchProvider: failingSearchProvider,
      });

      const orchestrator = new AgentOrchestrator(
        mockAIProvider,
        toolRegistry,
        db,
        12,        // maxSteps
        undefined, // whatsappClient
        3000       // toolTimeoutMs
      );

      const response = await orchestrator.processMessage({
        phoneNumber: '9988776655',
        name: 'Jordan',
        text: 'Find three iPhone 16 Pro Max screen guards on Amazon under ₹1,500 and show me a screenshot of the cart',
      });

      // Verify task did NOT abort with "unable to access web"
      expect(response.replyText).not.toContain("unable to access the web or online services");
      expect(response.requiresApproval).toBe(true);
      expect(response.approvalPrompt).toContain('Order Confirmation Required');
      expect(response.approvalPrompt).toContain('Amazon');
      expect(response.approvalPrompt).toContain('899');

      // Verify cart state
      const cart = getUserCart(user.id);
      expect(cart).toBeDefined();
      expect(cart?.items).toHaveLength(1);
      expect(cart?.items[0].packSize).toBe(3);
      expect(cart?.items[0].priceMinor).toBe(89900); // ₹899 <= ₹1500

      // Verify telemetry logged tool disabled and recovery without false terminal failure
      expect(logs.some((l) => l.includes('tool_disabled name=web_search'))).toBe(true);
      expect(logs.some((l) => l.includes('verification_passed'))).toBe(true);
      expect(logs.some((l) => l.includes('waiting_approval tool=shopping_checkout'))).toBe(true);

      consoleSpy.mockRestore();
    });
  });
});
