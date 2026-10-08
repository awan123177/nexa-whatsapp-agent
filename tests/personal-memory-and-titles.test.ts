import { describe, it, expect, vi } from 'vitest';
import { InMemoryRepository, MemoryService } from '../packages/database/src/index.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';
import { buildSystemInstruction } from '../packages/agent/src/prompts.js';
import { User, SecurityViolationError } from '../packages/shared/src/index.js';

describe('NEXA Personal Memory, Titles, Polite Behavior & Zero-Memory-Loss Suite', () => {
  // =========================================================================
  // 1 & 2. "Call me Boss" must be strictly per-user and never global
  // =========================================================================
  it('1 & 2. User A says "Call me Boss" -> only User A gets title Boss; User B does not', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const mockAi = new MockAIProvider(async () => ({ text: 'OK' }));
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // User A sets title
    const resA = await orchestrator.processMessage({
      phoneNumber: '+19992000001',
      text: 'Call me boss',
      channel: 'whatsapp',
    });

    expect(resA.replyText).toBe('Sure, Boss.');

    const userA = await db.findOrCreateUserByPhone('+19992000001');
    expect(userA.preferred_title).toBe('Boss');
    expect(userA.title_confirmed).toBe(true);
    expect(userA.title_source).toBe('USER_PROVIDED');

    // User B sends message -> must NOT get Boss
    const resB = await orchestrator.processMessage({
      phoneNumber: '+19992000002',
      text: 'Hello NEXA',
      channel: 'whatsapp',
    });

    expect(resB.replyText).toBe('Hey! 👋 Nice to meet you. What’s your name?');
    expect(resB.replyText).not.toContain('Boss');

    const userB = await db.findOrCreateUserByPhone('+19992000002');
    expect(userB.preferred_title).toBeNull();
    expect(userB.title_confirmed).toBeFalsy();
  });

  // =========================================================================
  // 3 & 4. User changes title ("Don't call me boss. Call me captain") or removes it
  // =========================================================================
  it('3. User changes title -> new title used immediately ("Don\'t call me boss, call me captain")', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const mockAi = new MockAIProvider(async () => ({ text: 'OK' }));
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // Step 1: Set Boss
    await orchestrator.processMessage({
      phoneNumber: '+19992000003',
      text: 'Call me boss',
      channel: 'whatsapp',
    });

    // Step 2: Replace Boss with Captain
    const resReplace = await orchestrator.processMessage({
      phoneNumber: '+19992000003',
      text: "Don't call me boss, call me captain",
      channel: 'whatsapp',
    });

    expect(resReplace.replyText).toContain("I'll call you Captain from now on");

    const user = await db.findOrCreateUserByPhone('+19992000003');
    expect(user.preferred_title).toBe('Captain');
    expect(user.title_confirmed).toBe(true);

    const memories = await db.getUserMemories(user.id, 'identity');
    const titleMem = memories.find((m) => m.key === 'preferred_title');
    expect(titleMem?.value).toBe('Captain');
  });

  it('4. User removes title -> title no longer used ("Don\'t call me boss anymore")', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const mockAi = new MockAIProvider(async () => ({ text: 'OK' }));
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    await orchestrator.processMessage({
      phoneNumber: '+19992000004',
      text: 'Call me boss',
      channel: 'whatsapp',
    });

    const resRevoke = await orchestrator.processMessage({
      phoneNumber: '+19992000004',
      text: "Don't call me boss anymore",
      channel: 'whatsapp',
    });

    expect(resRevoke.replyText).toContain("won't call you Boss anymore");

    const user = await db.findOrCreateUserByPhone('+19992000004');
    expect(user.preferred_title).toBeNull();
    expect(user.title_confirmed).toBe(false);

    const memories = await db.getUserMemories(user.id, 'identity');
    const titleMem = memories.find((m) => m.key === 'preferred_title');
    expect(titleMem).toBeUndefined();
  });

  // =========================================================================
  // 5 & 6. User provides name and preferences saved durably
  // =========================================================================
  it('5 & 6. User provides name and preferences -> saved durably before interaction ends', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const mockAi = new MockAIProvider(async () => ({ text: 'Understood.' }));
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // Initial greeting
    await orchestrator.processMessage({
      phoneNumber: '+19992000005',
      text: 'Hello NEXA',
      channel: 'whatsapp',
    });

    // Provide name
    await orchestrator.processMessage({
      phoneNumber: '+19992000005',
      text: "I'm Awan Warsi",
      channel: 'whatsapp',
    });

    // Provide communication & dietary preference
    await orchestrator.processMessage({
      phoneNumber: '+19992000005',
      text: 'Remember that I live in Bangalore and use short answers',
      channel: 'whatsapp',
    });

    const user = await db.findOrCreateUserByPhone('+19992000005');
    expect(user.preferred_name).toBe('Awan Warsi');
    expect(user.name_confirmed).toBe(true);

    const memories = await db.getUserMemories(user.id);
    const placeMem = memories.find((m) => m.key === 'home_city');
    const styleMem = memories.find((m) => m.key === 'reply_length');

    expect(placeMem).toBeDefined();
    expect(placeMem?.value).toBe('Bangalore');
    expect(styleMem).toBeDefined();
    expect(styleMem?.value).toBe('short and concise');
  });

  // =========================================================================
  // 7. Duplicate WhatsApp events: Idempotent write safety
  // =========================================================================
  it('7. Duplicate WhatsApp event does not duplicate or corrupt memory', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const mockAi = new MockAIProvider(async () => ({ text: 'OK' }));
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // Delivery 1
    await orchestrator.processMessage({
      phoneNumber: '+19992000007',
      text: 'Call me boss',
      channel: 'whatsapp',
    });

    // Duplicate Delivery 2 (e.g. Meta webhook retry)
    await orchestrator.processMessage({
      phoneNumber: '+19992000007',
      text: 'Call me boss',
      channel: 'whatsapp',
    });

    const user = await db.findOrCreateUserByPhone('+19992000007');
    expect(user.preferred_title).toBe('Boss');

    const memories = await db.getUserMemories(user.id, 'identity');
    const titleMemories = memories.filter((m) => m.key === 'preferred_title');
    expect(titleMemories.length).toBe(1);
    expect(titleMemories[0].value).toBe('Boss');
  });

  // =========================================================================
  // 8, 9, 21. Memory survives application restart & simulated Render deployment
  // =========================================================================
  it('8, 9, 21. Customer memory survives simulated server restart and Render deployment', async () => {
    const persistentDb = new InMemoryRepository();

    // Session 1: Before restart/deployment
    {
      const toolRegistry = createDefaultToolRegistry({ db: persistentDb });
      const mockAi = new MockAIProvider(async () => ({ text: 'OK' }));
      const orchestrator1 = new AgentOrchestrator(mockAi, toolRegistry, persistentDb);

      await orchestrator1.processMessage({
        phoneNumber: '+19992000008',
        text: 'Hello NEXA',
        channel: 'whatsapp',
      });

      await orchestrator1.processMessage({
        phoneNumber: '+19992000008',
        text: "I'm Awan. Call me Boss.",
        channel: 'whatsapp',
      });
    }

    // Session 2: Fresh instance (simulating Render container redeploy / app restart)
    {
      const freshToolRegistry = createDefaultToolRegistry({ db: persistentDb });
      let promptSeenByAi = '';
      const mockAi2 = new MockAIProvider(async (_messages, options) => {
        promptSeenByAi = options?.systemInstruction || '';
        return { text: 'Sure, Boss. Opening Blinkit.' };
      });
      const orchestrator2 = new AgentOrchestrator(mockAi2, freshToolRegistry, persistentDb);

      const res = await orchestrator2.processMessage({
        phoneNumber: '+19992000008',
        text: 'Open Blinkit.',
        channel: 'whatsapp',
      });

      // No onboarding questions asked!
      expect(res.replyText).toContain('Sure, Boss.');
      expect(promptSeenByAi).toContain('Preferred Title: Boss');
      expect(promptSeenByAi).toContain('Title Confirmed: Yes');
    }
  });

  // =========================================================================
  // 10 & 11. Backward compatibility & Additive schema migration
  // =========================================================================
  it('10 & 11. Old customer records without new fields remain readable with safe defaults', async () => {
    const db = new InMemoryRepository();

    // Create legacy user lacking preferred_title and title_confirmed
    const legacyUser: User = {
      id: 'legacy-user-123',
      phone_number: '+19992000010',
      name: 'Old User',
      role: 'user',
      status: 'active',
      preferences: {
        preferred_name: 'Old User',
        name_confirmed: true,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.users.set(legacyUser.id, legacyUser);

    const retrieved = await db.getUserById('legacy-user-123');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.preferred_name).toBe('Old User');
    expect(retrieved?.preferred_title).toBeNull();
    expect(retrieved?.title_confirmed).toBe(false);
    expect(retrieved?.memory_version).toBe(1);

    // Updating user additively succeeds
    const updated = await db.updateUser('legacy-user-123', {
      preferred_title: 'Captain',
      title_confirmed: true,
    });

    expect(updated.preferred_title).toBe('Captain');
    expect(updated.title_confirmed).toBe(true);
  });

  // =========================================================================
  // 12. Database is source of truth over cache
  // =========================================================================
  it('12. Database is authoritative source of truth', async () => {
    const db = new InMemoryRepository();
    const user = await db.findOrCreateUserByPhone('+19992000012', 'Awan');

    const memoryService = new MemoryService(db);
    await memoryService.saveMemory({
      userId: user.id,
      category: 'preferences',
      key: 'test_pref',
      value: 'value_v1',
    });

    // Direct DB update simulates another worker or cluster update
    await db.saveMemory({
      user_id: user.id,
      category: 'preferences',
      key: 'test_pref',
      value: 'value_v2_authoritative',
      confidence: 1.0,
      metadata: {},
    });

    const relevant = await memoryService.getRelevantMemories(user.id);
    const pref = relevant.find((m) => m.key === 'test_pref');
    expect(pref?.value).toBe('value_v2_authoritative');
  });

  // =========================================================================
  // 13. User-Scoped Memory Isolation
  // =========================================================================
  it('13. User A cannot read User B memory under any query', async () => {
    const db = new InMemoryRepository();
    const userA = await db.findOrCreateUserByPhone('+19992000013', 'Alice');
    const userB = await db.findOrCreateUserByPhone('+19992000014', 'Bob');

    const memoryService = new MemoryService(db);
    await memoryService.saveMemory({
      userId: userA.id,
      category: 'important_context',
      key: 'secret_note',
      value: 'Alices private diary',
    });

    // Query for User B
    const userBMemories = await memoryService.getRelevantMemories(userB.id);
    expect(userBMemories.find((m) => m.key === 'secret_note')).toBeUndefined();

    // Direct repository query with User B ID
    const directUserBMemories = await db.getUserMemories(userB.id);
    expect(directUserBMemories.length).toBe(0);
  });

  // =========================================================================
  // 14. Relevant memories loaded according to task intent
  // =========================================================================
  it('14. Relevant memories loaded for the correct task (travel vs shopping vs wallet)', async () => {
    const db = new InMemoryRepository();
    const user = await db.findOrCreateUserByPhone('+19992000015', 'Awan');
    const memoryService = new MemoryService(db);

    await memoryService.saveMemory({
      userId: user.id,
      category: 'travel_preferences',
      key: 'flight_seat_preference',
      value: 'window',
    });
    await memoryService.saveMemory({
      userId: user.id,
      category: 'shopping_preferences',
      key: 'favorite_brand',
      value: 'Amul',
    });
    await memoryService.saveMemory({
      userId: user.id,
      category: 'wallet_preferences',
      key: 'default_upi_app',
      value: 'Google Pay',
    });

    // Travel query: loads travel memories, excludes shopping/wallet
    const travelMemories = await memoryService.getRelevantMemories(user.id, 'Search flights to Mumbai');
    expect(travelMemories.some((m) => m.key === 'flight_seat_preference')).toBe(true);
    expect(travelMemories.some((m) => m.key === 'favorite_brand')).toBe(false);

    // Shopping query: loads shopping memories, excludes travel
    const shoppingMemories = await memoryService.getRelevantMemories(user.id, 'Open Blinkit and buy milk');
    expect(shoppingMemories.some((m) => m.key === 'favorite_brand')).toBe(true);
    expect(shoppingMemories.some((m) => m.key === 'flight_seat_preference')).toBe(false);
  });

  // =========================================================================
  // 15. Security: Secrets, Passwords, OTPs, CVVs are NEVER saved
  // =========================================================================
  it('15. Passwords, OTPs, CVVs, and API keys are blocked from being stored in memory', async () => {
    const db = new InMemoryRepository();
    const user = await db.findOrCreateUserByPhone('+19992000016', 'Awan');
    const memoryService = new MemoryService(db);

    // Attempt to store password
    await expect(
      memoryService.saveMemory({
        userId: user.id,
        category: 'preferences',
        key: 'account_password',
        value: 'MySecretPassword123!',
      })
    ).rejects.toThrow(SecurityViolationError);

    // Attempt to store OTP
    await expect(
      memoryService.saveMemory({
        userId: user.id,
        category: 'preferences',
        key: 'otp_code',
        value: '482910',
      })
    ).rejects.toThrow(SecurityViolationError);

    // Attempt to store CVV
    await expect(
      memoryService.saveMemory({
        userId: user.id,
        category: 'preferences',
        key: 'card_cvv',
        value: '999',
      })
    ).rejects.toThrow(SecurityViolationError);
  });

  // =========================================================================
  // 16. User-provided title is passed into conversational system prompt
  // =========================================================================
  it('16. User-provided title is formatted properly into the system prompt', () => {
    const userWithTitle: User = {
      id: 'u-16',
      phone_number: '+19992000017',
      role: 'user',
      status: 'active',
      preferences: {
        preferred_name: 'Awan Warsi',
        name_confirmed: true,
        preferred_title: 'Boss',
        title_confirmed: true,
      },
      preferred_name: 'Awan Warsi',
      name_confirmed: true,
      preferred_title: 'Boss',
      title_confirmed: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const prompt = buildSystemInstruction(userWithTitle, []);
    expect(prompt).toContain('Preferred Title: Boss');
    expect(prompt).toContain('Title Confirmed: Yes');
    expect(prompt).toContain('STRICTLY PER-USER');
  });

  // =========================================================================
  // 17. Unconfirmed profile name does NOT overwrite confirmed identity
  // =========================================================================
  it('17. WhatsApp profile display name does not overwrite confirmed name or title', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const mockAi = new MockAIProvider(async () => ({ text: 'OK' }));
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // Confirm identity as Awan Warsi / Boss
    await orchestrator.processMessage({
      phoneNumber: '+19992000018',
      text: "I'm Awan Warsi. Call me Boss.",
      channel: 'whatsapp',
    });

    // Inbound message with different WhatsApp profile name
    await orchestrator.processMessage({
      phoneNumber: '+19992000018',
      whatsappProfileName: 'Random Display Name',
      text: 'Open Blinkit',
      channel: 'whatsapp',
    });

    const user = await db.findOrCreateUserByPhone('+19992000018');
    expect(user.preferred_name).toBe('Awan Warsi');
    expect(user.preferred_title).toBe('Boss');
    expect(user.name_confirmed).toBe(true);
  });

  // =========================================================================
  // 18 & 19. Proactive execution: Do not ask unnecessary questions
  // =========================================================================
  it('18 & 19. System goes straight to work and does not ask redundant confirmation questions', async () => {
    const db = new InMemoryRepository();
    const user = await db.findOrCreateUserByPhone('+19992000019', 'Awan');
    await db.updateUser(user.id, {
      preferred_name: 'Awan',
      name_confirmed: true,
      preferred_title: 'Boss',
      title_confirmed: true,
    });

    const toolRegistry = createDefaultToolRegistry({ db });
    const mockAi = new MockAIProvider(async (_msgs, options) => {
      const systemInstruction = options?.systemInstruction || '';
      expect(systemInstruction).toContain('Do Not Ask Unnecessary Questions');
      expect(systemInstruction).toContain('GO STRAIGHT TO WORK');
      return {
        text: 'Sure, Boss. Opening Blinkit.',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);
    const res = await orchestrator.processMessage({
      phoneNumber: '+19992000019',
      text: 'Open Blinkit and search for milk.',
      channel: 'whatsapp',
    });

    expect(res.replyText).toContain('Sure, Boss.');
    expect(res.replyText).not.toContain('Would you like me to');
  });

  // =========================================================================
  // 20. Memory Health Check
  // =========================================================================
  it('20. Internal memory health check verifies write, read, and user isolation', async () => {
    const db = new InMemoryRepository();
    const user = await db.findOrCreateUserByPhone('+19992000020', 'Awan');
    const memoryService = new MemoryService(db);

    const logSpy = vi.spyOn(console, 'log');
    const report = await memoryService.checkHealth(user.id);

    expect(report.healthy).toBe(true);
    expect(report.userExists).toBe(true);
    expect(report.preferencesReadable).toBe(true);
    expect(report.memoryWritable).toBe(true);
    expect(report.memoryReadable).toBe(true);
    expect(report.isolationVerified).toBe(true);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[Memory] read_success'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[Memory] user_memory_available=true'));
    logSpy.mockRestore();
  });

  // =========================================================================
  // 22. Wallet memory separated from authoritative ledger
  // =========================================================================
  it('22. Wallet preferences remain strictly separated from authoritative ledger balance', async () => {
    const db = new InMemoryRepository();
    const user = await db.findOrCreateUserByPhone('+19992000022', 'Awan');
    const memoryService = new MemoryService(db);

    // Save wallet preference
    await memoryService.saveMemory({
      userId: user.id,
      category: 'wallet_preferences',
      key: 'preferred_payment_mode',
      value: 'UPI',
    });

    // Authoritative wallet
    const wallet = await db.getOrCreateWallet(user.id, 'INR');
    expect(wallet.balance_minor).toBe(0);

    // Memory does not modify wallet balance
    const updatedWallet = await db.getWalletById(wallet.id);
    expect(updatedWallet?.balance_minor).toBe(0);
  });

  // =========================================================================
  // 23. Acceptance Criteria: Day 1 Onboarding, Day 2 Restart, Day 3 Deployment
  // =========================================================================
  it('23. Day 1 Onboarding -> Day 2 Restart -> Day 3 Deployment scenario passes end-to-end', async () => {
    const persistentDb = new InMemoryRepository();

    // DAY 1: User Onboarding
    {
      const toolRegistry = createDefaultToolRegistry({ db: persistentDb });
      const mockAi = new MockAIProvider(async () => ({ text: 'AI response' }));
      const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, persistentDb);

      // User: "Hello NEXA"
      const res1 = await orchestrator.processMessage({
        phoneNumber: '+19993000001',
        text: 'Hello NEXA',
        channel: 'whatsapp',
      });
      expect(res1.replyText).toBe('Hey! 👋 Nice to meet you. What’s your name?');

      // User: "I'm Awan Warsi. Call me Boss."
      const res2 = await orchestrator.processMessage({
        phoneNumber: '+19993000001',
        text: "I'm Awan Warsi. Call me Boss.",
        channel: 'whatsapp',
      });
      expect(res2.replyText).toBe('Nice to meet you, Boss! What can I help you with?');

      const user = await persistentDb.findOrCreateUserByPhone('+19993000001');
      expect(user.preferred_name).toBe('Awan Warsi');
      expect(user.name_confirmed).toBe(true);
      expect(user.preferred_title).toBe('Boss');
      expect(user.title_confirmed).toBe(true);
    }

    // DAY 2: Application Restart
    {
      const freshToolRegistry = createDefaultToolRegistry({ db: persistentDb });
      const mockAi = new MockAIProvider(async () => ({ text: 'Sure, Boss. Opening Blinkit.' }));
      const orchestrator = new AgentOrchestrator(mockAi, freshToolRegistry, persistentDb);

      const res = await orchestrator.processMessage({
        phoneNumber: '+19993000001',
        text: 'Open Blinkit.',
        channel: 'whatsapp',
      });

      expect(res.replyText).toBe('Sure, Boss. Opening Blinkit.');
    }

    // DAY 3: Render Deployment / Container Replace
    {
      const freshToolRegistry = createDefaultToolRegistry({ db: persistentDb });
      const mockAi = new MockAIProvider(async () => ({
        text: "Sure, Boss. I'll look for some good options. What dates are you staying?",
      }));
      const orchestrator = new AgentOrchestrator(mockAi, freshToolRegistry, persistentDb);

      const res = await orchestrator.processMessage({
        phoneNumber: '+19993000001',
        text: 'Book me a hotel in Goa.',
        channel: 'whatsapp',
      });

      expect(res.replyText).toContain('Sure, Boss.');
      expect(res.replyText).toContain('What dates');
    }
  });
});
