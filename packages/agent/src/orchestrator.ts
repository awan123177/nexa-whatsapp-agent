import {
  AIProvider,
  AIMessage,
  ToolExecutionContext,
  ChannelType,
  MediaType,
  ApprovalRequiredError,
  ToolResult,
  ThinkingLevel,
} from '@nexa/shared';
import { IDatabaseRepository } from '@nexa/database';
import { ToolRegistry } from '@nexa/tools';
import { buildSystemInstruction } from './prompts.js';

export interface AgentProcessInput {
  phoneNumber: string;
  name?: string;
  text: string;
  channel?: ChannelType;
  mediaUrl?: string;
  mediaType?: MediaType;
  audioBuffer?: Buffer;
  audioMimeType?: string;
  whatsappMessageId?: string;
  wamid?: string;
  interactiveButtonId?: string;
  whatsappClient?: any;
  thinkingLevel?: ThinkingLevel;
  receivedAt?: number;
}

export interface AgentProcessOutput {
  replyText: string;
  conversationId: string;
  requiresApproval?: boolean;
  approvalPrompt?: string;
  approvalId?: string;
  stepsCount: number;
}

/**
 * Determines the appropriate Gemini thinking level:
 * - 'low' for real-time conversational chat (greetings, simple questions, single-turn replies).
 * - 'medium' for complex multi-step reasoning, tool synthesis, or explicit requests.
 */
export function resolveThinkingLevel(
  text: string,
  currentStep: number,
  explicitLevel?: ThinkingLevel
): ThinkingLevel {
  if (explicitLevel) return explicitLevel;
  if (currentStep > 1) {
    return 'medium'; // Elevate reasoning when synthesizing tool outputs in multi-step flows
  }
  const lower = text.toLowerCase();
  const complexTriggers = [
    'compare',
    'itinerary',
    'research and compare',
    'plan a trip',
    'analyze',
    'investigate',
    'multi-step',
    'detailed comparison',
    'flight and hotel',
  ];
  if (complexTriggers.some((t) => lower.includes(t))) {
    return 'medium';
  }
  return 'low';
}

/**
 * Normalizes tool arguments to create a stable signature for duplicate detection.
 */
export function normalizeToolSignature(name: string, args?: Record<string, unknown> | null): string {
  if (!args || typeof args !== 'object') {
    return `${name}:{}`;
  }
  try {
    const sortedKeys = Object.keys(args).sort();
    const sortedObj: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      sortedObj[k] = (args as any)[k];
    }
    return `${name}:${JSON.stringify(sortedObj)}`;
  } catch {
    return `${name}:${String(args)}`;
  }
}

export class AgentOrchestrator {
  constructor(
    private aiProvider: AIProvider,
    private toolRegistry: ToolRegistry,
    private db: IDatabaseRepository,
    private maxSteps = 5,
    private whatsappClient?: any,
    private toolTimeoutMs = 7000,
    private totalDeadlineMs = 22000
  ) {}

