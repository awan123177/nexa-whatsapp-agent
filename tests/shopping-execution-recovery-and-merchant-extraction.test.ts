import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SupabaseRepository } from '../packages/database/src/supabase-repository.js';
import { InMemoryRepository } from '../packages/database/src/in-memory-repository.js';
import { DuckDuckGoSearchProvider } from '../packages/tools/src/tools/web-search.js';
import { createShoppingTools, clearUserCart, getUserCart } from '../packages/tools/src/tools/shopping-tools.js';
import { merchantResolver } from '../packages/tools/src/merchants/merchant-resolver.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';
import { AIProvider, ToolExecutionContext, User, Conversation } from '@nexa/shared';

describe('NEXA Shopping Execution Recovery & Merchant Extraction Suite', () => {
  let db: InMemoryRepository;
  let user: User;
  let conversation: Conversation;
  let mockContext: ToolExecutionContext;

  beforeEach(async () => {
    db = new InMemoryRepository();
    user = await db.findOrCreateUserByPhone('9988776655', 'Jordan');
    conversation = await db.getOrCreateActiveConversation(user.id, 'whatsapp');
    clearUserCart(user.id);

    mockContext = {
      user,
      conversation,
      messageId: 'msg-test-1',
      sourceChannel: 'whatsapp',
      sessionId: user.id,
      taskId: 'task-test-1',
      requestId: 'req-test-1',
    };
  });

  afterEach(() => {
    clearUserCart(user.id);
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. ABORTED SEARCH REQUESTS RETURN STRUCTURED FAILURE (NOT FALSE SUCCESS)
  // =========================================================================
  describe('1. Search Error Handling: Aborted Requests & Failures', () => {
    it('aborted search request returns structured failure and NOT false success', async () => {
      const abortController = new AbortController();
      abortController.abort(new Error('Operation aborted by user deadline'));

      const mockProvider = {
        search: vi.fn().mockImplementation(async (_query, _max, options) => {
          if (options?.signal?.aborted) {
            throw new Error('Search aborted by caller');
          }
          return [];
        }),
      };

      const tools = createShoppingTools(mockProvider, db);
      const searchProductsTool = tools.find((t) => t.name === 'search_products')!;

      const result = await searchProductsTool.execute(
        { query: 'iPhone 16 Pro Max screen guard' },
        { ...mockContext, abortSignal: abortController.signal, timeoutMs: 5000 }
      );

      // CRITICAL: Must be success: false, NOT false success with products: []
      expect(result.success).toBe(false);
      expect(result.error).toContain('Search aborted');
      expect((result.data as any)?.success).toBe(false);
      expect((result.data as any)?.errorType).toBe('TIMEOUT');
      expect((result.data as any)?.retriable).toBe(true);
      expect((result.data as any)?.suggestedAction).toContain('Amazon');
      expect(result.userFacingMessage).toContain('unable to retrieve live items');
    });

    it('timed-out search request returns structured TIMEOUT failure', async () => {
      const mockProvider = {
        search: vi.fn().mockRejectedValue(new Error('Web search timed out after 4000ms')),
      };

      const tools = createShoppingTools(mockProvider, db);
      const searchProductsTool = tools.find((t) => t.name === 'search_products')!;

      const result = await searchProductsTool.execute(
        { query: 'Sony WH-1000XM5 headphones' },
        { ...mockContext, timeoutMs: 4000 }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
      expect((result.data as any)?.errorType).toBe('TIMEOUT');
      expect((result.data as any)?.retriable).toBe(true);
      expect((result.data as any)?.suggestedAction).toContain('browser automation on the merchant');
    });
  });

  // =========================================================================
  // 2. DISTINGUISHING EMPTY SEARCH RESULTS FROM TIMEOUT/NETWORK ERRORS
  // =========================================================================
  describe('2. Empty Search Results vs Error Distinction', () => {
    it('successful empty search returns success=true with empty=true and count=0', async () => {
      const mockEmptyProvider = {
        search: vi.fn().mockResolvedValue([]),
      };

      const tools = createShoppingTools(mockEmptyProvider, db);
      const searchProductsTool = tools.find((t) => t.name === 'search_products')!;

      const result = await searchProductsTool.execute(
        { query: 'NonExistentProduct123XYZ' },
        mockContext
      );

      // Genuine empty search: success is true, but empty=true and count=0
      expect(result.success).toBe(true);
      expect((result.data as any)?.count).toBe(0);
      expect((result.data as any)?.empty).toBe(true);
      expect((result.data as any)?.products).toEqual([]);
      expect((result.data as any)?.suggestedAction).toContain('browser_open');
      expect(result.userFacingMessage).toContain('No products found matching');
    });

    it('populates product price, packSize, and availability when present in results', async () => {
      const mockProviderWithData = {
        search: vi.fn().mockResolvedValue([
          {
            title: 'Spigen EZ Fit Tempered Glass for iPhone 16 Pro Max (3 Pack)',
            url: 'https://www.amazon.in/dp/B0DFSCREEN3P',
            snippet: 'Pack of 3 screen protectors for iPhone 16 Pro Max. Price: ₹899. In Stock.',
          },
          {
            title: 'ESR Armorite Screen Protector for iPhone 16 Pro Max [Set of 3]',
            url: 'https://www.amazon.in/dp/B0DFESRSET3',
            snippet: 'Includes 3 units ultra-tough tempered glass. ₹1,199. Currently available.',
          },
        ]),
      };

      const tools = createShoppingTools(mockProviderWithData, db);
      const searchProductsTool = tools.find((t) => t.name === 'search_products')!;

      const result = await searchProductsTool.execute(
        { query: 'iPhone 16 Pro Max screen guard 3-pack' },
        mockContext
      );

      expect(result.success).toBe(true);
      const products = (result.data as any)?.products;
      expect(products).toHaveLength(2);

      // Product 1
      expect(products[0].title).toContain('Spigen');
      expect(products[0].price).toBe(899);
      expect(products[0].currency).toBe('INR');
      expect(products[0].packSize).toBe(3);
      expect(products[0].inStock).toBe(true);
      expect(products[0].availability).toBe('In Stock');
      expect(products[0].store).toBe('amazon.in');

      // Product 2
      expect(products[1].title).toContain('ESR');
      expect(products[1].price).toBe(1199);
      expect(products[1].packSize).toBe(3);
      expect(products[1].inStock).toBe(true);
    });
  });

  // =========================================================================
  // 3. MERCHANT EXTRACTION: STORE IDENTIFICATION WITHOUT FULL SENTENCE LOGGING
  // =========================================================================
  describe('3. Correct Merchant Extraction (Prevents Sentence Logging)', () => {
    it('extractMerchant extracts Amazon from natural language user sentence', () => {
      const sentence =
        'Find a set of three iPhone 16 Pro Max screen guards under ₹1,500 on Amazon and take a screenshot of the cart';
      const extracted = merchantResolver.extractMerchant(sentence);

      expect(extracted).toBeDefined();
      expect(extracted?.merchantId).toBe('amazon');
      expect(extracted?.name).toBe('Amazon');
      expect(extracted?.canonicalUrl).toBe('https://www.amazon.in');
    });

    it('resolve logs only the concise merchant token and NEVER the full sentence', () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const sentence =
        'Find a set of three iPhone 16 Pro Max screen guards under ₹1,500 on Amazon and take a screenshot of the cart';

      const resolved = merchantResolver.resolve(sentence);
      expect(resolved?.name).toBe('Amazon');

      const logs = consoleSpy.mock.calls.map((c) => c.join(' '));
      // Must log concise token "amazon"
      expect(logs.some((l) => l.includes('[Merchant] requested merchant="amazon"'))).toBe(true);
      expect(logs.some((l) => l.includes('[Merchant] resolved merchant=Amazon'))).toBe(true);

      // CRITICAL: MUST NOT log the full 110-character user sentence!
      expect(
        logs.some((l) =>
          l.includes(
            '[Merchant] requested merchant="find a set of three iphone 16 pro max screen guards under ₹1,500 on amazon and take a screenshot of the cart"'
          )
        )
      ).toBe(false);

      consoleSpy.mockRestore();
    });

    it('returns null and logs NO requested merchant for queries with no store mentioned', () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const query = 'Find a set of three iPhone 16 Pro Max screen guards under ₹1,500';

      const resolved = merchantResolver.resolve(query);
      expect(resolved).toBeNull();

      const logs = consoleSpy.mock.calls.map((c) => c.join(' '));
      // Should NOT log any requested merchant for a sentence that has no store
      expect(logs.some((l) => l.includes('[Merchant] requested merchant='))).toBe(false);

      consoleSpy.mockRestore();
    });

    it('shopping_search resolves explicit Amazon merchant and falls back gracefully', async () => {
      const tools = createShoppingTools(new DuckDuckGoSearchProvider(), db);
      const shoppingSearch = tools.find((t) => t.name === 'shopping_search')!;

      const result = await shoppingSearch.execute(
        { query: 'iPhone 16 Pro Max screen protector', merchant: 'Amazon' },
        mockContext
      );

      expect(result.success).toBe(true);
      expect((result.data as any)?.merchant).toBe('Amazon');
      expect((result.data as any)?.products[0].store).toBe('Amazon');
    });
  });

  // =========================================================================
  // 4. BROWSER FALLBACK TRANSITION ON SEARCH FAILURE & CART VERIFICATION
  // =========================================================================
  describe('4. Browser Fallback Transition When Search Fails or Returns Empty', () => {
    it('orchestrator does not emit step_completed on search failure and transitions plan to browser fallback', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      let stepCount = 0;

      const mockAI: AIProvider = {
        generateResponse: vi.fn().mockImplementation(async () => {
          stepCount++;
          if (stepCount === 1) {
            // Step 1: Model tries search_products, which fails
            return {
              text: 'Searching for iPhone 16 Pro Max screen guards...',
              toolCalls: [
                {
                  id: 'tc-srch-1',
                  name: 'search_products',
                  arguments: { query: 'iPhone 16 Pro Max screen guard 3-pack under 1500 Amazon' },
                },
              ],
            };
          }
          if (stepCount === 2) {
            // Step 2: Model transitioned to browser fallback on Amazon
            return {
              text: 'Search was unavailable. Navigating directly to Amazon to locate the 3-pack screen guards...',
              toolCalls: [
                {
                  id: 'tc-shop-1',
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
          if (stepCount === 3) {
            // Step 3: Verify cart against ₹1,500 budget and 3-pack requirement
            return {
              text: 'Verifying cart...',
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
          // Step 4: Cart verified, report confirmation
          return {
            text: 'I have verified your Amazon cart with the Spigen 3-pack screen guard for ₹899 (under your ₹1,500 budget). Here is the confirmation.',
            toolCalls: [],
          };
        }),
      };

      const failingProvider = {
        search: vi.fn().mockRejectedValue(new Error('Web search timed out after 4000ms')),
      };

      const toolRegistry = createDefaultToolRegistry({
        db,
        searchProvider: failingProvider,
      });

      const orchestrator = new AgentOrchestrator(mockAI, toolRegistry, db, 10);
      const result = await orchestrator.processMessage({
        phoneNumber: '9988776655',
        name: 'Jordan',
        text: 'Find three iPhone 16 Pro Max screen guards on Amazon under ₹1,500 and show me a screenshot of the cart',
      });

      const logs = consoleSpy.mock.calls.map((c) => c.join(' '));

      // CRITICAL: step 1 MUST NOT have step_completed because search_products failed!
      expect(logs.some((l) => l.includes('[Agent] step_completed step=1'))).toBe(false);
      expect(logs.some((l) => l.includes('[Agent] step_failed step=1 tool=search_products'))).toBe(true);

      // Must log plan transition to browser fallback
      expect(
        logs.some((l) =>
          l.includes('[Agent] plan_transition step=1 from=search to=browser_fallback')
        )
      ).toBe(true);

      // Must succeed in subsequent steps
      expect(logs.some((l) => l.includes('[Agent] verification_passed'))).toBe(true);
      expect(result.replyText).toContain('Spigen');
      expect(result.replyText).toContain('899');

      // Cart verification in memory
      const cart = getUserCart(user.id);
      expect(cart).toBeDefined();
      expect(cart?.items[0].packSize).toBe(3);
      expect(cart?.items[0].priceMinor).toBe(89900); // ₹899 <= ₹1500

      consoleSpy.mockRestore();
    });

    it('rejects cart verification if price exceeds ₹1,500 budget or pack size < 3', async () => {
      const tools = createShoppingTools(new DuckDuckGoSearchProvider(), db);
      const addToCart = tools.find((t) => t.name === 'shopping_add_to_cart')!;
      const verifyCart = tools.find((t) => t.name === 'shopping_verify_cart')!;

      // Add expensive single screen protector (₹1,999, 1-pack)
      await addToCart.execute(
        {
          productName: 'Ultra Premium Single Screen Protector',
          price: 1999,
          merchant: 'Amazon',
          quantity: 1,
          packSize: 1,
          currency: 'INR',
        },
        mockContext
      );

      // Verify with maxBudget 1500 and minPackSize 3
      const verifyResult = await verifyCart.execute(
        { merchant: 'Amazon', maxBudget: 1500, minPackSize: 3 },
        mockContext
      );

      expect(verifyResult.success).toBe(false);
      expect(verifyResult.error).toContain('exceeds budget limit of ₹1500');
    });
  });

  // =========================================================================
  // 5. MEMORY SCHEMA COLD-START CONTRACT
  // =========================================================================
  describe('5. Supabase Memory Schema Cold-Start Contract', () => {
    it('defaults hasExtendedMemoryColumns to false and writes basePayload directly on first call', async () => {
      let insertedPayload: any = null;
      const warnSpy = vi.spyOn(console, 'warn');

      const mockSingle = vi.fn().mockImplementation(async () => {
        return {
          data: {
            id: 'mem-101',
            user_id: 'usr-1',
            category: 'preferences',
            key: 'theme',
            value: 'dark',
            confidence: 1.0,
            metadata: insertedPayload?.metadata || {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          error: null,
        };
      });

      const mockSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockUpsert = vi.fn().mockImplementation((payload: any) => {
        insertedPayload = payload;
        return { select: mockSelect };
      });
      const mockFrom = vi.fn().mockReturnValue({ upsert: mockUpsert });
      const mockClient = { from: mockFrom };

      // Instantiate repository directly
      const repo = Object.create(SupabaseRepository.prototype);
      (repo as any).client = mockClient;
      (repo as any).hasExtendedMemoryColumns = false; // The new production default!

      const saved = await repo.saveMemory({
        user_id: 'usr-1',
        category: 'preferences',
        key: 'theme',
        value: 'dark',
        confidence: 1.0,
        confirmed: true,
        source: 'USER_PROVIDED',
        evidence_summary: 'User explicitly said dark theme',
        metadata: {},
      });

      // Verification: exactly 1 upsert call made directly with basePayload!
      expect(mockUpsert).toHaveBeenCalledTimes(1);
      // No schema error warning logged!
      expect(warnSpy).not.toHaveBeenCalled();

      // Extended fields were cleanly written into metadata
      expect(insertedPayload.confirmed).toBeUndefined();
      expect(insertedPayload.evidence_summary).toBeUndefined();
      expect(insertedPayload.metadata.confirmed).toBe(true);
      expect(insertedPayload.metadata.evidence_summary).toBe('User explicitly said dark theme');

      // Returned memory row has all fields seamlessly restored
      expect(saved.confirmed).toBe(true);
      expect(saved.evidence_summary).toBe('User explicitly said dark theme');

      warnSpy.mockRestore();
    });
  });
});
