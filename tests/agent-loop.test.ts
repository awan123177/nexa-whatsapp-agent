import { describe, it, expect, vi } from 'vitest';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { createDefaultToolRegistry } from '../packages/tools/src/factory.js';
import { MockAIProvider } from '../packages/ai/src/mock-provider.js';
import { GeminiProvider } from '../packages/ai/src/gemini-provider.js';
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

  it('should process simple chat greeting (Hello NEXA) with 1 step, 0 tools, and thinkingLevel: low', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const thinkingLevels: string[] = [];

    const mockAi = new MockAIProvider(async (_messages, options) => {
      if (options?.thinkingLevel) {
        thinkingLevels.push(options.thinkingLevel);
      }
      return {
        text: 'Hello! How can I help you today?',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    const result = await orchestrator.processMessage({
      phoneNumber: '+15551112222',
      name: 'Alice',
      text: 'Hello NEXA',
      channel: 'whatsapp',
    });

    expect(result.stepsCount).toBe(1);
    expect(result.replyText).toBe('Hello! How can I help you today?');
    expect(thinkingLevels).toEqual(['low']);
  });

  it('should elevate thinkingLevel to medium for complex tasks and subsequent steps', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const recordedThinkingLevels: string[] = [];
    let step = 0;

    const mockAi = new MockAIProvider(async (_messages, options) => {
      step++;
      if (options?.thinkingLevel) {
        recordedThinkingLevels.push(options.thinkingLevel);
      }

      if (step === 1) {
        // Multi-step tool call
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_search',
              name: 'web_search',
              arguments: { query: 'compare flight prices BLR to DXB' },
            },
          ],
        };
      }

      return {
        text: 'Here is the flight comparison.',
      };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    const result = await orchestrator.processMessage({
      phoneNumber: '+15551112222',
      name: 'Alice',
      text: 'Can you compare flight prices from BLR to DXB?',
      channel: 'whatsapp',
    });

    expect(result.stepsCount).toBe(2);
    // Step 1: complex trigger ("compare") -> medium
    // Step 2: step > 1 -> medium
    expect(recordedThinkingLevels).toEqual(['medium', 'medium']);
  });

  it('should short-circuit duplicate messages using wamid idempotency', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    let aiCalls = 0;

    const mockAi = new MockAIProvider(async () => {
      aiCalls++;
      return { text: 'First reply' };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // First delivery
    const result1 = await orchestrator.processMessage({
      phoneNumber: '+15559998888',
      name: 'Dave',
      text: 'Hello NEXA',
      channel: 'whatsapp',
      wamid: 'wamid.HBgLMTU1NTk5OTg4ODgVAgASGBQzQT',
    });

    expect(result1.replyText).toBe('First reply');
    expect(aiCalls).toBe(1);

    // Duplicate delivery with same wamid
    const result2 = await orchestrator.processMessage({
      phoneNumber: '+15559998888',
      name: 'Dave',
      text: 'Hello NEXA',
      channel: 'whatsapp',
      wamid: 'wamid.HBgLMTU1NTk5OTg4ODgVAgASGBQzQT',
    });

    expect(result2.replyText).toBe('First reply');
    // AI provider should not have been called again
    expect(aiCalls).toBe(1);
  });

  it('Test E: two consecutive WhatsApp messages => each Gemini request ends with the correct current user turn', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const receivedEndTurns: { role: string; content: string }[] = [];

    const mockAi = new MockAIProvider(async (messages) => {
      const last = messages[messages.length - 1];
      receivedEndTurns.push({ role: last.role, content: last.content });
      return { text: `Reply to ${last.content}` };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    // Consecutive message 1
    const res1 = await orchestrator.processMessage({
      phoneNumber: '+15551234567',
      name: 'Emma',
      text: 'First question',
      channel: 'whatsapp',
    });
    expect(res1.replyText).toBe('Reply to First question');

    // Consecutive message 2
    const res2 = await orchestrator.processMessage({
      phoneNumber: '+15551234567',
      name: 'Emma',
      text: 'Second follow-up question',
      channel: 'whatsapp',
    });
    expect(res2.replyText).toBe('Reply to Second follow-up question');

    // Verify both requests ended with the current user turn
    expect(receivedEndTurns).toHaveLength(2);
    expect(receivedEndTurns[0]).toEqual({ role: 'user', content: 'First question' });
    expect(receivedEndTurns[1]).toEqual({ role: 'user', content: 'Second follow-up question' });
  });

  it('Test F: assistant response is persisted after generation, not before the next user turn', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    let dbStateDuringGeneration: string[] = [];

    const mockAi = new MockAIProvider(async (_messages) => {
      // Inspect DB messages during generation
      const user = await db.findOrCreateUserByPhone('+15557778888');
      const conv = await db.getOrCreateActiveConversation(user.id, 'whatsapp');
      const currentMsgs = await db.getConversationMessages(conv.id);
      dbStateDuringGeneration = currentMsgs.map((m) => `${m.sender_type}:${m.content}`);
      return { text: 'AI generated answer' };
    });

    const orchestrator = new AgentOrchestrator(mockAi, toolRegistry, db);

    await orchestrator.processMessage({
      phoneNumber: '+15557778888',
      name: 'Frank',
      text: 'What time is it?',
      channel: 'whatsapp',
    });

    // During generation, only the user message was in DB
    expect(dbStateDuringGeneration).toEqual(['user:What time is it?']);

    // After processMessage completes, assistant message is now persisted
    const user = await db.findOrCreateUserByPhone('+15557778888');
    const conv = await db.getOrCreateActiveConversation(user.id, 'whatsapp');
    const finalMsgs = await db.getConversationMessages(conv.id);
    expect(finalMsgs.map((m) => m.sender_type)).toEqual(['user', 'assistant']);
    expect(finalMsgs[1].content).toBe('AI generated answer');
  });

  it('End-to-End Regression: AgentOrchestrator + GeminiProvider across 2 WhatsApp turns (user -> model -> user)', async () => {
    const db = new InMemoryRepository();
    const toolRegistry = createDefaultToolRegistry({ db });
    const sdkCalls: any[] = [];

    const geminiProvider = new GeminiProvider({
      apiKey: 'test-api-key',
      generateContentFn: async (params) => {
        sdkCalls.push(JSON.parse(JSON.stringify(params.contents)));
        const lastTurn = params.contents[params.contents.length - 1];
        // Exact real-world Gemini behavior: rejects with HTTP 400 if ending with a model turn
        if (lastTurn.role === 'model') {
          const err: any = new Error(
            'HTTP 400 INVALID_ARGUMENT: Requests ending with a model turn are not supported.'
          );
          err.status = 400;
          throw err;
        }
        return { text: `Reply to ${lastTurn.parts[0].text}` };
      },
    });

    const orchestrator = new AgentOrchestrator(geminiProvider, toolRegistry, db);

    // Turn 1: Inbound WhatsApp message "Hello NEXA"
    const turn1Result = await orchestrator.processMessage({
      phoneNumber: '+15550001111',
      name: 'Alice',
      text: 'Hello NEXA',
      channel: 'whatsapp',
    });
    expect(turn1Result.replyText).toBe('Reply to Hello NEXA');

    // Turn 2: Follow-up WhatsApp message "What can you do?"
    // Persisted history at this point:
    // [0]: user "Hello NEXA"
    // [1]: assistant "Reply to Hello NEXA"
    // When turn 2 is processed, it must construct:
    // user ("Hello NEXA") -> model ("Reply to Hello NEXA") -> user ("What can you do?")
    const turn2Result = await orchestrator.processMessage({
      phoneNumber: '+15550001111',
      name: 'Alice',
      text: 'What can you do?',
      channel: 'whatsapp',
    });
    expect(turn2Result.replyText).toBe('Reply to What can you do?');

    // Verify Turn 1 SDK call
    expect(sdkCalls[0]).toHaveLength(1);
    expect(sdkCalls[0][0]).toEqual({ role: 'user', parts: [{ text: 'Hello NEXA' }] });

    // Verify Turn 2 SDK call: exact user -> model -> user sequence
    expect(sdkCalls[1]).toHaveLength(3);
    expect(sdkCalls[1][0]).toEqual({ role: 'user', parts: [{ text: 'Hello NEXA' }] });
    expect(sdkCalls[1][1]).toEqual({ role: 'model', parts: [{ text: 'Reply to Hello NEXA' }] });
    expect(sdkCalls[1][2]).toEqual({ role: 'user', parts: [{ text: 'What can you do?' }] });
  });

  describe('Gemini 3 Function Calling & thoughtSignature Preservation Suite', () => {
    it('Exact Production Failure Reproduction & Fix: preserves thoughtSignature in multi-step tool calls', async () => {
      const db = new InMemoryRepository();
      const toolRegistry = createDefaultToolRegistry({ db });
      const sdkRequests: any[] = [];
      let stepCount = 0;

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const geminiProvider = new GeminiProvider({
        apiKey: 'test-key',
        generateContentFn: async (params) => {
          sdkRequests.push(JSON.parse(JSON.stringify(params.contents)));
          stepCount++;

          // Verify that in all subsequent turns (step > 1), ANY model turn containing
          // functionCall MUST have thoughtSignature.
          // Exact reproduction of Google Gemini 3 HTTP 400 rejection:
          for (const content of params.contents) {
            if (content.role === 'model' && Array.isArray(content.parts)) {
              for (const part of content.parts) {
                if (part.functionCall) {
                  const hasThoughtSignature =
                    Boolean(part.thoughtSignature) ||
                    Boolean(part.thought_signature) ||
                    Boolean(part.functionCall?.thoughtSignature) ||
                    Boolean(part.functionCall?.thought_signature);

                  if (!hasThoughtSignature) {
                    const err: any = new Error(
                      `HTTP 400 INVALID_ARGUMENT: Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly. function default_api:${part.functionCall.name}`
                    );
                    err.status = 400;
                    throw err;
                  }
                }
              }
            }
          }

          if (stepCount === 1) {
            // First Gemini response: returns functionCall for web_search WITH thoughtSignature
            return {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: {
                          name: 'web_search',
                          args: { query: 'tokyo weather' },
                        },
                        thoughtSignature: 'opaque_b64_sig_web_search_step1',
                      },
                    ],
                  },
                },
              ],
              functionCalls: [
                {
                  name: 'web_search',
                  args: { query: 'tokyo weather' },
                },
              ],
            };
          }

          // Second Gemini response: final text response after tool execution
          return {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'The weather in Tokyo is sunny and 22C.' }],
                },
              },
            ],
            text: 'The weather in Tokyo is sunny and 22C.',
          };
        },
      });

      const orchestrator = new AgentOrchestrator(geminiProvider, toolRegistry, db);

      const result = await orchestrator.processMessage({
        phoneNumber: '+15554443333',
        name: 'Grace',
        text: 'What is the weather in Tokyo?',
        channel: 'whatsapp',
      });

      // Proof of Fix: The 400 error was not thrown; tool was executed and final reply returned
      expect(result.replyText).toBe('The weather in Tokyo is sunny and 22C.');
      expect(result.stepsCount).toBe(2);

      // Verify Second Gemini request contents:
      // Turn 0: user ('What is the weather in Tokyo?')
      // Turn 1: model (web_search WITH thoughtSignature preserved!)
      // Turn 2: user (functionResponse)
      expect(sdkRequests).toHaveLength(2);
      const step2Contents = sdkRequests[1];
      expect(step2Contents).toHaveLength(3);

      const modelTurn = step2Contents[1];
      expect(modelTurn.role).toBe('model');
      expect(modelTurn.parts[0].functionCall.name).toBe('web_search');
      expect(modelTurn.parts[0].thoughtSignature).toBe('opaque_b64_sig_web_search_step1');

      const toolRespTurn = step2Contents[2];
      expect(toolRespTurn.role).toBe('user');
      expect(toolRespTurn.parts[0].functionResponse.name).toBe('web_search');

      // Verify sanitized logging (Requirement 16)
      const logged = logSpy.mock.calls.map((c) => c[0]);
      expect(logged.some((m) => m === '[Gemini] tool_call name=web_search')).toBe(true);
      expect(logged.some((m) => m === '[Gemini] tool_call_signature_present=true')).toBe(true);
      expect(logged.some((m) => m === '[Gemini] tool_response name=web_search')).toBe(true);
      // Ensure raw thought signature itself is NEVER logged
      expect(logged.some((m) => typeof m === 'string' && m.includes('opaque_b64_sig_web_search_step1'))).toBe(false);

      logSpy.mockRestore();
    });

    it('Test A: functionCall signature preserved in model parts', async () => {
      const db = new InMemoryRepository();
      const toolRegistry = createDefaultToolRegistry({ db });
      let capturedStep2Contents: any = null;

      const geminiProvider = new GeminiProvider({
        apiKey: 'test-key',
        generateContentFn: async (params) => {
          if (params.contents.length === 1) {
            return {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: {
                          name: 'web_search',
                          args: { query: 'test query' },
                        },
                        thoughtSignature: 'sig_test_a_123',
                      },
                    ],
                  },
                },
              ],
              functionCalls: [{ name: 'web_search', args: { query: 'test query' } }],
            };
          }
          capturedStep2Contents = params.contents;
          return { text: 'Done' };
        },
      });

      const orchestrator = new AgentOrchestrator(geminiProvider, toolRegistry, db);
      await orchestrator.processMessage({
        phoneNumber: '+15551113333',
        name: 'Henry',
        text: 'Search for test query',
        channel: 'whatsapp',
      });

      expect(capturedStep2Contents).toBeDefined();
      expect(capturedStep2Contents[1].parts[0].thoughtSignature).toBe('sig_test_a_123');
    });

    it('Test B: sequential tool calls preserve signatures across multiple turns', async () => {
      const db = new InMemoryRepository();
      const toolRegistry = createDefaultToolRegistry({ db });
      const sdkRequests: any[] = [];
      let step = 0;

      const geminiProvider = new GeminiProvider({
        apiKey: 'test-key',
        generateContentFn: async (params) => {
          step++;
          sdkRequests.push(JSON.parse(JSON.stringify(params.contents)));

          // Verify all previous model turns in history have their thought signatures intact
          for (const content of params.contents) {
            if (content.role === 'model') {
              for (const p of content.parts) {
                if (p.functionCall && !p.thoughtSignature && !p.thought_signature) {
                  throw new Error(`Missing signature for ${p.functionCall.name}`);
                }
              }
            }
          }

          if (step === 1) {
            // Step 1: call web_search
            return {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: { name: 'web_search', args: { query: 'first search' } },
                        thoughtSignature: 'sig_step_1_search',
                      },
                    ],
                  },
                },
              ],
              functionCalls: [{ name: 'web_search', args: { query: 'first search' } }],
            };
          }

          if (step === 2) {
            // Step 2: call calculator
            return {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: { name: 'calculator', args: { expression: '10 + 5' } },
                        thoughtSignature: 'sig_step_2_calc',
                      },
                    ],
                  },
                },
              ],
              functionCalls: [{ name: 'calculator', args: { expression: '10 + 5' } }],
            };
          }

          // Step 3: final answer
          return { text: 'All sequential tools executed successfully.' };
        },
      });

      const orchestrator = new AgentOrchestrator(geminiProvider, toolRegistry, db);
      const res = await orchestrator.processMessage({
        phoneNumber: '+15552224444',
        name: 'Ian',
        text: 'Do two sequential tasks',
        channel: 'whatsapp',
      });

      expect(res.replyText).toBe('All sequential tools executed successfully.');
      expect(step).toBe(3);

      // Verify Step 3 contents:
      // Turn 0: user prompt
      // Turn 1: model (web_search with sig_step_1_search)
      // Turn 2: user (web_search response)
      // Turn 3: model (calculator with sig_step_2_calc)
      // Turn 4: user (calculator response)
      const step3Contents = sdkRequests[2];
      expect(step3Contents).toHaveLength(5);
      expect(step3Contents[1].parts[0].thoughtSignature).toBe('sig_step_1_search');
      expect(step3Contents[3].parts[0].thoughtSignature).toBe('sig_step_2_calc');
    });

    it('Test C: multiple function calls in single turn preserve correct ordering and signatures', async () => {
      const db = new InMemoryRepository();
      const toolRegistry = createDefaultToolRegistry({ db });
      let capturedStep2: any = null;

      const geminiProvider = new GeminiProvider({
        apiKey: 'test-key',
        generateContentFn: async (params) => {
          if (params.contents.length === 1) {
            return {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: { name: 'web_search', args: { query: 'a' } },
                        thoughtSignature: 'sig_parallel_1',
                      },
                      {
                        functionCall: { name: 'calculator', args: { expression: '1+1' } },
                        thoughtSignature: 'sig_parallel_2',
                      },
                    ],
                  },
                },
              ],
              functionCalls: [
                { name: 'web_search', args: { query: 'a' } },
                { name: 'calculator', args: { expression: '1+1' } },
              ],
            };
          }

          capturedStep2 = params.contents;
          return { text: 'Parallel tools done' };
        },
      });

      const orchestrator = new AgentOrchestrator(geminiProvider, toolRegistry, db);
      await orchestrator.processMessage({
        phoneNumber: '+15553335555',
        name: 'Jack',
        text: 'Do two parallel tasks',
        channel: 'whatsapp',
      });

      expect(capturedStep2).toBeDefined();
      const modelTurn = capturedStep2[1];
      expect(modelTurn.parts).toHaveLength(2);
      expect(modelTurn.parts[0].functionCall.name).toBe('web_search');
      expect(modelTurn.parts[0].thoughtSignature).toBe('sig_parallel_1');
      expect(modelTurn.parts[1].functionCall.name).toBe('calculator');
      expect(modelTurn.parts[1].thoughtSignature).toBe('sig_parallel_2');

      const userResponseTurn = capturedStep2[2];
      expect(userResponseTurn.parts).toHaveLength(2);
      expect(userResponseTurn.parts[0].functionResponse.name).toBe('web_search');
      expect(userResponseTurn.parts[1].functionResponse.name).toBe('calculator');
    });

    it('Test D: final response after tool execution is persisted cleanly', async () => {
      const db = new InMemoryRepository();
      const toolRegistry = createDefaultToolRegistry({ db });

      const geminiProvider = new GeminiProvider({
        apiKey: 'test-key',
        generateContentFn: async (params) => {
          if (params.contents.length === 1) {
            return {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: { name: 'web_search', args: { query: 'final test' } },
                        thoughtSignature: 'sig_final_1',
                      },
                    ],
                  },
                },
              ],
              functionCalls: [{ name: 'web_search', args: { query: 'final test' } }],
            };
          }
          return { text: 'Here is the completed clean reply.' };
        },
      });

      const orchestrator = new AgentOrchestrator(geminiProvider, toolRegistry, db);
      const res = await orchestrator.processMessage({
        phoneNumber: '+15554446666',
        name: 'Kate',
        text: 'Do final test',
        channel: 'whatsapp',
      });

      expect(res.replyText).toBe('Here is the completed clean reply.');

      // Verify DB contains only the user query and the final clean assistant text
      const msgs = await db.getConversationMessages(res.conversationId);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].sender_type).toBe('user');
      expect(msgs[1].sender_type).toBe('assistant');
      expect(msgs[1].content).toBe('Here is the completed clean reply.');
    });

    it('Test E: existing user->model->user regression continues to pass with tool history', async () => {
      const db = new InMemoryRepository();
      const toolRegistry = createDefaultToolRegistry({ db });
      const sdkTurnEndRoles: string[] = [];

      const geminiProvider = new GeminiProvider({
        apiKey: 'test-key',
        generateContentFn: async (params) => {
          const lastTurn = params.contents[params.contents.length - 1];
          sdkTurnEndRoles.push(lastTurn.role);
          if (lastTurn.role !== 'user') {
            throw new Error('Requests ending with a model turn are not supported.');
          }
          return { text: 'Response OK' };
        },
      });

      const orchestrator = new AgentOrchestrator(geminiProvider, toolRegistry, db);

      await orchestrator.processMessage({
        phoneNumber: '+15555557777',
        name: 'Leo',
        text: 'Message 1',
        channel: 'whatsapp',
      });

      await orchestrator.processMessage({
        phoneNumber: '+15555557777',
        name: 'Leo',
        text: 'Message 2',
        channel: 'whatsapp',
      });

      expect(sdkTurnEndRoles).toEqual(['user', 'user']);
    });

    it('Test F: no text-only reconstruction of active tool-call history', async () => {
      const db = new InMemoryRepository();
      const toolRegistry = createDefaultToolRegistry({ db });
      let capturedPart: any = null;

      const geminiProvider = new GeminiProvider({
        apiKey: 'test-key',
        generateContentFn: async (params) => {
          if (params.contents.length === 1) {
            return {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        thought: true,
                        text: 'Thinking about the tool to use...',
                        thoughtSignature: 'thought_sig_inner',
                      },
                      {
                        functionCall: { name: 'web_search', args: { query: 'deep search' } },
                        thoughtSignature: 'func_sig_inner',
                        customMetadata: { origin: 'gemini-3' },
                      },
                    ],
                  },
                },
              ],
              functionCalls: [{ name: 'web_search', args: { query: 'deep search' } }],
            };
          }

          // Second request: Inspect that the active tool turn was NOT reduced to plain text
          capturedPart = params.contents[1].parts[1];
          return { text: 'Deep search complete' };
        },
      });

      const orchestrator = new AgentOrchestrator(geminiProvider, toolRegistry, db);
      await orchestrator.processMessage({
        phoneNumber: '+15556668888',
        name: 'Mia',
        text: 'Run deep search',
        channel: 'whatsapp',
      });

      expect(capturedPart).toBeDefined();
      expect(capturedPart.functionCall.name).toBe('web_search');
      expect(capturedPart.thoughtSignature).toBe('func_sig_inner');
      expect(capturedPart.customMetadata).toEqual({ origin: 'gemini-3' });
    });
  });
});

