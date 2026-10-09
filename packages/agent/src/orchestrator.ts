import {
  AIProvider,
  AIMessage,
  AIResponse,
  NexaError,
  ToolExecutionContext,
  ChannelType,
  MediaType,
  ApprovalRequiredError,
  ToolResult,
  ThinkingLevel,
  NameSource,
  TitleSource,
  BROWSER_NAVIGATION_TIMEOUT_MS,
  BROWSER_SCREENSHOT_TIMEOUT_MS,
  BROWSER_CLICK_TIMEOUT_MS,
  BROWSER_TYPE_TIMEOUT_MS,
  BROWSER_READ_TIMEOUT_MS,
  BROWSER_ACTION_TIMEOUT_MS,
  WEB_SEARCH_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  TOTAL_AGENT_DEADLINE_MS,
  MAX_AGENT_STEPS,
  COMMERCE_TASK_MAX_STEPS,
  COMMERCE_TASK_DEADLINE_MS,
  COMPUTER_USE_TASK_DEADLINE_MS,
  REQUEST_MESSAGE_DEADLINE_MS,
  MessageIntent,
  ActiveRequestContext,
} from '@nexa/shared';
import { IDatabaseRepository, MemoryService } from '@nexa/database';
import { ToolRegistry, merchantResolver, clearUserCart, UserAssistedHandoffManager } from '@nexa/tools';
import { PlaywrightBrowserService } from '@nexa/browser';
import { buildSystemInstruction } from './prompts.js';
import { IdentityManager } from './identity.js';
import { MemoryCommandHandler } from './memory-commands.js';
import { TaskStateMachine } from './task-state-machine.js';
import {
  isCancellationMessage,
  isPauseMessage,
  isContinuationMessage,
  classifyMessageIntent,
} from './request-context.js';

