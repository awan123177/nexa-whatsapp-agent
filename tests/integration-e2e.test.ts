import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { buildApp } from '../apps/api/src/app.js';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { WhatsAppGateway } from '../packages/whatsapp/src/gateway.js';
import { PlaywrightBrowserService } from '../packages/browser/src/index.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';
import { WalletService } from '../packages/tools/src/wallet/wallet-service.js';
import { FlightBookingProvider, FlightProvider, HotelProvider } from '../packages/tools/src/tools/travel-tools.js';

describe('Production End-to-End Mocked Integration Suite (Flows A through G)', () => {
  let testHttpServer: http.Server;
  let testServerPort: number;
  let browserService: PlaywrightBrowserService;

  beforeAll(async () => {
    process.env.ALLOW_LOCAL_TEST_HOSTS = 'true';
    browserService = new PlaywrightBrowserService();

    // Local HTTP server serving deterministic HTML fixtures for browser automation
    testHttpServer = http.createServer((req, res) => {
      const url = req.url || '/';

      if (url === '/blinkit/login') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Blinkit - Sign in</title></head>
            <body>
              <h1>Please log in to continue</h1>
              <p>Enter your mobile number to receive an OTP.</p>
              <input type="text" placeholder="Mobile Number" id="mobile" />
              <button id="send-otp">Send OTP</button>
            </body>
          </html>
        `);
      } else if (url === '/blinkit/store') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Blinkit - 10 Minute Grocery Delivery</title></head>
            <body>
              <h1>Blinkit Store</h1>
              <div id="product-1">
                <span class="name">Amul Taaza Milk 1L</span>
                <span class="price">₹54.00</span>
                <button id="add-to-cart">Add to Cart</button>
              </div>
              <div id="cart-summary">
                <span id="cart-total">₹54.00</span>
              </div>
            </body>
          </html>
        `);
      } else if (url === '/page-content') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Test Knowledge Page</title></head>
            <body>
              <h1>NEXA Verified Data</h1>
              <p id="info">The temperature in New Delhi is 28 degrees Celsius with clear skies.</p>
            </body>
          </html>
        `);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>((resolve) => {
      testHttpServer.listen(0, '127.0.0.1', () => {
        const addr = testHttpServer.address() as any;
        testServerPort = addr.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    delete process.env.ALLOW_LOCAL_TEST_HOSTS;
    if (browserService) {
      await browserService.close();
    }
    if (testHttpServer) {
      await new Promise<void>((resolve) => testHttpServer.close(() => resolve()));
    }
  });

  // =========================================================================
  // Integration Flow A: WhatsApp text -> NEXA -> Gemini -> response -> WhatsApp send
  // =========================================================================
  it('Integration Flow A: WhatsApp text -> NEXA -> Gemini -> response -> WhatsApp send', async () => {
    const db = new InMemoryRepository();
    const user = await db.findOrCreateUserByPhone('15551234001', 'Awan Warsi');
    await db.updateUser(user.id, {
      name: 'Awan Warsi',
      preferred_name: 'Awan Warsi',
      name_confirmed: true,
      name_source: 'USER_PROVIDED',
      preferences: {
        preferred_name: 'Awan Warsi',
        name_confirmed: true,
        name_source: 'USER_PROVIDED',
      },
    });

    const aiProvider = new MockAIProvider(async () => ({
      text: 'Hey Awan! 👋 25 × 4 is 100.',
    }));

    const toolRegistry = createDefaultToolRegistry({ db });
    const whatsapp = new WhatsAppGateway({ verifyToken: 'test_token' });
    const sendSpy = vi.spyOn(whatsapp, 'sendText').mockResolvedValue({ success: true } as any);

    const app = buildApp({ db, aiProvider, toolRegistry, whatsapp });

    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15551234001', phone_number_id: 'PN_1' },
                contacts: [{ profile: { name: 'Awan Warsi' }, wa_id: '15551234001' }],
                messages: [
                  {
                    from: '15551234001',
                    id: 'wamid.flow_a_123',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: "What's 25 × 4?" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/whatsapp',
      payload,
    });

    expect(res.statusCode).toBe(200);

    // Wait for asynchronous agent worker
    await new Promise((r) => setTimeout(r, 80));

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith('15551234001', 'Hey Awan! 👋 25 × 4 is 100.');

    await app.close();
  });

  // =========================================================================
  // Integration Flow B: WhatsApp voice -> media download -> Gemini audio -> response -> WhatsApp send
  // =========================================================================
  it('Integration Flow B: WhatsApp voice -> media download -> Gemini audio -> response -> WhatsApp send', async () => {
    const db = new InMemoryRepository();
    const user = await db.findOrCreateUserByPhone('15551234002', 'Awan Warsi');
    await db.updateUser(user.id, {
      name: 'Awan Warsi',
      preferred_name: 'Awan Warsi',
      name_confirmed: true,
      name_source: 'USER_PROVIDED',
      preferences: {
        preferred_name: 'Awan Warsi',
        name_confirmed: true,
        name_source: 'USER_PROVIDED',
      },
    });

    let receivedAudioMime: string | undefined;
    let receivedAudioBytes: string | undefined;

    const aiProvider = new MockAIProvider(async (messages, options) => {
      receivedAudioMime = options?.currentUserMedia?.mimeType;
      receivedAudioBytes = options?.currentUserMedia?.data;
      return {
        text: 'I listened to your voice note, Awan! Your wallet balance is ₹500.',
      };
    });

    const toolRegistry = createDefaultToolRegistry({ db });
    const whatsapp = new WhatsAppGateway({ verifyToken: 'test_token' });

    // Mock media download
    const dummyAudioBuffer = Buffer.from('RIFF_DUMMY_OPUS_AUDIO_BYTES_TEST');
    vi.spyOn(whatsapp.mediaService, 'downloadMedia').mockResolvedValue({
      id: 'media_audio_test_123',
      buffer: dummyAudioBuffer,
      mimeType: 'audio/ogg; codecs=opus',
      fileSizeBytes: dummyAudioBuffer.length,
    });

    const sendSpy = vi.spyOn(whatsapp, 'sendText').mockResolvedValue({ success: true } as any);

    const app = buildApp({ db, aiProvider, toolRegistry, whatsapp });

    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15551234002', phone_number_id: 'PN_1' },
                contacts: [{ profile: { name: 'Awan Warsi' }, wa_id: '15551234002' }],
                messages: [
                  {
                    from: '15551234002',
                    id: 'wamid.flow_b_voice_123',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'audio',
                    audio: {
                      id: 'media_id_voice_999',
                      mime_type: 'audio/ogg; codecs=opus',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/whatsapp',
      payload,
    });

    expect(res.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 80));

    expect(receivedAudioMime).toBe('audio/ogg; codecs=opus');
    expect(receivedAudioBytes).toBe(dummyAudioBuffer.toString('base64'));
    expect(sendSpy).toHaveBeenCalledWith(
      '15551234002',
      'I listened to your voice note, Awan! Your wallet balance is ₹500.'
    );

    await app.close();
  });

  // =========================================================================
  // Integration Flow C: browser_open -> Playwright -> page content -> Gemini -> final answer
  // =========================================================================
  it('Integration Flow C: browser_open -> Playwright -> page content -> Gemini -> final answer', async () => {
    const db = new InMemoryRepository();
    const user = await db.findOrCreateUserByPhone('15551234003', 'Awan');
    await db.updateUser(user.id, {
      name: 'Awan',
      preferred_name: 'Awan',
      name_confirmed: true,
      name_source: 'USER_PROVIDED',
    });

    const targetUrl = `http://127.0.0.1:${testServerPort}/page-content`;
    let turn = 0;

    const mockAi = new MockAIProvider(async (messages) => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_open_1',
              name: 'browser_open',
              arguments: { url: targetUrl },
            },
          ],
        };
      }

      // Turn 2: Inspect returned tool results
      const lastMsg = messages[messages.length - 1];
      const pageResult = (lastMsg.toolResults?.[0]?.result as any);
      const text = pageResult?.text || '';

      return {
        text: `The temperature in New Delhi is 28°C with clear skies according to the page: ${text.slice(0, 40)}`,
      };
    });

    const toolRegistry = createDefaultToolRegistry({ db, browserService });
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    const result = await orchestrator.processMessage({
      phoneNumber: '15551234003',
      name: 'Awan',
      text: 'Open the verified data page and tell me what the weather is.',
      channel: 'whatsapp',
    });

    expect(result.replyText).toContain('28°C with clear skies');
    expect(turn).toBe(2);
  });

  // =========================================================================
  // Integration Flow D: browser_screenshot -> screenshot bytes -> Meta media upload -> WhatsApp image send
  // =========================================================================
  it('Integration Flow D: browser_screenshot -> screenshot bytes -> Meta media upload -> WhatsApp image send', async () => {
    const db = new InMemoryRepository();
    const user = await db.findOrCreateUserByPhone('15551234004', 'Awan');
    await db.updateUser(user.id, {
      name: 'Awan',
      preferred_name: 'Awan',
      name_confirmed: true,
      name_source: 'USER_PROVIDED',
    });

    const targetUrl = `http://127.0.0.1:${testServerPort}/page-content`;
    await browserService.openPage(targetUrl);

    const whatsapp = new WhatsAppGateway({ verifyToken: 'test_token' });
    const uploadSpy = vi.spyOn(whatsapp.client, 'uploadMedia').mockResolvedValue({ mediaId: 'meta_screen_media_999' });
    const sendImgSpy = vi.spyOn(whatsapp.client, 'sendImageMessage').mockResolvedValue({ success: true } as any);

    let turn = 0;
    const mockAi = new MockAIProvider(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_screen_1',
              name: 'browser_screenshot',
              arguments: { caption: "📸 Here's the verified data screenshot." },
            },
          ],
        };
      }
      return {
        text: 'I captured and sent the screenshot to your WhatsApp, Awan!',
      };
    });

    const toolRegistry = createDefaultToolRegistry({ db, browserService, whatsappClient: whatsapp.client });
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db, 5, whatsapp.client);

    const result = await orchestrator.processMessage({
      phoneNumber: '15551234004',
      name: 'Awan',
      text: 'Take a screenshot of the page',
      channel: 'whatsapp',
      whatsappClient: whatsapp.client,
    });

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy).toHaveBeenCalledWith(
      expect.any(Buffer),
      'image/png',
      expect.stringContaining('screenshot-')
    );

    expect(sendImgSpy).toHaveBeenCalledTimes(1);
    expect(sendImgSpy).toHaveBeenCalledWith(
      '15551234004',
      'meta_screen_media_999',
      "📸 Here's the verified data screenshot."
    );

    expect(result.replyText).toContain('sent the screenshot');
  });

  // =========================================================================
  // Integration Flow E: Blinkit: open -> auth required -> user authentication -> resume session -> search -> cart -> confirmation -> checkout workflow
  // =========================================================================
  it('Integration Flow E: Blinkit open -> auth required -> user authentication -> cart total confirmation', async () => {
    const db = new InMemoryRepository();
    const user = await db.findOrCreateUserByPhone('15551234005', 'Awan');
    await db.updateUser(user.id, {
      name: 'Awan',
      preferred_name: 'Awan',
      name_confirmed: true,
      name_source: 'USER_PROVIDED',
    });

    // Step 1: Open Blinkit login page
    const loginUrl = `http://127.0.0.1:${testServerPort}/blinkit/login`;
    const openRes = await browserService.openPage(loginUrl);

    // Verify auth detection triggered AUTH_REQUIRED
    expect(openRes.success).toBe(true);
    expect((openRes as any).authState).toBe('AUTH_REQUIRED');

    // Step 2: NEXA informs user to complete login in browser
    let turn = 0;
    const mockAi = new MockAIProvider(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_blinkit_1',
              name: 'browser_open',
              arguments: { url: loginUrl },
            },
          ],
        };
      }
      return {
        text: "Blinkit needs you to sign in first. Please complete the login in the browser and I'll continue.",
      };
    });

    const toolRegistry = createDefaultToolRegistry({ db, browserService });
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    const step1Result = await orchestrator.processMessage({
      phoneNumber: '15551234005',
      name: 'Awan',
      text: 'Open Blinkit',
      channel: 'whatsapp',
    });

    expect(step1Result.replyText).toContain('Blinkit needs you to sign in first');

    // Step 3: User confirms they completed sign-in, navigate to store & verify cart total confirmation before order
    const storeUrl = `http://127.0.0.1:${testServerPort}/blinkit/store`;
    await browserService.openPage(storeUrl);

    const mockAiOrder = new MockAIProvider(async () => {
      return {
        text: 'Awan, the cart total is ₹54.00. Ready to place the order?',
      };
    });

    const orchestratorOrder = new AgentOrchestrator(mockAiOrder, toolRegistry, db);
    const step2Result = await orchestratorOrder.processMessage({
      phoneNumber: '15551234005',
      name: 'Awan',
      text: "I've logged in, buy the milk",
      channel: 'whatsapp',
    });

    // Confirms explicit cart total approval requested before purchase
    expect(step2Result.replyText).toContain('Awan, the cart total is ₹54.00. Ready to place the order?');
  });

  // =========================================================================
  // Integration Flow F: booking: search -> approval -> provider -> verified confirmation
  // =========================================================================
  it('Integration Flow F: booking: search -> approval -> provider -> verified confirmation', async () => {
    const db = new InMemoryRepository();
    const user = await db.findOrCreateUserByPhone('15551234006', 'Awan');
    await db.updateUser(user.id, {
      name: 'Awan',
      preferred_name: 'Awan',
      name_confirmed: true,
      name_source: 'USER_PROVIDED',
      role: 'admin', // Admin role permitted to execute critical booking actions
    });

    const mockFlightProvider: FlightBookingProvider = {
      isConfigured: () => true,
      bookFlight: vi.fn(async (params) => ({
        success: true,
        bookingReference: 'AI-IND-VERIFIED-9821',
        confirmationStatus: 'confirmed' as const,
        providerStatus: 'live_confirmed',
        totalPrice: params.price,
        passengerName: params.passengerName,
        userFacingMessage: `Booking confirmed! Flight ${params.flightNumber} reference: AI-IND-VERIFIED-9821`,
      })),
    };

    const toolRegistry = createDefaultToolRegistry({ db });
    // Register travel tools with configured booking provider
    const dummyFlightSearch: FlightProvider = {
      searchFlights: vi.fn(async () => ({ flights: [], providerStatus: 'test' })),
    };
    const dummyHotelSearch: HotelProvider = {
      searchHotels: vi.fn(async () => ({ hotels: [], providerStatus: 'test' })),
    };
    const travelTools = (await import('../packages/tools/src/tools/travel-tools.js')).createTravelTools(
      dummyFlightSearch,
      dummyHotelSearch,
      mockFlightProvider
    );
    for (const t of travelTools) {
      toolRegistry.register(t);
    }

    // Step 1: Initial booking request triggers explicit ApprovalRequiredError
    let turn = 0;
    const mockAi = new MockAIProvider(async () => {
      turn++;
      return {
        text: '',
        toolCalls: [
          {
            id: 'call_book_1',
            name: 'book_flight',
            arguments: {
              airline: 'Air India',
              flightNumber: 'AI-101',
              origin: 'DEL',
              destination: 'BOM',
              departureDate: '2026-11-01',
              passengerName: 'Awan Warsi',
              price: 4500,
            },
          },
        ],
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    const step1 = await orchestrator.processMessage({
      phoneNumber: '15551234006',
      name: 'Awan',
      text: 'Book flight AI-101 to Mumbai',
      channel: 'whatsapp',
    });

    expect(step1.requiresApproval).toBe(true);
    expect(step1.approvalPrompt).toContain('Ready to book flight');
    expect(step1.approvalPrompt).toContain('AI-101');
    expect(step1.approvalId).toBeDefined();

    // Step 2: User approves action -> executes provider -> verified confirmation
    const step2 = await orchestrator.processMessage({
      phoneNumber: '15551234006',
      name: 'Awan',
      text: 'Yes, proceed',
      channel: 'whatsapp',
    });

    expect(step2.replyText).toContain('Booking confirmed');
    expect(step2.replyText).toContain('AI-IND-VERIFIED-9821');
    expect(mockFlightProvider.bookFlight).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // Integration Flow G: wallet: create topup -> QR -> provider webhook -> idempotent credit
  // =========================================================================
  it('Integration Flow G: wallet: create topup -> QR -> provider webhook -> idempotent credit', async () => {
    const db = new InMemoryRepository();
    const user = await db.findOrCreateUserByPhone('15551234007', 'Awan');
    await db.updateUser(user.id, {
      name: 'Awan',
      preferred_name: 'Awan',
      name_confirmed: true,
      name_source: 'USER_PROVIDED',
    });

    const walletService = new WalletService(db);
    const toolRegistry = createDefaultToolRegistry({ db, walletService });

    // Step 1: User requests top-up of ₹500 (50000 paise)
    let turn = 0;
    const mockAi = new MockAIProvider(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_wallet_topup_1',
              name: 'wallet_create_topup_qr',
              arguments: {
                amount: 500,
                currency: 'INR',
              },
            },
          ],
        };
      }
      return {
        text: 'Top-up QR created for ₹500. Please complete payment via UPI.',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db, 2);

    await orchestrator.processMessage({
      phoneNumber: '15551234007',
      name: 'Awan',
      text: 'Add ₹500 to my wallet',
      channel: 'whatsapp',
    });

    // Check ledger balance before webhook confirmation: MUST BE 0 (PENDING)
    const initialBalance = await walletService.getBalance(user.id);
    expect(initialBalance.balanceMinor).toBe(0);

    // Retrieve created pending topup record
    const topups = Array.from((db as any).walletTopups.values()) as any[];
    expect(topups.length).toBe(1);
    expect(topups[0].status).toBe('PENDING');
    expect(topups[0].amount_minor).toBe(50000);

    const idempotencyKey = topups[0].idempotency_key;

    // Step 2: Payment Provider webhook confirms payment
    const res1 = await walletService.processTopupWebhook(
      JSON.stringify({ idempotencyKey, status: 'SUCCEEDED' }),
      undefined,
      { idempotencyKey, status: 'SUCCEEDED' }
    );

    expect(res1.success).toBe(true);
    expect(res1.alreadyProcessed).toBe(false);
    expect(res1.balanceAfterMinor).toBe(50000);

    // Verify balance is now exactly 50000 paise (₹500.00)
    const updatedBalance = await walletService.getBalance(user.id);
    expect(updatedBalance.balanceMinor).toBe(50000);
    expect(updatedBalance.formattedBalance).toBe('₹500.00');

    // Step 3: Duplicate webhook arrives -> must be ignored idempotently without double credit
    const res2 = await walletService.processTopupWebhook(
      JSON.stringify({ idempotencyKey, status: 'SUCCEEDED' }),
      undefined,
      { idempotencyKey, status: 'SUCCEEDED' }
    );
    expect(res2.alreadyProcessed).toBe(true);

    const finalBalance = await walletService.getBalance(user.id);
    expect(finalBalance.balanceMinor).toBe(50000); // Still 50000, no double credit
  });
});
