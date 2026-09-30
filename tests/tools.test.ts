import { describe, it, expect } from 'vitest';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { ToolRegistry } from '../packages/tools/src/registry.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { ApprovalRequiredError, ToolExecutionError } from '../packages/shared/src/index.js';

describe('Tool Registry & Core Tools Suite', () => {
  it('should register tools and export Gemini-compatible function declarations', () => {
    const db = new InMemoryRepository();
    const registry = createDefaultToolRegistry({ db });

    const declarations = registry.getDeclarations();
    expect(declarations.length).toBeGreaterThanOrEqual(10);

    const flightDecl = declarations.find((d) => d.name === 'search_flights');
    expect(flightDecl).toBeDefined();
    expect(flightDecl?.parameters.properties).toHaveProperty('origin');
    expect(flightDecl?.parameters.properties).toHaveProperty('destination');
    expect(flightDecl?.parameters.required).toContain('origin');
  });

  it('should enforce Zod schema validation and reject invalid arguments', async () => {
    const db = new InMemoryRepository();
    const registry = createDefaultToolRegistry({ db });
    const user = await db.findOrCreateUserByPhone('+15550000001');
    const conversation = await db.getOrCreateActiveConversation(user.id);

    const context = {
      user,
      conversation,
      sourceChannel: 'whatsapp' as const,
    };

    // Passing invalid arguments to search_flights (missing destination, invalid date)
    await expect(
      registry.executeTool('search_flights', { origin: 'BLR' }, context)
    ).rejects.toThrow(ToolExecutionError);
  });

  it('should trigger ApprovalRequiredError for sensitive actions like send_email', async () => {
    const db = new InMemoryRepository();
    const registry = createDefaultToolRegistry({ db });
    const user = await db.findOrCreateUserByPhone('+15550000002');
    const conversation = await db.getOrCreateActiveConversation(user.id);

    const context = {
      user,
      conversation,
      sourceChannel: 'whatsapp' as const,
    };

    try {
      await registry.executeTool(
        'send_email',
        {
          to: 'partner@example.com',
          subject: 'Flight details',
          body: 'Here is your itinerary',
        },
        context
      );
      expect.fail('Should have thrown ApprovalRequiredError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(ApprovalRequiredError);
      expect(err.toolName).toBe('send_email');
      expect(err.prompt).toContain('partner@example.com');

      // Verify pending approval was persisted to DB
      const pending = await db.getPendingApproval(conversation.id);
      expect(pending).not.toBeNull();
      expect(pending?.tool_name).toBe('send_email');
    }
  });

  it('should not fabricate flight data and clearly indicate web fallback when unconfigured', async () => {
    const db = new InMemoryRepository();
    const registry = createDefaultToolRegistry({ db });
    const user = await db.findOrCreateUserByPhone('+15550000003');
    const conversation = await db.getOrCreateActiveConversation(user.id);

    const result = await registry.executeTool(
      'search_flights',
      {
        origin: 'BLR',
        destination: 'DXB',
        departureDate: '2026-10-15',
        maxBudget: 20000,
        currency: 'INR',
      },
      {
        user,
        conversation,
        sourceChannel: 'whatsapp',
      }
    );

    expect(result.success).toBe(true);
    expect((result.data as any).notice).toContain('NEXA will not invent fictional flight numbers');
  });
});