export interface AgentProcessInput {
  phoneNumber: string;
  name?: string;
  whatsappProfileName?: string;
  preferredName?: string;
  nameConfirmed?: boolean;
  nameSource?: NameSource;
  preferredTitle?: string;
  titleConfirmed?: boolean;
  titleSource?: TitleSource;
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
 * Resolves tool-specific timeout in milliseconds.
 * browser_open: 15s (15000ms)
 * browser_screenshot: 10s (10000ms)
 * browser interaction/read: 10s (10000ms)
 * web_search: 10s (10000ms)
 * default: 7s (7000ms)
 */
export function resolveToolTimeout(toolName: string, defaultTimeout = DEFAULT_TOOL_TIMEOUT_MS): number {
  switch (toolName) {
    case 'browser_open':
    case 'browser_navigate':
      return BROWSER_NAVIGATION_TIMEOUT_MS; // 25000
    case 'browser_screenshot':
      return BROWSER_SCREENSHOT_TIMEOUT_MS; // 12000
    case 'browser_click':
      return BROWSER_CLICK_TIMEOUT_MS; // 12000
    case 'browser_type':
    case 'browser_fill':
      return BROWSER_TYPE_TIMEOUT_MS; // 12000
    case 'browser_read':
      return BROWSER_READ_TIMEOUT_MS; // 12000
    case 'browser_scroll':
    case 'browser_wait':
    case 'browser_press':
    case 'browser_select':
    case 'browser_hover':
    case 'browser_verify_cart':
    case 'browser_restore_session':
    case 'shopping_verify_cart':
    case 'shopping_verify_order':
    case 'shopping_get_checkout':
    case 'shopping_checkout':
      return BROWSER_ACTION_TIMEOUT_MS; // 12000
    case 'web_search':
    case 'shopping_search':
    case 'youtube_search':
      return WEB_SEARCH_TIMEOUT_MS; // 10000
    case 'youtube_get_transcript':
    case 'youtube_analyze_video':
    case 'youtube_compare_reviews':
    case 'youtube_research_report':
    case 'multimodal_analyze_media':
    case 'document_extract_text':
      return 15000;
    default:
      return defaultTimeout;
  }
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

export interface ActiveRunningTask {
  taskId: string;
  conversationId: string;
  abortController: AbortController;
  stateMachine: TaskStateMachine;
  paused?: boolean;
}

export class AgentOrchestrator {
  private static activeRunningTasks = new Map<string, ActiveRunningTask>();

  public static getActiveRunningTasks(): Map<string, ActiveRunningTask> {
    return AgentOrchestrator.activeRunningTasks;
  }

  private handoffManager: UserAssistedHandoffManager;

  constructor(
    private aiProvider: AIProvider,
    private toolRegistry: ToolRegistry,
    private db: IDatabaseRepository,
    private maxSteps = MAX_AGENT_STEPS,
    private whatsappClient?: any,
    private toolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
    private totalDeadlineMs = TOTAL_AGENT_DEADLINE_MS,
    private commerceMaxSteps = COMMERCE_TASK_MAX_STEPS,
    private commerceDeadlineMs = COMMERCE_TASK_DEADLINE_MS,
    private browserService?: PlaywrightBrowserService,
    handoffManager?: UserAssistedHandoffManager
  ) {
    this.handoffManager = handoffManager || UserAssistedHandoffManager.getInstance(db);
  }

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
    let user = await this.db.findOrCreateUserByPhone(input.phoneNumber, input.name);
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

    let context: ToolExecutionContext = {
      user,
      conversation,
      messageId: userMessage.id,
      sourceChannel: channel,
      whatsappClient: input.whatsappClient || this.whatsappClient,
      recipientPhone: input.phoneNumber || user.phone_number,
    };

    // 4. Concurrently fetch pending approvals and conversation history
    const [pendingApproval, rawHistory] = await Promise.all([
      this.db.getPendingApproval(conversation.id),
      this.db.getConversationMessages(conversation.id, 10),
    ]);

    // Context Isolation & Boundary Setup (Bug 1 & Bug 6)
    const hasPreviousUnfinishedCommerce = rawHistory.some(
      (m) =>
        m.sender_type === 'user' &&
        /\b(order|buy|cart|checkout|instamart|blinkit|zepto|amazon|swiggy)\b/i.test(m.content || '')
    );
    const hasPreviousUnfinishedTask = rawHistory.some(
      (m) =>
        m.sender_type === 'user' &&
        /\b(order|buy|cart|checkout|instamart|blinkit|zepto|amazon|swiggy|flight|hotel|booking|book)\b/i.test(m.content || '')
    );

    const isCancel = isCancellationMessage(input.text || '');
    const isPause = isPauseMessage(input.text || '');
    const pendingHandoff = await this.handoffManager.getLatestPendingHandoff(user.id);
    const isContinuationWord = isContinuationMessage(input.text || '');
    const isContinue = !isCancel && !isPause && (hasPreviousUnfinishedTask || Boolean(pendingHandoff)) && isContinuationWord;

    const currentRequestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const currentActiveTaskId = isContinue
      ? `task_${conversation.id}_resumed`
      : `task_${conversation.id}_${Date.now()}`;

    console.log(`[Context] request_created requestId=${currentRequestId} taskId=${currentActiveTaskId}`);

    let intent = classifyMessageIntent(input.text || '', {
      isContinuation: isContinue,
      isCancellation: isCancel,
      isPause,
    });
    console.log(`[Context] request_intent_classified intent=${intent} requestId=${currentRequestId}`);

    if (isCancel) {
      console.log(`[Context] stale_context_rejected reason="user_cancelled"`);
      console.log(`[Context] previous_task_not_resumed reason="user_cancelled"`);

      const running = AgentOrchestrator.activeRunningTasks.get(conversation.id);
      if (running) {
        running.abortController.abort(new Error('Task cancelled by user'));
        if (running.stateMachine.canTransitionTo('CANCELLED')) {
          running.stateMachine.transitionTo('CANCELLED');
        }
        AgentOrchestrator.activeRunningTasks.delete(conversation.id);
      }

      if (pendingApproval) {
        await this.db.updateApprovalStatus(pendingApproval.id, 'rejected');
      }

      clearUserCart(user.id);

      const cancelStateMachine = new TaskStateMachine('CREATED');
      if (cancelStateMachine.canTransitionTo('CANCELLED')) {
        cancelStateMachine.transitionTo('CANCELLED');
      }
      console.log(`[Agent] task_cancelled reason="user_cancelled" steps=0`);

      const reply = "I've stopped and cancelled your active request. Your cart has been cleared. What would you like to do next?";
      await this.db.saveMessage({
        conversation_id: conversation.id,
        sender_type: 'assistant',
        content: reply,
      });

      return {
        replyText: reply,
        conversationId: conversation.id,
        stepsCount: 0,
      };
    }

    if (isPause) {
      const running = AgentOrchestrator.activeRunningTasks.get(conversation.id);
      if (running) {
        running.paused = true;
      }
      console.log(`[Agent] task_paused reason="user_paused"`);

      const reply = "Paused. I've put everything on hold. Just say 'continue' or 'proceed' whenever you're ready!";
      await this.db.saveMessage({
        conversation_id: conversation.id,
        sender_type: 'assistant',
        content: reply,
      });

      return {
        replyText: reply,
        conversationId: conversation.id,
        stepsCount: 0,
      };
    }

    if (hasPreviousUnfinishedTask && !isContinue) {
      console.log(`[Context] previous_task_not_resumed reason="no_explicit_continuation"`);
    }

    if (isContinue && pendingHandoff) {
      console.log(`[Context] continuation_detected conversationId=${conversation.id}`);
      console.log(`[Handoff] resume_attempt user=${user.id} merchant=${pendingHandoff.merchant}`);

      const readiness = await this.handoffManager.checkSessionReadiness(user.id, pendingHandoff.merchant);

      if (!readiness.ready) {
        // Stop automated retries; do not invoke headless browser to fail again in a loop
        console.log(`[Handoff] resume_rejected user=${user.id} merchant=${pendingHandoff.merchant} reason="${readiness.reason}"`);

        const reply =
          readiness.userFacingMessage ||
          `I checked ${pendingHandoff.merchant}, but an authorized session hasn't been connected yet. To proceed, please connect your session or order directly via ${pendingHandoff.directUrl}. Reply "resume" once done!`;

        await this.db.saveMessage({
          conversation_id: conversation.id,
          sender_type: 'assistant',
          content: reply,
        });

        return {
          replyText: reply,
          conversationId: conversation.id,
          stepsCount: 0,
        };
      } else {
        // Authorized session established! Apply session credentials to browser
        console.log(`[Handoff] resume_approved user=${user.id} merchant=${pendingHandoff.merchant} cookies_count=${readiness.cookiesCount}`);
        if (this.browserService) {
          await this.handoffManager.applySessionToBrowser(this.browserService, user.id, pendingHandoff.merchant);
        }
        await this.handoffManager.clearPendingHandoff(user.id, pendingHandoff.merchant);
        intent = 'SHOPPING';
      }
    }

    const stateMachine = new TaskStateMachine('CREATED');

    // 5. Identity & Preferred Name Onboarding Flow
    const identityResult = await IdentityManager.handleInboundMessage({
      user,
      text: input.text || '',
      conversationHistory: rawHistory,
      db: this.db,
      whatsappProfileName: input.whatsappProfileName,
      explicitName: input.name,
      explicitConfirmed: input.nameConfirmed,
      explicitSource: input.nameSource,
    });

    user = identityResult.user;
    context.user = user;

    if (identityResult.handled && identityResult.replyText) {
      if (stateMachine.canTransitionTo('COMPLETED')) {
        stateMachine.transitionTo('COMPLETED');
      }
      console.log(`[Agent] task_completed steps=0`);
      await this.db.saveMessage({
        conversation_id: conversation.id,
        sender_type: 'assistant',
        content: identityResult.replyText,
      });

      return {
        replyText: identityResult.replyText,
        conversationId: conversation.id,
        stepsCount: 0,
      };
    }

    // 5b. Memory Controls & Commands (Part 10: WhatsApp memory controls)
    const memoryCommandResult = await MemoryCommandHandler.handleCommand({
      user,
      text: input.text || '',
      db: this.db,
    });

    if (memoryCommandResult.doNotRememberConversation) {
      conversation.metadata = { ...(conversation.metadata || {}), do_not_remember: true };
    }

    if (memoryCommandResult.handled && memoryCommandResult.replyText) {
      if (stateMachine.canTransitionTo('COMPLETED')) {
        stateMachine.transitionTo('COMPLETED');
      }
      console.log(`[Agent] task_completed steps=0 memory_command=true`);
      await this.db.saveMessage({
        conversation_id: conversation.id,
        sender_type: 'assistant',
        content: memoryCommandResult.replyText,
      });

      return {
        replyText: memoryCommandResult.replyText,
        conversationId: conversation.id,
        stepsCount: 0,
      };
    }

    // 6. Check for Pending Approvals
    if (pendingApproval) {
      if (stateMachine.canTransitionTo('WAITING_APPROVAL')) {
        stateMachine.transitionTo('WAITING_APPROVAL');
      }
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

        if (executionResult.success) {
          if (stateMachine.canTransitionTo('COMPLETED')) {
            stateMachine.transitionTo('COMPLETED');
          }
          console.log(`[Agent] task_completed steps=1`);
        } else {
          if (stateMachine.canTransitionTo('FAILED')) {
            stateMachine.transitionTo('FAILED');
          }
          console.log(`[Agent] task_failed reason="confirmed_action_failed" steps=1`);
        }
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

        if (stateMachine.canTransitionTo('CANCELLED')) {
          stateMachine.transitionTo('CANCELLED');
        }
        console.log(`[Agent] task_cancelled reason="user_rejected" steps=1`);
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

    // 7. Build Context for Agent Reasoning Loop with Intent-Relevant Memories
    const memoryService = new MemoryService(this.db);
    const memories = await memoryService.getRelevantMemories(user.id, input.text || '');
    const systemInstruction = buildSystemInstruction(user, memories);
    const messages: AIMessage[] = rawHistory.map((m) => ({
      role: m.sender_type === 'user' ? 'user' : 'assistant',
      content: m.content,
    }));

    // Ensure the final content/turn sent to Gemini is ALWAYS a USER turn.
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

    // Intent Tool Gate (Bug 6 & Universal Intents)
    const allDeclarations = this.toolRegistry.getDeclarations();
    let toolDeclarations: typeof allDeclarations = [];

    const isControlOrConversation = [
      'CONVERSATION',
      'CONTROL_STOP',
      'CONTROL_CANCEL',
      'CONTROL_WAIT',
      'CONTROL_RESUME',
    ].includes(intent);

    if (isControlOrConversation) {
      // Pure conversation / capabilities / greetings / controls: NO tools provided so Gemini cannot call shopping_search
      toolDeclarations = [];
    } else if (intent === 'YOUTUBE_RESEARCH') {
      toolDeclarations = allDeclarations.filter(
        (t) => t.name.startsWith('youtube_') || t.name === 'web_search' || t.name.startsWith('memory_')
      );
    } else if (intent === 'MULTIMODAL_ANALYSIS') {
      toolDeclarations = allDeclarations.filter(
        (t) => t.name.startsWith('multimodal_') || t.name.startsWith('document_') || t.name === 'web_search' || t.name.startsWith('memory_')
      );
    } else if (intent === 'RESEARCH') {
      // Web search, youtube search, and browser tools only; no commerce, booking, or financial tools
      toolDeclarations = allDeclarations.filter(
        (t) =>
          !t.name.startsWith('shopping_') &&
          !t.name.startsWith('wallet_') &&
          !t.name.startsWith('book_') &&
          !['search_products', 'compare_prices', 'send_email'].includes(t.name)
      );
    } else if (intent === 'BROWSER_AUTOMATION') {
      toolDeclarations = allDeclarations.filter(
        (t) =>
          t.name.startsWith('browser_') ||
          t.name.startsWith('computer_use') ||
          t.name === 'web_search' ||
          t.name.startsWith('memory_')
      );
    } else if (intent === 'SHOPPING') {
      // Shopping and browser tools
      toolDeclarations = allDeclarations.filter(
        (t) =>
          !t.name.startsWith('book_') &&
          !['send_email', 'create_calendar_event', 'create_reminder'].includes(t.name)
      );
    } else if (intent === 'TRAVEL') {
      // Travel and browser tools
      toolDeclarations = allDeclarations.filter(
        (t) =>
          !t.name.startsWith('shopping_') &&
          !['send_email', 'create_calendar_event', 'create_reminder'].includes(t.name)
      );
    } else if (intent === 'EMAIL') {
      toolDeclarations = allDeclarations.filter(
        (t) => t.name.includes('email') || t.name.startsWith('memory_')
      );
    } else if (intent === 'REMINDER') {
      toolDeclarations = allDeclarations.filter(
        (t) => t.name.includes('reminder') || t.name.includes('calendar') || t.name.startsWith('memory_')
      );
    } else if (intent === 'CALENDAR') {
      toolDeclarations = allDeclarations.filter(
        (t) => t.name.includes('calendar') || t.name.includes('reminder') || t.name.startsWith('memory_')
      );
    } else if (intent === 'WALLET') {
      toolDeclarations = allDeclarations.filter(
        (t) => t.name.startsWith('wallet_') || t.name === 'approval_action' || t.name.startsWith('memory_')
      );
    } else if (intent === 'OTHER') {
      toolDeclarations = allDeclarations.filter(
        (t) =>
          !t.name.startsWith('shopping_') &&
          !t.name.startsWith('wallet_') &&
          !t.name.startsWith('book_') &&
          !['search_products', 'compare_prices'].includes(t.name)
      );
    } else {
      toolDeclarations = allDeclarations;
    }

    // Exact Merchant Resolution & Commerce Task Routing
    // Hard rule: MerchantResolver MUST ONLY run for actual shopping or commerce tasks.
    // It must NEVER run for CONVERSATION, RESEARCH, OTHER, IDENTITY, CONTROLS, EMAIL, REMINDER, CALENDAR, WALLET, YOUTUBE, or MULTIMODAL requests.
    const isMerchantEligibleIntent =
      intent === 'SHOPPING' ||
      (intent === 'TRAVEL' && /\b(?:makemytrip|booking|mmt|flight|hotel)\b/i.test(input.text || '')) ||
      (intent === 'BROWSER_AUTOMATION' && /\b(?:instamart|blinkit|zepto|amazon|flipkart|swiggy|makemytrip|booking)\b/i.test(input.text || ''));

    const resolvedMerchant = isMerchantEligibleIntent
      ? merchantResolver.resolve(input.text || '')
      : null;
    if (resolvedMerchant) {
      console.log(`[Agent] merchant_resolved merchant=${resolvedMerchant.name} canonical_url=${resolvedMerchant.canonicalUrl}`);
    }

    const isCommerceTask =
      isMerchantEligibleIntent &&
      (intent === 'SHOPPING' ||
        Boolean(resolvedMerchant) ||
        (isContinue && hasPreviousUnfinishedCommerce));

    let effectiveMaxSteps = this.maxSteps;
    let effectiveDeadlineMs = this.totalDeadlineMs;

    if (isCommerceTask) {
      effectiveMaxSteps = Math.max(this.maxSteps, this.commerceMaxSteps);
      effectiveDeadlineMs = Math.max(this.totalDeadlineMs, this.commerceDeadlineMs);
    } else if (intent === 'YOUTUBE_RESEARCH') {
      effectiveMaxSteps = 8;
      effectiveDeadlineMs = Math.max(this.totalDeadlineMs, 25000);
    } else if (intent === 'MULTIMODAL_ANALYSIS') {
      effectiveMaxSteps = 5;
      effectiveDeadlineMs = Math.max(this.totalDeadlineMs, 20000);
    } else if (intent === 'RESEARCH' || intent === 'BROWSER_AUTOMATION') {
      effectiveMaxSteps = 10;
      effectiveDeadlineMs =
        this.totalDeadlineMs >= TOTAL_AGENT_DEADLINE_MS
          ? Math.max(this.totalDeadlineMs, COMPUTER_USE_TASK_DEADLINE_MS)
          : this.totalDeadlineMs;
    }

    const planName = isCommerceTask
      ? (resolvedMerchant ? `commerce_order_${resolvedMerchant.merchantId}` : 'commerce_order_execution')
      : 'understand_and_execute';

    if (stateMachine.canTransitionTo('PLANNING')) {
      stateMachine.transitionTo('PLANNING');
    }

    // 8. Multi-Step Agent Execution Loop
    let currentStep = 0;
    let finalReply = '';
    let latestExecutionToolFailed = false;
    let modelFailed = false;
    let verifiedSuccess = false;
    let executionToolCalled = false;
    let deadlineApproaching = false;
    const executedToolNames: string[] = [];

    console.log(`[Agent] task_created taskId=${currentActiveTaskId} user=${user.id}`);
    console.log(`[Agent] plan_created plan="${planName}" maxSteps=${effectiveMaxSteps}`);

    // Active in-memory raw Gemini Content[] history for intermediate tool turns
    let activeRawHistory: any[] | undefined = undefined;

    const taskAbortController = new AbortController();
    AgentOrchestrator.activeRunningTasks.set(conversation.id, {
      taskId: currentActiveTaskId,
      conversationId: conversation.id,
      abortController: taskAbortController,
      stateMachine,
    });

    try {
      while (currentStep < effectiveMaxSteps) {
        if (stateMachine.isTerminal() || taskAbortController.signal.aborted) {
          console.log(`[Agent] task_execution_aborted is_terminal=${stateMachine.isTerminal()} aborted=${taskAbortController.signal.aborted}`);
          break;
        }

        // Overall request deadline check
        const elapsedMs = Date.now() - requestStartTime;
        const remainingMs = effectiveDeadlineMs - elapsedMs;
        if (remainingMs <= 3000) {
          console.log(`[Agent] deadline_approaching remaining_ms=${remainingMs}`);
          deadlineApproaching = true;
          if (stateMachine.canTransitionTo('FAILED')) {
            stateMachine.transitionTo('FAILED');
          }
          console.log(`[Agent] task_failed reason="deadline_approaching" steps=${currentStep}`);
          break;
        }

        currentStep++;
        console.log(`[Agent] step_started step=${currentStep}`);

      const thinkingLevel = resolveThinkingLevel(currentTurnContent, currentStep, input.thinkingLevel);
      console.log(`[WhatsApp Path] gemini_request_start step=${currentStep} thinking_level=${thinkingLevel}`);
      const stepStartTime = Date.now();

      let aiResponse: AIResponse;
      try {
        aiResponse = await this.aiProvider.generateResponse(messages, {
          systemInstruction,
          tools: toolDeclarations,
          thinkingLevel,
          currentUserText: currentTurnContent,
          currentUserMedia: userMediaPart,
          rawHistory: activeRawHistory,
          isCommerceTask,
          isToolUse: isCommerceTask || toolDeclarations.length > 0,
          overallDeadlineMs: remainingMs,
        });
      } catch (geminiErr: any) {
        modelFailed = true;
        console.log(`[Agent] model_execution_failed step=${currentStep} error="${geminiErr.message}"`);
        if (stateMachine.canTransitionTo('FAILED')) {
          stateMachine.transitionTo('FAILED');
        }
        console.log(`[Agent] task_failed reason="model_failed" steps=${currentStep}`);

        finalReply =
          geminiErr instanceof NexaError && geminiErr.userFacingMessage
            ? geminiErr.userFacingMessage
            : "I'm currently having trouble connecting to the AI service due to high demand. Please try again in a moment.";
        break;
      }

      const stepLatency = Date.now() - stepStartTime;
      console.log(`[WhatsApp Path] gemini_response_received step=${currentStep} latency_ms=${stepLatency}`);

      // Case A: Model returned plain text without calling any tools
      if (!aiResponse.toolCalls || aiResponse.toolCalls.length === 0) {
        if (!latestExecutionToolFailed) {
          console.log(`[Agent] step_completed step=${currentStep}`);
        }
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
        const rawModelTurn = JSON.parse(JSON.stringify(aiResponse.rawModelContent));
        if (!rawModelTurn.role) rawModelTurn.role = 'model';
        activeRawHistory.push(rawModelTurn);
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
      let stepHadToolFailure = false;

      for (const tc of aiResponse.toolCalls) {
        if (stateMachine.isTerminal() || taskAbortController.signal.aborted) {
          console.log(`[Agent] tool_execution_skipped tool=${tc.name} reason="terminal_or_aborted"`);
          break;
        }
        const tcName = tc.name;

        // Verify request ID and task ID boundaries (Bug 1, Rule 9)
        const tcRequestId = (tc as any).requestId || currentRequestId;
        const tcTaskId = (tc as any).taskId || currentActiveTaskId;

        if (tcRequestId !== currentRequestId || tcTaskId !== currentActiveTaskId) {
          console.log(`[Context] stale_tool_call_rejected tool=${tcName} tool_call_id=${tc.id}`);
          const staleMsg = `Tool call ${tcName} rejected: stale tool call from different request or task context.`;
          toolResultsForNextTurn.push({
            toolCallId: tc.id,
            name: tcName,
            result: { error: staleMsg },
            isError: true,
          });
          functionResponseParts.push({
            functionResponse: {
              name: tcName,
              response: { error: staleMsg },
              id: tc.id,
            },
          });
          continue;
        }

        // Tag tool call with active context boundaries
        (tc as any).requestId = currentRequestId;
        (tc as any).taskId = currentActiveTaskId;

        // Dynamic Computer-Use Deadline Extension (Bug 2)
        const isBrowserTool = tcName.startsWith('browser_');
        if (
          isBrowserTool &&
          this.totalDeadlineMs >= TOTAL_AGENT_DEADLINE_MS &&
          effectiveDeadlineMs < COMPUTER_USE_TASK_DEADLINE_MS
        ) {
          console.log(`[Agent] deadline_extended task_type="computer_use" new_deadline_ms=${COMPUTER_USE_TASK_DEADLINE_MS}`);
          effectiveDeadlineMs = COMPUTER_USE_TASK_DEADLINE_MS;
          effectiveMaxSteps = Math.max(effectiveMaxSteps, 10);
        }

        executionToolCalled = true;
        if (stateMachine.canTransitionTo('EXECUTING')) {
          stateMachine.transitionTo('EXECUTING');
        }
        const signature = normalizeToolSignature(tcName, tc.arguments as Record<string, unknown>);
        console.log(`[Agent] step=${currentStep} tool=${tcName}`);
        if (tcName.includes('verify')) {
          if (stateMachine.canTransitionTo('VERIFYING')) {
            stateMachine.transitionTo('VERIFYING');
          }
          console.log(`[Agent] verification_started tool=${tcName}`);
        }
        if (
          tcName === 'shopping_checkout' ||
          tcName === 'wallet_pay' ||
          tcName === 'book_flight' ||
          tcName === 'book_hotel'
        ) {
          if (stateMachine.canTransitionTo('EXECUTING_PAYMENT')) {
            stateMachine.transitionTo('EXECUTING_PAYMENT');
          }
          console.log(`[Agent] execution_started action=${tcName}`);
        }

        // Check 1: Tool disabled for this session due to repeated failures (2 or more)
        if (disabledTools.has(tcName)) {
          console.log(`[Agent] tool_disabled name=${tcName} reason="max retries exceeded"`);
          const disabledMsg =
            tcName === 'web_search' && isCommerceTask
              ? `Tool web_search is unavailable due to repeated timeouts. Do not abort. Instead, proceed directly to ${resolvedMerchant?.name || 'the merchant'} using browser_open, shopping_search, or other browser tools.`
              : `Tool ${tcName} is unavailable for this request due to repeated failures. Please continue without it using available knowledge or explain the situation to the user.`;
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

        // Check 3: Calculate tool-specific bounded timeout respecting total request deadline
        const configuredToolTimeout = resolveToolTimeout(tcName, this.toolTimeoutMs);
        const elapsedSinceStart = Date.now() - requestStartTime;
        const remainingUntilDeadline = effectiveDeadlineMs - elapsedSinceStart;

        // Hard minimum meaningful tool budget (at least 3000ms). Never launch a 1-second doomed tool call!
        const MIN_MEANINGFUL_TOOL_BUDGET_MS = 3000;
        if (remainingUntilDeadline < MIN_MEANINGFUL_TOOL_BUDGET_MS) {
          console.log(`[Agent] deadline_insufficient remaining_ms=${remainingUntilDeadline} min_required_ms=${MIN_MEANINGFUL_TOOL_BUDGET_MS} tool=${tcName}`);
          deadlineApproaching = true;
          if (stateMachine.canTransitionTo('FAILED')) {
            stateMachine.transitionTo('FAILED');
          }
          console.log(`[Agent] task_failed reason="deadline_exceeded" steps=${currentStep}`);
          if (this.browserService && currentActiveTaskId) {
            this.browserService.markTaskTerminal(currentActiveTaskId);
          }
          break;
        }

        // Keep 1500ms safety buffer for response serialization / network return
        const maxAvailableForTool = Math.max(MIN_MEANINGFUL_TOOL_BUDGET_MS, remainingUntilDeadline - 1500);
        const effectiveTimeoutMs = Math.min(configuredToolTimeout, maxAvailableForTool);

        // Check 4: Execute tool with cancellation AbortController
        const abortController = new AbortController();
        if (taskAbortController.signal.aborted) {
          abortController.abort(new Error('Task was aborted'));
        } else {
          taskAbortController.signal.addEventListener(
            'abort',
            () => {
              abortController.abort(new Error('Task was aborted'));
            },
            { once: true }
          );
        }
        let timeoutTimer: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            // ACTUALLY abort underlying operation (Playwright page close / fetch abort)
            abortController.abort(new Error(`Tool ${tcName} timed out after ${effectiveTimeoutMs}ms`));
            const timeoutErr = new Error(`Tool ${tcName} timed out after ${effectiveTimeoutMs}ms`);
            timeoutErr.name = 'ToolTimeoutError';
            reject(timeoutErr);
          }, effectiveTimeoutMs);
        });

        const toolExecutionContext: ToolExecutionContext = {
          ...context,
          requestId: currentRequestId,
          taskId: currentActiveTaskId,
          toolCallId: tc.id,
          sessionId: (context as any).sessionId || context.user?.id || 'default',
          abortSignal: abortController.signal,
          timeoutMs: effectiveTimeoutMs,
        };

        try {
          const execPromise = this.toolRegistry.executeTool(tcName, tc.arguments, toolExecutionContext);
          const result = await Promise.race([execPromise, timeoutPromise]);
          if (timeoutTimer) clearTimeout(timeoutTimer);

          if (stateMachine.isTerminal() || taskAbortController.signal.aborted) {
            console.log(`[Agent] tool_result_discarded tool=${tcName} reason="terminal_or_aborted"`);
            break;
          }

          executedToolNames.push(tcName);

          if (result.success) {
            latestExecutionToolFailed = false;
            console.log(`[Agent] tool_success name=${tcName}`);
            if (tcName.includes('verify')) {
              verifiedSuccess = true;
              console.log(`[Agent] verification_passed tool=${tcName}`);
            }
            if (tcName.includes('restore')) {
              console.log(`[Agent] recovery_completed tool=${tcName} status="recovered"`);
            }
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
            latestExecutionToolFailed = true;
            stepHadToolFailure = true;
            const errMsg = result.error || 'Tool execution returned failure';
            const attempts = (toolFailures.get(tcName) || 0) + 1;
            toolFailures.set(tcName, attempts);
            failedSignatures.add(signature);
            console.log(`[Agent] step_failed step=${currentStep} tool=${tcName} error="${errMsg}"`);
            console.log(`[Agent] tool_error name=${tcName} error="${errMsg}" attempts=${attempts}`);

            if (attempts >= 2) {
              disabledTools.add(tcName);
              console.log(`[Agent] tool_disabled name=${tcName} reason="max retries exceeded"`);
            }

            if (stateMachine.canTransitionTo('RECOVERING')) {
              stateMachine.transitionTo('RECOVERING');
            }
            console.log(`[Agent] recovery_started tool=${tcName} reason="${errMsg}"`);

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
          if (!abortController.signal.aborted) {
            abortController.abort(err);
          }
          if (this.browserService) {
            await this.browserService.cleanupPage().catch(() => {});
          }

          // Check if this was an intentional pause for user confirmation!
          if (err instanceof ApprovalRequiredError || err?.name === 'ApprovalRequiredError') {
            if (stateMachine.canTransitionTo('WAITING_APPROVAL')) {
              stateMachine.transitionTo('WAITING_APPROVAL');
            }
            console.log(`[Agent] waiting_approval tool=${tcName}`);
            console.log(`[Agent] step_completed step=${currentStep} status="awaiting_approval"`);
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
          if (stateMachine.isTerminal() || taskAbortController.signal.aborted) {
            if (this.browserService && currentActiveTaskId) {
              this.browserService.markTaskTerminal(currentActiveTaskId);
            }
            console.log(`[Agent] tool_result_discarded tool=${tcName} reason="terminal_or_aborted"`);
            break;
          }

          latestExecutionToolFailed = true;
          stepHadToolFailure = true;
          const errMsg = err.message || 'Tool execution failed';
          const attempts = (toolFailures.get(tcName) || 0) + 1;
          toolFailures.set(tcName, attempts);
          failedSignatures.add(signature);
          console.log(`[Agent] step_failed step=${currentStep} tool=${tcName} error="${errMsg}"`);
          console.log(`[Agent] tool_error name=${tcName} error="${errMsg}" attempts=${attempts}`);

          if (attempts >= 2) {
            disabledTools.add(tcName);
            console.log(`[Agent] tool_disabled name=${tcName} reason="max retries exceeded"`);
          }

          const isTimeout =
            err.name === 'ToolTimeoutError' ||
            (err.message && err.message.toLowerCase().includes('timed out')) ||
            abortController.signal.aborted;

          if (stateMachine.canTransitionTo('RECOVERING')) {
            stateMachine.transitionTo('RECOVERING');
          }
          console.log(`[Agent] recovery_started tool=${tcName} reason="${errMsg}"`);

          const errorPayload: Record<string, unknown> = isTimeout
            ? { success: false, errorType: 'TIMEOUT', error: errMsg, message: errMsg }
            : { success: false, error: errMsg };

          toolResultsForNextTurn.push({
            toolCallId: tc.id,
            name: tcName,
            result: errorPayload,
            isError: true,
          });

          functionResponseParts.push({
            functionResponse: {
              name: tcName,
              response: errorPayload,
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

      // Append function responses to activeRawHistory
      if (activeRawHistory) {
        activeRawHistory.push({
          role: 'user',
          parts: functionResponseParts,
        });
      }

      if (!stepHadToolFailure && !stateMachine.isTerminal() && !taskAbortController.signal.aborted) {
        console.log(`[Agent] step_completed step=${currentStep}`);
      }
    }
  } finally {
    if (AgentOrchestrator.activeRunningTasks.get(conversation.id)?.taskId === currentActiveTaskId) {
      AgentOrchestrator.activeRunningTasks.delete(conversation.id);
    }
  }

    if (currentStep >= effectiveMaxSteps && !finalReply) {
      console.log(`[Agent] max_steps_reached limit=${effectiveMaxSteps}`);
      if (stateMachine.canTransitionTo('FAILED')) {
        stateMachine.transitionTo('FAILED');
      }
      console.log(`[Agent] task_failed reason="max_steps_reached" steps=${currentStep}`);
    }

    if (deadlineApproaching) {
      finalReply =
        "I was unable to complete the request within the allocated time limit. Please try again or simplify your request.";
    } else if (!finalReply) {
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

      // A genuine network outage occurs only if the latest execution failed due to a network tool,
      // and NO subsequent network/browser tool succeeded in making progress.
      const hasSuccessfulNetworkAction = executedToolNames.some(
        (name) => networkToolNames.includes(name) && !disabledTools.has(name)
      );

      const hadNetworkToolFailures =
        !hasSuccessfulNetworkAction &&
        (latestExecutionToolFailed || Array.from(disabledTools).some((name) => networkToolNames.includes(name))) &&
        Array.from(toolFailures.entries()).some(
          ([name, count]) => count > 0 && networkToolNames.includes(name)
        );

      if (hadNetworkToolFailures) {
        finalReply =
          "I'm currently unable to access the web or online services due to a temporary network issue. Please try again in a moment or let me know if there's anything else I can assist with.";
      } else if (latestExecutionToolFailed) {
        finalReply =
          "I encountered an issue executing the requested action. The action could not be completed safely. Please try again or let me know how you would like to proceed.";
      } else if (currentStep >= effectiveMaxSteps) {
        finalReply =
          "I have reached the maximum processing steps for this request. Please let me know how you'd like to proceed, or try rephrasing your request.";
      } else if (isCommerceTask) {
        finalReply =
          `I am ready to proceed with your order on ${resolvedMerchant?.name || 'the merchant'}. Please let me know if you would like me to continue.`;
      } else {
        finalReply =
          "I have gathered the information for your request. Let me know if you would like me to take any further action!";
      }
    }

    if (deadlineApproaching) {
      if (this.browserService && currentActiveTaskId) {
        this.browserService.markTaskTerminal(currentActiveTaskId);
      }
      // Already transitioned to FAILED and logged [Agent] task_failed reason="deadline_approaching"
    } else if (latestExecutionToolFailed) {
      if (stateMachine.canTransitionTo('FAILED')) {
        stateMachine.transitionTo('FAILED');
      }
      if (this.browserService && currentActiveTaskId) {
        this.browserService.markTaskTerminal(currentActiveTaskId);
      }
      console.log(`[Agent] task_failed reason="action_execution_failed" steps=${currentStep}`);
    } else if (modelFailed) {
      if (stateMachine.canTransitionTo('FAILED')) {
        stateMachine.transitionTo('FAILED');
      }
      if (this.browserService && currentActiveTaskId) {
        this.browserService.markTaskTerminal(currentActiveTaskId);
      }
    } else if (currentStep >= effectiveMaxSteps && !finalReply) {
      if (stateMachine.canTransitionTo('FAILED')) {
        stateMachine.transitionTo('FAILED');
      }
      if (this.browserService && currentActiveTaskId) {
        this.browserService.markTaskTerminal(currentActiveTaskId);
      }
      console.log(`[Agent] task_failed reason="max_steps_reached" steps=${currentStep}`);
    } else if (finalReply && !modelFailed && !latestExecutionToolFailed && !deadlineApproaching) {
      if (!stateMachine.isTerminal() && stateMachine.canTransitionTo('COMPLETED')) {
        stateMachine.transitionTo('COMPLETED');
        console.log(`[Agent] task_completed steps=${currentStep}`);
      } else {
        console.log(`[Agent] task_completion_blocked current_state=${stateMachine.getState()}`);
      }
    }

    // 8b. Episodic Experience & Procedural Workflow Learning (Part 1 C & D, Part 4)
    const taskTools = executedToolNames.filter(
      (t) => !['save_memory', 'get_memory', 'forget_memory'].includes(t)
    );
    if (taskTools.length > 0 && !conversation.metadata?.do_not_remember) {
      const isSuccess = !modelFailed && !latestExecutionToolFailed && !deadlineApproaching;
      const errorMsg = latestExecutionToolFailed
        ? 'Action execution failed'
        : modelFailed
          ? 'Model failed'
          : deadlineApproaching
            ? 'Deadline reached'
            : undefined;

      try {
        await memoryService.recordEpisodicExperience({
          userId: user.id,
          taskRequest: input.text || '',
          approach: planName,
          toolsUsed: executedToolNames,
          outcome: isSuccess ? 'Task completed successfully' : (errorMsg || 'Task incomplete'),
          success: isSuccess,
          error: errorMsg,
          reusable: isSuccess && isCommerceTask,
        });

        if (isSuccess && verifiedSuccess && resolvedMerchant) {
          await memoryService.recordProceduralWorkflow({
            userId: user.id,
            service: resolvedMerchant.name,
            workflowName: 'verified_order_checkout',
            steps: executedToolNames,
            verified: true,
          });
        }
      } catch (err) {
        console.error('[Learning] error_recording_episodic_experience', err);
      }
    }

    // 9. Persist final assistant reply
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