  /**
   * Main entrypoint for processing any user message.
   */
  async processMessage(input: AgentProcessInput): Promise<AgentProcessOutput> {
    const channel = input.channel || 'whatsapp';
    const messageId = input.whatsappMessageId || input.wamid;
    const requestStartTime = input.receivedAt || Date.now();

    // Per-request tracking for loop prevention, deduplication, and failure policies
    const toolFailures = new Map<string, number>();
    const disabledTools = new Set<string>();
    const failedSignatures = new Set<string>();

    // 1. Message Deduplication check (crucial for WhatsApp Cloud API retries)
    // Check wamid FIRST to avoid unnecessary DB user/conversation queries on duplicates
    if (messageId) {
      const existing = await this.db.getMessageByWhatsAppId(messageId);
      if (existing) {
        console.log(`[AgentOrchestrator] Duplicate WhatsApp message ${messageId} ignored.`);
        const conversationMessages = await this.db.getConversationMessages(existing.conversation_id, 10);
        const replyMessage = conversationMessages.find(
          (m) => m.sender_type === 'assistant' && new Date(m.created_at) >= new Date(existing.created_at)
        );
        return {
          replyText: replyMessage?.content || '',
          conversationId: existing.conversation_id || '',
          stepsCount: 0,
        };
      }
    }

    // 2. Identify or create User and Active Conversation
    const user = await this.db.findOrCreateUserByPhone(input.phoneNumber, input.name);
    const conversation = await this.db.getOrCreateActiveConversation(user.id, channel);

    // 3. Persist incoming user message
    const effectiveText = input.text || (input.audioBuffer ? '[Voice Note]' : '');
    const userMessage = await this.db.saveMessage({
      conversation_id: conversation.id,
      sender_type: 'user',
      content: effectiveText,
      media_url: input.mediaUrl || null,
      media_type: input.mediaType || (input.audioBuffer ? 'audio' : null),
      whatsapp_message_id: messageId || null,
      raw_payload: input.interactiveButtonId ? { buttonId: input.interactiveButtonId } : null,
    });

    const context: ToolExecutionContext = {
      user,
      conversation,
      messageId: userMessage.id,
      sourceChannel: channel,
      whatsappClient: input.whatsappClient || this.whatsappClient,
      recipientPhone: input.phoneNumber || user.phone_number,
    };

    // 4. Concurrently fetch pending approvals, user memories, and conversation history
    // Avoid redundant sequential database roundtrips to minimize time-to-first-token
    const [pendingApproval, memories, rawHistory] = await Promise.all([
      this.db.getPendingApproval(conversation.id),
      this.db.getUserMemories(user.id),
      this.db.getConversationMessages(conversation.id, 10),
    ]);

    // 5. Check for Pending Approvals
    if (pendingApproval) {
      const lowerText = input.text.trim().toLowerCase();
      const words = lowerText.split(/[\s,;.!?]+/).filter(Boolean);
      const isApproved =
        input.interactiveButtonId?.startsWith('approve_') ||
        words.some((w) => ['yes', 'approve', 'confirm', 'proceed', 'yup', 'ok', 'sure', 'confirming'].includes(w));
      const isRejected =
        input.interactiveButtonId?.startsWith('reject_') ||
        words.some((w) => ['no', 'cancel', 'stop', 'abort', 'reject', "don't", 'deny'].includes(w));

      if (isApproved) {
        // User confirmed: Update approval and execute the paused action!
        await this.db.updateApprovalStatus(pendingApproval.id, 'approved');

        let executionResult: ToolResult;
        try {
          executionResult = await this.toolRegistry.executeTool(
            pendingApproval.tool_name,
            pendingApproval.arguments,
            { ...context, isUserConfirmed: true }
          );
        } catch (err: any) {
          executionResult = {
            success: false,
            error: err.message,
            userFacingMessage: `Error executing confirmed action: ${err.message}`,
          };
        }

        const reply =
          executionResult.userFacingMessage ||
          `Action confirmed and completed: ${pendingApproval.summary}`;

        await this.db.saveMessage({
          conversation_id: conversation.id,
          sender_type: 'assistant',
          content: reply,
        });

        return {
          replyText: reply,
          conversationId: conversation.id,
          stepsCount: 1,
        };
      } else if (isRejected) {
        // User rejected: Cancel the action
        await this.db.updateApprovalStatus(pendingApproval.id, 'rejected');
        const reply = "Understood. I've cancelled that action. How else can I help you?";

        await this.db.saveMessage({
          conversation_id: conversation.id,
          sender_type: 'assistant',
          content: reply,
        });

        return {
          replyText: reply,
          conversationId: conversation.id,
          stepsCount: 1,
        };
      }
      // If user said something unrelated, keep approval pending and fall through to normal agent loop
    }

    // 6. Build Context for Agent Reasoning Loop
    const systemInstruction = buildSystemInstruction(user, memories);
    const messages: AIMessage[] = rawHistory.map((m) => ({
      role: m.sender_type === 'user' ? 'user' : 'assistant',
      content: m.content,
    }));

    // Ensure the final content/turn sent to Gemini is ALWAYS a USER turn.
    // If history ended with an assistant/model turn, or the current inbound message
    // is not already at the end of the history array, append the current user message.
    const lastHistoryMsg = messages[messages.length - 1];
    const userMediaPart = input.audioBuffer
      ? {
          mimeType: input.audioMimeType || 'audio/ogg; codecs=opus',
          data: input.audioBuffer.toString('base64'),
        }
      : undefined;

    const currentTurnContent =
      input.text || (input.audioBuffer ? '[Voice Note]' : '');

    const isCurrentUserAlreadyLast =
      lastHistoryMsg &&
      lastHistoryMsg.role === 'user' &&
      lastHistoryMsg.content === currentTurnContent;

    if (!isCurrentUserAlreadyLast) {
      messages.push({
        role: 'user',
        content: currentTurnContent,
        media: userMediaPart,
      });
    } else if (userMediaPart && lastHistoryMsg) {
      lastHistoryMsg.media = userMediaPart;
    }

    const toolDeclarations = this.toolRegistry.getDeclarations();

    // 7. Multi-Step Agent Execution Loop
    let currentStep = 0;
    let finalReply = '';

    // Active in-memory raw Gemini Content[] history for intermediate tool turns
    let activeRawHistory: any[] | undefined = undefined;

    while (currentStep < this.maxSteps) {
      // Overall request deadline check
      const elapsedMs = Date.now() - requestStartTime;
      const remainingMs = this.totalDeadlineMs - elapsedMs;
      if (remainingMs <= 3000) {
        console.log(`[Agent] deadline_approaching remaining_ms=${remainingMs}`);
        break;
      }

      currentStep++;

      const thinkingLevel = resolveThinkingLevel(currentTurnContent, currentStep, input.thinkingLevel);
      console.log(`[WhatsApp Path] gemini_request_start step=${currentStep} thinking_level=${thinkingLevel}`);
      const stepStartTime = Date.now();

      const aiResponse = await this.aiProvider.generateResponse(messages, {
        systemInstruction,
        tools: toolDeclarations,
        thinkingLevel,
        currentUserText: currentTurnContent,
        currentUserMedia: userMediaPart,
        rawHistory: activeRawHistory,
      });

      const stepLatency = Date.now() - stepStartTime;
      console.log(`[WhatsApp Path] gemini_response_received step=${currentStep} latency_ms=${stepLatency}`);

      // Case A: Model returned plain text without calling any tools
      if (!aiResponse.toolCalls || aiResponse.toolCalls.length === 0) {
        finalReply = aiResponse.text;
        break;
      }

      // Case B: Model requested one or more tool calls
      messages.push({
        role: 'assistant',
        content: aiResponse.text || '',
        toolCalls: aiResponse.toolCalls,
        rawModelContent: aiResponse.rawModelContent,
        rawModelParts: aiResponse.rawModelParts,
      });

      // Maintain activeRawHistory for multi-step tool execution
      // Initialize with preceding conversation history up to current user turn
      if (!activeRawHistory) {
        activeRawHistory = messages.slice(0, -1).map((m) => {
          if (m.role === 'user') {
            return { role: 'user', parts: [{ text: m.content }] };
          } else if (m.role === 'assistant') {
            if (m.rawModelContent) return JSON.parse(JSON.stringify(m.rawModelContent));
            return { role: 'model', parts: [{ text: m.content || '...' }] };
          }
          return { role: 'user', parts: [{ text: m.content }] };
        });
      }

      // Append model's exact Content object (preserving functionCall and thoughtSignature)
      if (aiResponse.rawModelContent) {
        activeRawHistory.push(JSON.parse(JSON.stringify(aiResponse.rawModelContent)));
      } else if (aiResponse.rawModelParts) {
        activeRawHistory.push({
          role: 'model',
          parts: JSON.parse(JSON.stringify(aiResponse.rawModelParts)),
        });
      } else {
        const modelParts = aiResponse.toolCalls.map((tc) => {
          if (tc.rawPart) return JSON.parse(JSON.stringify(tc.rawPart));
          const fnObj: any = { name: tc.name, args: tc.arguments };
          if (tc.thoughtSignature) fnObj.thoughtSignature = tc.thoughtSignature;
          return {
            functionCall: fnObj,
            ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
          };
        });
        activeRawHistory.push({ role: 'model', parts: modelParts });
      }

      const toolResultsForNextTurn: any[] = [];
      const functionResponseParts: any[] = [];

      for (const tc of aiResponse.toolCalls) {
        const tcName = tc.name;
        const signature = normalizeToolSignature(tcName, tc.arguments as Record<string, unknown>);
        console.log(`[Agent] step=${currentStep} tool=${tcName}`);

        // Check 1: Tool disabled for this session due to repeated failures (2 or more)
        if (disabledTools.has(tcName)) {
          console.log(`[Agent] tool_disabled name=${tcName} reason="max retries exceeded"`);
          const disabledMsg = `Tool ${tcName} is unavailable for this request due to repeated failures. Please continue without it using available knowledge or explain the situation to the user.`;
          toolResultsForNextTurn.push({
            toolCallId: tc.id,
            name: tcName,
            result: { error: disabledMsg },
            isError: true,
          });
          functionResponseParts.push({
            functionResponse: {
              name: tcName,
              response: { error: disabledMsg },
              id: tc.id,
            },
          });
          continue;
        }

        // Check 2: Duplicate tool call with identical arguments that already failed
        if (failedSignatures.has(signature)) {
          console.log(`[Agent] duplicate_tool_blocked name=${tcName}`);
          const duplicateMsg = `Duplicate tool call to ${tcName} with identical arguments blocked because it already failed.`;
          toolResultsForNextTurn.push({
            toolCallId: tc.id,
            name: tcName,
            result: { error: duplicateMsg },
            isError: true,
          });
          functionResponseParts.push({
            functionResponse: {
              name: tcName,
              response: { error: duplicateMsg },
              id: tc.id,
            },
          });
          continue;
        }

        // Check 3: Execute tool with per-tool timeout
        let timeoutTimer: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            const timeoutErr = new Error(`Tool ${tcName} timed out after ${this.toolTimeoutMs}ms`);
            timeoutErr.name = 'ToolTimeoutError';
            reject(timeoutErr);
          }, this.toolTimeoutMs);
        });

        try {
          const execPromise = this.toolRegistry.executeTool(tcName, tc.arguments, context);
          const result = await Promise.race([execPromise, timeoutPromise]);
          if (timeoutTimer) clearTimeout(timeoutTimer);

          if (result.success) {
            console.log(`[Agent] tool_success name=${tcName}`);
            toolResultsForNextTurn.push({
              toolCallId: tc.id,
              name: tcName,
              result: result.data || { success: true },
              isError: false,
            });

            functionResponseParts.push({
              functionResponse: {
                name: tcName,
                response: {
                  result: result.data || { success: true },
                  isError: false,
                },
                id: tc.id,
              },
            });
          } else {
            // Tool returned structured failure
            const errMsg = result.error || 'Tool execution returned failure';
            const attempts = (toolFailures.get(tcName) || 0) + 1;
            toolFailures.set(tcName, attempts);
            failedSignatures.add(signature);
            console.log(`[Agent] tool_error name=${tcName} error="${errMsg}" attempts=${attempts}`);

            if (attempts >= 2) {
              disabledTools.add(tcName);
              console.log(`[Agent] tool_disabled name=${tcName} reason="max retries exceeded"`);
            }

            toolResultsForNextTurn.push({
              toolCallId: tc.id,
              name: tcName,
              result: { error: errMsg, details: result.data },
              isError: true,
            });

            functionResponseParts.push({
              functionResponse: {
                name: tcName,
                response: { error: errMsg, details: result.data },
                id: tc.id,
              },
            });
          }
        } catch (err: any) {
          if (timeoutTimer) clearTimeout(timeoutTimer);

          // Check if this was an intentional pause for user confirmation!
          if (err instanceof ApprovalRequiredError) {
            await this.db.saveMessage({
              conversation_id: conversation.id,
              sender_type: 'assistant',
              content: err.prompt,
            });

            return {
              replyText: err.prompt,
              conversationId: conversation.id,
              requiresApproval: true,
              approvalPrompt: err.prompt,
              approvalId: err.approvalId,
              stepsCount: currentStep,
            };
          }

          // Tool execution error / timeout
          const errMsg = err.message || 'Tool execution failed';
          const attempts = (toolFailures.get(tcName) || 0) + 1;
          toolFailures.set(tcName, attempts);
          failedSignatures.add(signature);
          console.log(`[Agent] tool_error name=${tcName} error="${errMsg}" attempts=${attempts}`);

          if (attempts >= 2) {
            disabledTools.add(tcName);
            console.log(`[Agent] tool_disabled name=${tcName} reason="max retries exceeded"`);
          }

          toolResultsForNextTurn.push({
            toolCallId: tc.id,
            name: tcName,
            result: { error: errMsg },
            isError: true,
          });

          functionResponseParts.push({
            functionResponse: {
              name: tcName,
              response: { error: errMsg },
              id: tc.id,
            },
          });
        }
      }

      // Append tool results to message history for next reasoning step
      messages.push({
        role: 'tool',
        content: '',
        toolResults: toolResultsForNextTurn,
      });

      // Append function response turn to activeRawHistory
      activeRawHistory.push({
        role: 'user',
        parts: functionResponseParts,
      });
    }

    if (currentStep >= this.maxSteps && !finalReply) {
      console.log(`[Agent] max_steps_reached limit=${this.maxSteps}`);
    }

    if (!finalReply) {
      const networkToolNames = [
        'web_search',
        'browser_open',
        'browser_navigate',
        'search_products',
        'search_flights',
        'search_hotels',
        'browse_web_page',
        'take_screenshot',
      ];

      const hadNetworkToolFailures =
        Array.from(disabledTools).some((name) => networkToolNames.includes(name)) ||
        Array.from(toolFailures.entries()).some(
          ([name, count]) => count > 0 && networkToolNames.includes(name)
        );

      if (hadNetworkToolFailures) {
        finalReply =
          "I'm currently unable to access the web or online services due to a temporary network issue. Please try again in a moment or let me know if there's anything else I can assist with.";
      } else if (currentStep >= this.maxSteps) {
        finalReply =
          "I have reached the maximum processing steps for this request. Please let me know how you'd like to proceed, or try rephrasing your request.";
      } else {
        finalReply =
          "I have gathered the information for your request. Let me know if you would like me to take any further action!";
      }
    }

    // 8. Persist final assistant reply
    await this.db.saveMessage({
      conversation_id: conversation.id,
      sender_type: 'assistant',
      content: finalReply,
    });

    return {
      replyText: finalReply,
      conversationId: conversation.id,
      stepsCount: currentStep,
    };
  }
}
