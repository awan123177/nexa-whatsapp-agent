import {
  AIProvider,
  AIMessage,
  ToolExecutionContext,
  ChannelType,
  MediaType,
  ApprovalRequiredError,
  ToolResult,
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
  interactiveButtonId?: string;
  whatsappClient?: any;
}

export interface AgentProcessOutput {
  replyText: string;
  conversationId: string;
  requiresApproval?: boolean;
  approvalPrompt?: string;
  approvalId?: string;
  stepsCount: number;
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

    // 1. Identify or create User and Active Conversation
    const user = await this.db.findOrCreateUserByPhone(input.phoneNumber, input.name);
    const conversation = await this.db.getOrCreateActiveConversation(user.id, channel);

    // 2. Message Deduplication check (crucial for WhatsApp Cloud API retries)
    if (input.whatsappMessageId) {
      const existing = await this.db.getMessageByWhatsAppId(input.whatsappMessageId);
      if (existing) {
        console.log(`[AgentOrchestrator] Duplicate WhatsApp message ${input.whatsappMessageId} ignored.`);
        return {
          replyText: '',
          conversationId: conversation.id,
          stepsCount: 0,
        };
      }
    }

    // 3. Persist incoming user message
    const userMessage = await this.db.saveMessage({
      conversation_id: conversation.id,
      sender_type: 'user',
      content: input.text,
      media_url: input.mediaUrl || null,
      media_type: input.mediaType || null,
      whatsapp_message_id: input.whatsappMessageId || null,
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

    // 4. Check for Pending Approvals
    const pendingApproval = await this.db.getPendingApproval(conversation.id);
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

    // 5. Retrieve User Memories and Conversation History
    const memories = await this.db.getUserMemories(user.id);
    const rawHistory = await this.db.getConversationMessages(conversation.id, 10);

    const systemInstruction = buildSystemInstruction(user, memories);
    const messages: AIMessage[] = rawHistory.map((m) => ({
      role: m.sender_type === 'user' ? 'user' : 'assistant',
      content: m.content,
    }));

    const toolDeclarations = this.toolRegistry.getDeclarations();

    // 6. Multi-Step Agent Execution Loop
    let currentStep = 0;
    let finalReply = '';

    while (currentStep < this.maxSteps) {
      currentStep++;

      const aiResponse = await this.aiProvider.generateResponse(messages, {
        systemInstruction,
        tools: toolDeclarations,
      });

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
