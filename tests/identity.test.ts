import { describe, it, expect, vi } from 'vitest';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';
import { IdentityManager } from '../packages/agent/src/identity.js';

describe('Identity & User Onboarding State Suite', () => {
  it('1. First "Hello NEXA" with no preferred name asks user\'s name and stops turn', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    let aiCalled = false;
    const mockAi = new MockAIProvider(async () => {
      aiCalled = true;
      return { text: 'Should not reach AI on first greeting without name' };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    const logSpy = vi.spyOn(console, 'log');

    const result = await orchestrator.processMessage({
      phoneNumber: '+19991110001',
      text: 'Hello NEXA',
      channel: 'whatsapp',
    });

    expect(result.replyText).toBe('Hey! 👋 Nice to meet you. What’s your name?');
    expect(result.stepsCount).toBe(0);
    expect(aiCalled).toBe(false);

    // Verify sanitized telemetry logs
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[Identity] first_contact=true'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[Identity] preferred_name_present=false'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[Identity] name_confirmed=false'));

    // Verify user in DB has unconfirmed state
    const user = await db.findOrCreateUserByPhone('+19991110001');
    expect(user.preferences.name_confirmed).toBeFalsy();
    expect(user.preferences.preferred_name).toBeFalsy();
    logSpy.mockRestore();
  });

  it('2. WhatsApp profile says "Awan Warsi" but NEXA still asks user\'s preferred name', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    let aiCalled = false;
    const mockAi = new MockAIProvider(async () => {
      aiCalled = true;
      return { text: 'Should not reach AI' };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    const result = await orchestrator.processMessage({
      phoneNumber: '+19991110002',
      whatsappProfileName: 'Awan Warsi', // WhatsApp contact display name
      text: 'Hello NEXA',
      channel: 'whatsapp',
    });

    // NEXA must NOT assume Awan Warsi is preferred name!
    expect(result.replyText).toBe('Hey! 👋 Nice to meet you. What’s your name?');
    expect(result.replyText).not.toContain('Awan');
    expect(result.replyText).not.toContain('Warsi');
    expect(aiCalled).toBe(false);

    const user = await db.findOrCreateUserByPhone('+19991110002');
    expect(user.preferences.whatsapp_profile_name).toBe('Awan Warsi');
    expect(user.preferences.name_confirmed).toBe(false);
    expect(user.preferences.name_source).toBe('WHATSAPP_PROFILE_UNCONFIRMED');
    expect(user.preferences.preferred_name).toBeFalsy();
    expect(user.name).toBeFalsy();
  });

  it('3. User replies "Rahul" -> stores Rahul as confirmed preferred name', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const mockAi = new MockAIProvider(async () => ({ text: 'AI response' }));
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // Turn 1: Greeting
    await orchestrator.processMessage({
      phoneNumber: '+19991110003',
      whatsappProfileName: 'Awan Warsi',
      text: 'Hello NEXA',
      channel: 'whatsapp',
    });

    // Turn 2: User provides name "Rahul"
    const result = await orchestrator.processMessage({
      phoneNumber: '+19991110003',
      text: 'Rahul',
      channel: 'whatsapp',
    });

    expect(result.replyText).toContain('Nice to meet you, Rahul!');
    expect(result.replyText).not.toContain('Awan Warsi');

    const user = await db.findOrCreateUserByPhone('+19991110003');
    expect(user.name).toBe('Rahul');
    expect(user.preferences.preferred_name).toBe('Rahul');
    expect(user.preferences.name_confirmed).toBe(true);
    expect(user.preferences.name_source).toBe('USER_PROVIDED');

    // Memory persisted
    const memories = await db.getUserMemories(user.id);
    const nameMem = memories.find((m) => m.key === 'preferred_name');
    expect(nameMem).toBeDefined();
    expect(nameMem?.value).toBe('Rahul');
  });

  it('4. Next message does not ask for name again and proceeds with user request', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    let aiCalled = false;
    const mockAi = new MockAIProvider(async () => {
      aiCalled = true;
      return { text: 'Sure Rahul, Goa hotel options are ready.' };
    });
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // Turn 1 & 2: Setup confirmed user
    await orchestrator.processMessage({
      phoneNumber: '+19991110004',
      text: 'Hello NEXA',
      channel: 'whatsapp',
    });
    await orchestrator.processMessage({
      phoneNumber: '+19991110004',
      text: 'My name is Rahul',
      channel: 'whatsapp',
    });

    // Turn 3: User makes request
    const result = await orchestrator.processMessage({
      phoneNumber: '+19991110004',
      text: 'Book me a hotel in Goa',
      channel: 'whatsapp',
    });

    expect(aiCalled).toBe(true);
    expect(result.replyText).not.toContain("What’s your name?");
    expect(result.replyText).toContain('Goa hotel');
  });

  it('5. User corrects name ("Don\'t call me Rahul, call me Alex") -> updated name used afterward', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const mockAi = new MockAIProvider(async () => ({ text: 'OK' }));
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // Initial confirmation
    await orchestrator.processMessage({
      phoneNumber: '+19991110005',
      text: "I'm Rahul",
      channel: 'whatsapp',
    });

    const user1 = await db.findOrCreateUserByPhone('+19991110005');
    expect(user1.name).toBe('Rahul');

    // User corrects name
    const result = await orchestrator.processMessage({
      phoneNumber: '+19991110005',
      text: "Don't call me Rahul, call me Alex",
      channel: 'whatsapp',
    });

    expect(result.replyText).toContain("I'll call you Alex from now on");

    const user2 = await db.findOrCreateUserByPhone('+19991110005');
    expect(user2.name).toBe('Alex');
    expect(user2.preferences.preferred_name).toBe('Alex');
    expect(user2.preferences.name_confirmed).toBe(true);

    const memories = await db.getUserMemories(user2.id);
    const updatedMem = memories.find((m) => m.key === 'preferred_name');
    expect(updatedMem?.value).toBe('Alex');
  });

  it('6. User explicitly says "Call me Awan" -> confirmed as preferred name', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const mockAi = new MockAIProvider(async () => ({ text: 'OK' }));
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    const result = await orchestrator.processMessage({
      phoneNumber: '+19991110006',
      text: 'Call me Awan',
      channel: 'whatsapp',
    });

    expect(result.replyText).toContain('Nice to meet you, Awan!');

    const user = await db.findOrCreateUserByPhone('+19991110006');
    expect(user.name).toBe('Awan');
    expect(user.preferences.preferred_name).toBe('Awan');
    expect(user.preferences.name_confirmed).toBe(true);
    expect(user.preferences.name_source).toBe('USER_PROVIDED');
  });

  it('7. WhatsApp profile name changes -> must not overwrite confirmed name', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const mockAi = new MockAIProvider(async () => ({ text: 'Welcome back' }));
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // User confirms name as "Rahul"
    await orchestrator.processMessage({
      phoneNumber: '+19991110007',
      whatsappProfileName: 'OldProfile',
      text: "I'm Rahul",
      channel: 'whatsapp',
    });

    const user1 = await db.findOrCreateUserByPhone('+19991110007');
    expect(user1.name).toBe('Rahul');

    // Next webhook arrives with changed WhatsApp profile metadata (e.g. "Awan Warsi")
    await orchestrator.processMessage({
      phoneNumber: '+19991110007',
      whatsappProfileName: 'Awan Warsi', // Changed profile metadata
      text: 'What is the weather today?',
      channel: 'whatsapp',
    });

    const user2 = await db.findOrCreateUserByPhone('+19991110007');
    // Confirmed preferred name MUST remain Rahul!
    expect(user2.name).toBe('Rahul');
    expect(user2.preferences.preferred_name).toBe('Rahul');
    expect(user2.preferences.name_confirmed).toBe(true);
    expect(user2.preferences.name_source).toBe('USER_PROVIDED');
    // WhatsApp profile metadata recorded
    expect(user2.preferences.whatsapp_profile_name).toBe('Awan Warsi');
  });

  it('8. Voice introduction -> preferred name can be confirmed from recognized speech', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const mockAi = new MockAIProvider(async () => ({ text: 'Voice processed' }));
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // User sends voice note where speech-to-text recognized "My name is Rahul"
    const dummyAudioBytes = Buffer.from('RIFF...mockaudio...');
    const result = await orchestrator.processMessage({
      phoneNumber: '+19991110008',
      text: 'My name is Rahul',
      audioBuffer: dummyAudioBytes,
      audioMimeType: 'audio/ogg; codecs=opus',
      channel: 'whatsapp',
    });

    expect(result.replyText).toContain('Nice to meet you, Rahul!');

    const user = await db.findOrCreateUserByPhone('+19991110008');
    expect(user.name).toBe('Rahul');
    expect(user.preferences.preferred_name).toBe('Rahul');
    expect(user.preferences.name_confirmed).toBe(true);
    expect(user.preferences.name_source).toBe('USER_PROVIDED');
  });

  it('Clarification is asked when name introduction is ambiguous ("Rahul or Alex")', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const mockAi = new MockAIProvider(async () => ({ text: 'Clarified' }));
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    const result = await orchestrator.processMessage({
      phoneNumber: '+19991110009',
      text: 'Call me Rahul or Alex',
      channel: 'whatsapp',
    });

    expect(result.replyText).toBe('Should I call you Rahul or Alex?');
    expect(result.stepsCount).toBe(0);
  });

  it('First message containing unrelated question asks user name and stops turn without answering question', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    let aiCalled = false;
    const mockAi = new MockAIProvider(async () => {
      aiCalled = true;
      return { text: 'Should not reach AI on first contact with question' };
    });
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // User asks unrelated question in first message
    const result = await orchestrator.processMessage({
      phoneNumber: '+19991110010',
      text: 'Hello NEXA, what is the weather in Delhi?',
      channel: 'whatsapp',
    });

    expect(result.replyText).toBe('Hey! 👋 Nice to meet you. What’s your name?');
    expect(result.stepsCount).toBe(0);
    expect(aiCalled).toBe(false);
  });

  it('Revoking name without new name ("Don\'t call me Awan") clears profile memory', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const mockAi = new MockAIProvider(async () => ({ text: 'OK' }));
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // Initial setup with confirmed name Awan
    await orchestrator.processMessage({
      phoneNumber: '+19991110011',
      text: 'Call me Awan',
      channel: 'whatsapp',
    });

    const user1 = await db.findOrCreateUserByPhone('+19991110011');
    expect(user1.name).toBe('Awan');
    const memories1 = await db.getUserMemories(user1.id);
    expect(memories1.some((m) => m.key === 'preferred_name')).toBe(true);

    // Revoke name
    const result = await orchestrator.processMessage({
      phoneNumber: '+19991110011',
      text: "Don't call me Awan",
      channel: 'whatsapp',
    });

    expect(result.replyText).toContain("I won't call you that");
    const user2 = await db.findOrCreateUserByPhone('+19991110011');
    expect(user2.preferences.preferred_name).toBeNull();
    expect(user2.preferences.name_confirmed).toBe(false);

    const memories2 = await db.getUserMemories(user2.id);
    expect(memories2.some((m) => m.key === 'preferred_name')).toBe(false);
  });

  it('Honorifics and compound names are parsed and formatted properly', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const mockAi = new MockAIProvider(async () => ({ text: 'OK' }));
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    const res1 = await orchestrator.processMessage({
      phoneNumber: '+19991110012',
      text: 'My name is Dr. Rahul',
      channel: 'whatsapp',
    });
    expect(res1.replyText).toContain('Dr Rahul');

    const res2 = await orchestrator.processMessage({
      phoneNumber: '+19991110013',
      text: "I'm Mary-Jane",
      channel: 'whatsapp',
    });
    expect(res2.replyText).toContain('Mary-Jane');
  });

  it('User who ignores name question on Turn 2 is not nagged on every message (Rule 7)', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    let aiCalled = false;
    const mockAi = new MockAIProvider(async () => {
      aiCalled = true;
      return { text: 'The capital of France is Paris.' };
    });
    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // Turn 1: Initial contact asks for name
    await orchestrator.processMessage({
      phoneNumber: '+19991110014',
      text: 'Hello NEXA',
      channel: 'whatsapp',
    });

    // Turn 2: User ignores name prompt and asks factual question
    const result = await orchestrator.processMessage({
      phoneNumber: '+19991110014',
      text: 'What is the capital of France?',
      channel: 'whatsapp',
    });

    // Should NOT ask for name again, should proceed to answer question
    expect(aiCalled).toBe(true);
    expect(result.replyText).toContain('Paris');
    expect(result.replyText).not.toContain("What’s your name?");
  });
});
