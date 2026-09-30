import { describe, it, expect } from 'vitest';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';
import { AgentOrchestrator } from '../packages/agent/src/orchestrator.js';

describe('Agent Orchestrator & Loop Suite', () => {
  it('should process a basic user message, save history, and return an AI reply', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const mockAi = new MockAIProvider(async (_messages) => {
      return {
        text: 'Hello! I am NEXA, your personal AI that gets things done.',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    const result = await orchestrator.processMessage({
      phoneNumber: '+15551112222',
      name: 'Alice',
      text: 'Hi NEXA!',
      channel: 'whatsapp',
    });

    expect(result.replyText).toContain('Hello! I am NEXA');
    expect(result.stepsCount).toBe(1);

    // Verify messages saved in DB
    const messages = await db.getConversationMessages(result.conversationId);
    expect(messages).toHaveLength(2); // user + assistant
    expect(messages[0].content).toBe('Hi NEXA!');
    expect(messages[1].content).toContain('Hello! I am NEXA');
  });

  it('should perform a multi-step tool call and synthesize the final answer', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    let turn = 0;

    const mockAi = new MockAIProvider(async (_messages) => {
      turn++;
      if (turn === 1) {
        // First turn: decide to save a memory
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'save_memory',
              arguments: {
                category: 'preference',
                key: 'coffee_type',
                value: 'Oat milk flat white',
                confidence: 1.0,
              },
            },
          ],
        };
      }

      // Second turn: AI received tool result, synthesizes final message
      return {
        text: 'Noted! I have saved your preference for Oat milk flat white.',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    const result = await orchestrator.processMessage({
      phoneNumber: '+15551112222',
      name: 'Alice',
      text: 'Remember that I always drink oat milk flat whites',
      channel: 'whatsapp',
    });

    expect(result.replyText).toContain('I have saved your preference');
    expect(result.stepsCount).toBe(2);

    // Check memory was saved
    const user = await db.findOrCreateUserByPhone('+15551112222');
    const memories = await db.getUserMemories(user.id);
    expect(memories).toHaveLength(1);
    expect(memories[0].key).toBe('coffee_type');
    expect(memories[0].value).toBe('Oat milk flat white');
  });

  it('should pause for approval on sensitive tools and resume when user confirms', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });

    const mockAi = new MockAIProvider(async (_messages) => {
      return {
        text: '',
        toolCalls: [
          {
            id: 'call_send_email',
            name: 'send_email',
            arguments: {
              to: 'travel-agent@example.com',
              subject: 'Booking Inquiry',
              body: 'Please confirm flight AI-101.',
            },
          },
        ],
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // 1. User sends message requesting action
    const pauseResult = await orchestrator.processMessage({
      phoneNumber: '+15553334444',
      name: 'Bob',
      text: 'Send an email to travel-agent@example.com confirming my flight',
      channel: 'whatsapp',
    });

    expect(pauseResult.requiresApproval).toBe(true);
    expect(pauseResult.approvalPrompt).toContain('I am ready to send an email to *travel-agent@example.com*');

    // Verify pending approval exists in DB
    const pendingApproval = await db.getPendingApproval(pauseResult.conversationId);
    expect(pendingApproval).not.toBeNull();
    expect(pendingApproval?.status).toBe('pending');

    // 2. User confirms by replying 'Yes'
    const resumeResult = await orchestrator.processMessage({
      phoneNumber: '+15553334444',
      name: 'Bob',
      text: 'Yes',
      channel: 'whatsapp',
    });

    expect(resumeResult.replyText).toBeDefined();

    // Verify approval status updated in DB
    const updatedApproval = await db.approvals.get(pendingApproval!.id);
    expect(updatedApproval?.status).toBe('approved');
  });

  it('should cancel pending approval when user says No', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });

    const mockAi = new MockAIProvider(async () => {
      return {
        text: '',
        toolCalls: [
          {
            id: 'call_approval',
            name: 'request_user_confirmation',
            arguments: {
              actionSummary: 'Purchase flight BLR -> DXB for ₹18,450',
              impactLevel: 'high',
            },
          },
        ],
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // Request action
    const pauseResult = await orchestrator.processMessage({
      phoneNumber: '+15555556666',
      name: 'Charlie',
      text: 'Book the flight now',
      channel: 'whatsapp',
    });

    expect(pauseResult.requiresApproval).toBe(true);

    // User cancels
    const cancelResult = await orchestrator.processMessage({
      phoneNumber: '+15555556666',
      name: 'Charlie',
      text: 'No, cancel it',
      channel: 'whatsapp',
    });

    expect(cancelResult.replyText).toContain("I've cancelled that action");
  });
});
