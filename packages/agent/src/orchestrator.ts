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

export class AgentOrchestrator {
  constructor(
    private aiProvider: AIProvider,
    private toolRegistry: ToolRegistry,
    private db: IDatabaseRepository,
    private maxSteps = 10,
    private whatsappClient?: any
  ) {}

  /**
   * Main entrypoint for processing any user message.
   */
  async processMessage(input: AgentProcessInput): Promise<AgentProcessOutput> {
    const channel = input.channel || 'whatsapp';
    const messageId = input.whatsappMessageId || input.wamid;

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
    const userMessage = await this.db.saveMessage({
      conversation_id: conversation.id,
      sender_type: 'user',
      content: input.text,
      media_url: input.mediaUrl || null,
      media_type: input.mediaType || null,
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
    const isCurrentUserAlreadyLast =
      lastHistoryMsg &&
      lastHistoryMsg.role === 'user' &&
      lastHistoryMsg.content === input.text;

    if (!isCurrentUserAlreadyLast) {
      messages.push({
        role: 'user',
        content: input.text,
      });
    }

    const toolDeclarations = this.toolRegistry.getDeclarations();

    // 7. Multi-Step Agent Execution Loop
    let currentStep = 0;
    let finalReply = '';

    while (currentStep < this.maxSteps) {
      currentStep++;

      const thinkingLevel = resolveThinkingLevel(input.text, currentStep, input.thinkingLevel);
      console.log(`[WhatsApp Path] gemini_request_start step=${currentStep} thinking_level=${thinkingLevel}`);
      const stepStartTime = Date.now();

      const aiResponse = await this.aiProvider.generateResponse(messages, {
        systemInstruction,
        tools: toolDeclarations,
        thinkingLevel,
        currentUserText: input.text,
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
      });

      const toolResultsForNextTurn: any[] = [];

      for (const tc of aiResponse.toolCalls) {
        try {
          const result = await this.toolRegistry.executeTool(tc.name, tc.arguments, context);

          toolResultsForNextTurn.push({
            toolCallId: tc.id,
            name: tc.name,
            result: result.data || { success: result.success },
            isError: !result.success,
          });
        } catch (err: any) {
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

          // Regular tool execution error: Feed error back to model
          toolResultsForNextTurn.push({
            toolCallId: tc.id,
            name: tc.name,
            result: { error: err.message },
            isError: true,
          });
        }
      }

      // Append tool results to message history for next reasoning step
      messages.push({
        role: 'tool',
        content: '',
        toolResults: toolResultsForNextTurn,
      });
    }

    if (!finalReply) {
      finalReply = "I have gathered the information for your request. Let me know if you would like me to take any further action!";
    }

    // 7. Persist final assistant reply
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
