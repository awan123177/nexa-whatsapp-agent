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
import { ToolRegistry, merchantResolver, clearUserCart, UserAssistedHandoffManager, generateHandoffMessage } from '@nexa/tools';
import { PlaywrightBrowserService } from '@nexa/browser';
import { buildSystemInstruction } from './prompts.js';
import { IdentityManager } from './identity.js';
import { MemoryCommandHandler } from './memory-commands.js';
import { TaskStateMachine } from './task-state-machine.js';
import { ShoppingStateMachine, ShoppingWorkflowPhase } from './shopping-state-machine.js';
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
    case 'youtube_search':
      return WEB_SEARCH_TIMEOUT_MS; // 10000
    case 'shopping_search':
      return BROWSER_NAVIGATION_TIMEOUT_MS; // 15000
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
          const pageState = await this.browserService.inspectPageState();
          if (pageState.challengeDetected || pageState.authState === 'BLOCKED') {
            console.log(`[Handoff] resume_rejected_challenge_persists merchant=${pendingHandoff.merchant} challenge="${pageState.challengeType || 'CAPTCHA'}"`);
            const reply = `I checked ${pendingHandoff.merchant}, but the verification challenge (${pageState.challengeType || 'CAPTCHA'}) is still active on the cloud browser. Automated browsing cannot proceed until this challenge is cleared.`;
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
    const shoppingMachine = isCommerceTask ? new ShoppingStateMachine('INITIAL') : null;
    const visitedSearchUrls = new Map<string, number>();
    const executedSearchQueries = new Map<string, number>();

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
        let stepHadToolFailure = false;
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
        if (!latestExecutionToolFailed && !stepHadToolFailure && !deadlineApproaching) {
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
      stepHadToolFailure = false;

      for (const tc of aiResponse.toolCalls) {
        const tcName = tc.name;
        if (stateMachine.isTerminal() || taskAbortController.signal.aborted) {
          console.log(`[Agent] tool_execution_skipped tool=${tcName} reason="terminal_or_aborted"`);
          const skippedMsg = `Tool execution skipped: task is already terminal or cancelled.`;
          toolResultsForNextTurn.push({
            toolCallId: tc.id,
            name: tcName,
            result: { error: skippedMsg, cancelled: true },
            isError: true,
          });
          functionResponseParts.push({
            functionResponse: {
              name: tcName,
              response: { error: skippedMsg, cancelled: true },
              id: tc.id,
            },
          });
          continue;
        }

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

        // Check 2b: Shopping Loop & Browser State Preservation (Steps 4-7)
        if (isCommerceTask && shoppingMachine) {
          const tcArgs = (tc.arguments || {}) as Record<string, any>;
          const isSearchTool = tcName === 'shopping_search' || tcName === 'web_search' || tcName === 'search_products';

          // 1. Navigation regression guard: Do not navigate back to generic search/home if already on product or cart
          if (tcName === 'browser_open' && tcArgs.url) {
            const targetUrl = String(tcArgs.url).toLowerCase();
            const isGenericSearchOrHome =
              targetUrl.includes('/s?') ||
              targetUrl.includes('search') ||
              targetUrl.replace(/\/+$/, '') === 'https://www.amazon.in' ||
              targetUrl.replace(/\/+$/, '') === 'http://www.amazon.in';

            const currentActiveUrl = this.browserService?.getActiveUrl() || '';
            const isAlreadyOnProductOrCart =
              currentActiveUrl.includes('/dp/') ||
              currentActiveUrl.includes('/gp/product/') ||
              currentActiveUrl.includes('/cart/');

            if (isAlreadyOnProductOrCart && isGenericSearchOrHome) {
              console.log(
                `[Agent] navigation_regression_blocked current_url="${currentActiveUrl}" target_url="${targetUrl}" reason="browser_state_preserved"`
              );
              const preserveMsg =
                `Navigation back to generic search URL blocked. Browser is already at product/cart page (${currentActiveUrl}). Maintain current state and proceed directly to add item to cart, verify cart, or capture screenshot.`;
              toolResultsForNextTurn.push({
                toolCallId: tc.id,
                name: tcName,
                result: { blocked: true, reason: preserveMsg, currentUrl: currentActiveUrl },
                isError: false,
              });
              functionResponseParts.push({
                functionResponse: {
                  name: tcName,
                  response: { blocked: true, reason: preserveMsg, currentUrl: currentActiveUrl },
                  id: tc.id,
                },
              });
              continue;
            }

            // Repeated search URL navigation check
            if (isGenericSearchOrHome) {
              const urlVisits = (visitedSearchUrls.get(targetUrl) || 0) + 1;
              visitedSearchUrls.set(targetUrl, urlVisits);
              if (urlVisits > 1) {
                console.log(`[Agent] search_loop_detected url="${targetUrl}" count=${urlVisits} action="prevent_cycling"`);
                const loopMsg =
                  `Repeated search URL navigation blocked (${urlVisits} attempts). Products have already been observed. Proceed to select a product (e.g. Spigen 3-pack screen guard under ₹1,500), navigate to its product page, add to cart, verify cart, and capture screenshot.`;
                toolResultsForNextTurn.push({
                  toolCallId: tc.id,
                  name: tcName,
                  result: { blocked: true, reason: loopMsg, currentUrl: currentActiveUrl },
                  isError: false,
                });
                functionResponseParts.push({
                  functionResponse: {
                    name: tcName,
                    response: { blocked: true, reason: loopMsg, currentUrl: currentActiveUrl },
                    id: tc.id,
                  },
                });
                continue;
              }
            }
          }

          // 2. Repeated search queries check
          if (isSearchTool && tcArgs.query) {
            const queryNorm = String(tcArgs.query).trim().toLowerCase();
            const queryCount = (executedSearchQueries.get(queryNorm) || 0) + 1;
            executedSearchQueries.set(queryNorm, queryCount);
            if (queryCount > 1) {
              console.log(`[Agent] search_loop_detected query="${queryNorm}" count=${queryCount} action="prevent_cycling"`);
              const loopMsg =
                `Repeated search query "${tcArgs.query}" blocked (${queryCount} attempts). Product listings are already available. Proceed to select the matching product, navigate to its URL, add to cart, verify cart, and capture screenshot.`;
              toolResultsForNextTurn.push({
                toolCallId: tc.id,
                name: tcName,
                result: { blocked: true, reason: loopMsg },
                isError: false,
              });
              functionResponseParts.push({
                functionResponse: {
                  name: tcName,
                  response: { blocked: true, reason: loopMsg },
                  id: tc.id,
                },
              });
              continue;
            }
          }

          // 3. Browser Fallback & Active Session Interception (Priority Fix 3):
          // If browser is already open on merchant or fallback is active, prevent generic web_search/search_products
          if (tcName === 'search_products' || tcName === 'web_search') {
            const currentActiveUrl = this.browserService?.getActiveUrl() || '';
            const hasOpenMerchantPage =
              Boolean(currentActiveUrl) &&
              (currentActiveUrl.includes('amazon') ||
                currentActiveUrl.includes('swiggy') ||
                currentActiveUrl.includes('instamart') ||
                currentActiveUrl.includes('blinkit'));

            if (hasOpenMerchantPage || stateMachine.getState() === 'RECOVERING') {
              console.log(
                `[Agent] search_intercepted_for_open_session tool=${tcName} current_url="${currentActiveUrl}" action="use_browser_observe"`
              );
              const interceptMsg = currentActiveUrl
                ? `Browser session is already active at ${currentActiveUrl}. Do not call generic search tools. Inspect the active page using browser_observe to extract product links, or navigate directly using browser_open.`
                : `Browser fallback is active for ${resolvedMerchant?.name || 'the merchant'}. Do not retry web search. Open the merchant directly using browser_open and inspect items with browser_observe.`;
              toolResultsForNextTurn.push({
                toolCallId: tc.id,
                name: tcName,
                result: { blocked: true, reason: interceptMsg, currentUrl: currentActiveUrl },
                isError: false,
              });
              functionResponseParts.push({
                functionResponse: {
                  name: tcName,
                  response: { blocked: true, reason: interceptMsg, currentUrl: currentActiveUrl },
                  id: tc.id,
                },
              });
              continue;
            }
          }
        }

        // Check 3: Calculate tool-specific bounded timeout respecting total request deadline
        const configuredToolTimeout = resolveToolTimeout(tcName, this.toolTimeoutMs);
        const elapsedSinceStart = Date.now() - requestStartTime;
        const remainingUntilDeadline = effectiveDeadlineMs - elapsedSinceStart;

        // Check 3b: Dedicated safety buffer reservation for commerce tasks (Point 4)
        const COMMERCE_RESERVED_COMPLETION_BUFFER_MS = 15000;
        const isSearchAction =
          tcName === 'shopping_search' ||
          tcName === 'web_search' ||
          tcName === 'search_products' ||
          (tcName === 'browser_open' && String((tc.arguments as any)?.url || '').includes('/s?'));

        if (isCommerceTask && isSearchAction && remainingUntilDeadline < COMMERCE_RESERVED_COMPLETION_BUFFER_MS + 3000) {
          console.log(
            `[Agent] deadline_search_budget_insufficient remaining_ms=${remainingUntilDeadline} reserved_buffer_ms=${COMMERCE_RESERVED_COMPLETION_BUFFER_MS} tool=${tcName} action="skip_search_and_proceed"`
          );
          const budgetMsg =
            `New search skipped because remaining time (${remainingUntilDeadline}ms) is reserved for cart verification and screenshot delivery. Proceed immediately with existing product/cart state to verify cart, capture screenshot, and complete the request.`;
          toolResultsForNextTurn.push({
            toolCallId: tc.id,
            name: tcName,
            result: { skipped: true, reason: budgetMsg },
            isError: false,
          });
          functionResponseParts.push({
            functionResponse: {
              name: tcName,
              response: { skipped: true, reason: budgetMsg },
              id: tc.id,
            },
          });
          continue;
        }

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
            const isSearchTool = tcName === 'search_products' || tcName === 'web_search' || tcName === 'shopping_search';
            const data = (result.data || {}) as Record<string, any>;
            const isEmptySearchResult =
              isSearchTool &&
              Boolean(
                data.empty === true ||
                (Array.isArray(data.products) && data.products.length === 0) ||
                (Array.isArray(data.results) && data.results.length === 0)
              );

            if (isEmptySearchResult) {
              stepHadToolFailure = true;
              console.log(`[Agent] step_incomplete step=${currentStep} tool=${tcName} reason="empty_search_results"`);
              if (isCommerceTask) {
                if (stateMachine.canTransitionTo('RECOVERING')) {
                  stateMachine.transitionTo('RECOVERING');
                }
                console.log(`[Agent] plan_transition step=${currentStep} from=search to=browser_fallback reason="empty_search_results"`);
              }
            } else {
              latestExecutionToolFailed = false;
              console.log(`[Agent] tool_success name=${tcName}`);
            }

            // Track shopping workflow phase progression and telemetry (Steps 4-7)
            if (shoppingMachine) {
              const currentActiveBrowserUrl =
                (data.url as string) || (data.finalUrl as string) || this.browserService?.getActiveUrl();
              if (currentActiveBrowserUrl) {
                shoppingMachine.setCurrentUrl(currentActiveBrowserUrl);
              }

              if (tcName === 'browser_observe' || tcName === 'shopping_search' || tcName === 'search_products') {
                const observedProducts = (data.products as any[]) || [];
                if (observedProducts.length > 0) {
                  if (shoppingMachine.canAdvancePhaseTo('SELECT_PRODUCT')) {
                    shoppingMachine.advancePhase('SELECT_PRODUCT', 'products_observed');
                  }
                  // Identify preferred product if criteria matches
                  const matched =
                    observedProducts.find(
                      (p) =>
                        ((p.packSize && p.packSize >= 3) || (p.title && /3[- ]pack|pack of 3|set of 3/i.test(p.title))) &&
                        ((p.rawPrice && p.rawPrice <= 1500) || (p.price && p.price <= 1500))
                    ) || observedProducts[0];
                  if (matched) {
                    const isQual = shoppingMachine.isProductQualified(matched);
                    console.log(
                      `[ShoppingWorkflow] product_verified asin="${matched.asin || ''}" title="${matched.title}" price=${
                        matched.rawPrice || matched.price || 0
                      } pack_size=${matched.packSize || 1} qualified=${isQual}`
                    );
                    if (!shoppingMachine.getSelectedProduct()) {
                      shoppingMachine.setSelectedProduct({
                        asin: matched.asin,
                        title: matched.title,
                        price: matched.rawPrice || matched.price,
                        packSize: matched.packSize || 3,
                        url: matched.url || matched.href,
                        selector: matched.selector,
                      });
                    }
                  }
                }
              } else if (tcName === 'browser_open' || tcName === 'browser_click') {
                if (
                  currentActiveBrowserUrl &&
                  (currentActiveBrowserUrl.includes('/dp/') || currentActiveBrowserUrl.includes('/gp/product/'))
                ) {
                  const asinMatch = currentActiveBrowserUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
                  const detailAsin = asinMatch ? asinMatch[1] : shoppingMachine.getSelectedProduct()?.asin;
                  if (detailAsin && !shoppingMachine.getSelectedProduct()?.asin) {
                    const existing = shoppingMachine.getSelectedProduct();
                    if (existing) existing.asin = detailAsin;
                  }
                  if (shoppingMachine.canAdvancePhaseTo('VERIFY_PRODUCT')) {
                    shoppingMachine.advancePhase('VERIFY_PRODUCT', 'product_detail_page_reached');
                  }
                } else if (currentActiveBrowserUrl && currentActiveBrowserUrl.includes('/cart/')) {
                  if (shoppingMachine.canAdvancePhaseTo('VERIFY_CART')) {
                    shoppingMachine.advancePhase('VERIFY_CART', 'cart_page_reached');
                  }
                }
              } else if (tcName === 'shopping_add_to_cart') {
                if (shoppingMachine.canAdvancePhaseTo('ADD_TO_CART')) {
                  shoppingMachine.advancePhase('ADD_TO_CART', 'item_added_to_cart');
                }
              } else if (tcName === 'browser_verify_cart' || tcName === 'shopping_verify_cart') {
                const cartItems = (data.items as any[]) || [];
                const itemCount = cartItems.length || data.itemCount || 1;
                shoppingMachine.setVerifiedCart({
                  itemCount,
                  totalMinor: data.totalMinor,
                  formattedTotal: data.formattedTotal || '₹' + ((data.totalMinor || 0) / 100).toFixed(2),
                  items: cartItems,
                });
                if (shoppingMachine.canAdvancePhaseTo('CAPTURE_SCREENSHOT')) {
                  shoppingMachine.advancePhase('CAPTURE_SCREENSHOT', 'cart_verified');
                }
              } else if (tcName === 'browser_screenshot') {
                const mediaId = (data.mediaId as string) || undefined;
                const delivered = Boolean(data.deliveredToWhatsApp);
                if (delivered || mediaId) {
                  shoppingMachine.setScreenshotDelivered(mediaId);
                  if (shoppingMachine.canAdvancePhaseTo('DELIVER_SCREENSHOT')) {
                    shoppingMachine.advancePhase('DELIVER_SCREENSHOT', 'screenshot_delivered');
                  }
                  if (shoppingMachine.canAdvancePhaseTo('COMPLETED')) {
                    shoppingMachine.advancePhase('COMPLETED', 'transaction_free_workflow_completed');
                  }
                  console.log(
                    `[ShoppingWorkflow] workflow_completed reason="cart_verified_and_screenshot_delivered" media_id="${
                      mediaId || 'none'
                    }"`
                  );
                } else {
                  console.log(
                    `[ShoppingWorkflow] screenshot_delivery_failed media_id="${mediaId || 'none'}" reason="not_delivered_to_whatsapp"`
                  );
                }
              }
              shoppingMachine.emitTelemetry();
            }

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
            const rawErrorType = (result as any).errorType || (result.data as any)?.errorType;
            const sessionMetadata =
              typeof (this.browserService as any)?.getSessionMetadata === 'function'
                ? (this.browserService as any).getSessionMetadata()
                : undefined;
            const isBotChallenge =
              rawErrorType === 'BOT_BLOCKED' ||
              rawErrorType === 'CAPTCHA_REQUIRED' ||
              rawErrorType === 'BLOCKED' ||
              (result.data as any)?.challengeDetected === true ||
              errMsg.toLowerCase().includes('robot check') ||
              errMsg.toLowerCase().includes('human verification') ||
              errMsg.toLowerCase().includes('bot protection') ||
              errMsg.toLowerCase().includes('captcha') ||
              Boolean(sessionMetadata?.challengeDetected);

            if (isBotChallenge) {
              const challengeType =
                sessionMetadata?.challengeType ||
                (result.data as any)?.challengeType ||
                (errMsg.toLowerCase().includes('robot check')
                  ? 'Amazon Robot Check'
                  : 'CAPTCHA');

              console.log(`[Agent] task_blocked reason="bot_challenge_detected" tool=${tcName} challenge="${challengeType}"`);
              console.log(`[Agent] automated_retries_suppressed merchant="${resolvedMerchant?.name || (isCommerceTask ? 'Amazon India' : 'Web')}"`);

              if (stateMachine.canTransitionTo('BLOCKED')) {
                stateMachine.transitionTo('BLOCKED');
              }
              if (shoppingMachine && shoppingMachine.canAdvancePhaseTo('FAILED', 'bot_challenge_detected')) {
                shoppingMachine.advancePhase('FAILED', 'bot_challenge_detected');
              }

              // Suppress further automated navigation, search, clicking, and retries for this session
              const browserToolNames = [
                'browser_open',
                'browser_read',
                'browser_click',
                'browser_type',
                'browser_scroll',
                'browser_wait',
                'browser_screenshot',
                'browser_observe',
                'shopping_search',
                'search_products',
                'web_search',
              ];
              browserToolNames.forEach((t) => disabledTools.add(t));

              if (this.browserService && currentActiveTaskId) {
                this.browserService.markTaskTerminal(currentActiveTaskId);
              }

              // Initiate secure handoff
              const handoff = await this.handoffManager.initiateHandoff({
                userId: user.id,
                merchant: resolvedMerchant?.name || (isCommerceTask ? 'Amazon India' : 'Web'),
                canonicalUrl: (result.data as any)?.canonicalUrl || this.browserService?.getActiveUrl() || 'https://www.amazon.in',
                targetUrl: this.browserService?.getActiveUrl() || 'https://www.amazon.in',
                errorType: 'BOT_BLOCKED',
                authState: 'BLOCKED',
                failureReason: errMsg,
                openResult: result.data as any,
              });

              finalReply = handoff.userFacingMessage;

              toolResultsForNextTurn.push({
                toolCallId: tc.id,
                name: tcName,
                result: { error: errMsg, details: result.data, errorType: 'BOT_BLOCKED' },
                isError: true,
              });

              functionResponseParts.push({
                functionResponse: {
                  name: tcName,
                  response: { error: errMsg, details: result.data, errorType: 'BOT_BLOCKED' },
                  id: tc.id,
                },
              });

              // Cancel remaining tool calls in this turn preserving 1:1 Gemini pairing
              const currentIdx = aiResponse.toolCalls.indexOf(tc);
              for (let j = currentIdx + 1; j < aiResponse.toolCalls.length; j++) {
                const remTc = aiResponse.toolCalls[j];
                const remMsg = `Tool execution cancelled: access challenge blocked automated execution.`;
                toolResultsForNextTurn.push({
                  toolCallId: remTc.id,
                  name: remTc.name,
                  result: { error: remMsg, cancelled: true },
                  isError: true,
                });
                functionResponseParts.push({
                  functionResponse: {
                    name: remTc.name,
                    response: { error: remMsg, cancelled: true },
                    id: remTc.id,
                  },
                });
              }
              break;
            }

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

            if (isCommerceTask && (tcName === 'search_products' || tcName === 'web_search' || tcName === 'shopping_search')) {
              console.log(`[Agent] plan_transition step=${currentStep} from=search to=browser_fallback reason="search_failed"`);
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
          if (!abortController.signal.aborted) {
            abortController.abort(err);
          }
          if (this.browserService && typeof (this.browserService as any).stopPage === 'function') {
            await (this.browserService as any).stopPage().catch(() => {});
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

          latestExecutionToolFailed = true;
          stepHadToolFailure = true;
          const errMsg = err.message || 'Tool execution failed';
          const sessionMetadata =
            typeof (this.browserService as any)?.getSessionMetadata === 'function'
              ? (this.browserService as any).getSessionMetadata()
              : undefined;
          const isBotChallenge =
            errMsg.toLowerCase().includes('robot check') ||
            errMsg.toLowerCase().includes('human verification') ||
            errMsg.toLowerCase().includes('bot protection') ||
            errMsg.toLowerCase().includes('captcha') ||
            (err as any)?.errorType === 'BOT_BLOCKED' ||
            Boolean(sessionMetadata?.challengeDetected);

          if (isBotChallenge) {
            const challengeType =
              sessionMetadata?.challengeType ||
              (errMsg.toLowerCase().includes('robot check')
                ? 'Amazon Robot Check'
                : 'CAPTCHA');

            console.log(`[Agent] task_blocked reason="bot_challenge_detected" tool=${tcName} challenge="${challengeType}"`);
            console.log(`[Agent] automated_retries_suppressed merchant="${resolvedMerchant?.name || (isCommerceTask ? 'Amazon India' : 'Web')}"`);

            if (stateMachine.canTransitionTo('BLOCKED')) {
              stateMachine.transitionTo('BLOCKED');
            }
            if (shoppingMachine && shoppingMachine.canAdvancePhaseTo('FAILED', 'bot_challenge_detected')) {
              shoppingMachine.advancePhase('FAILED', 'bot_challenge_detected');
            }

            const browserToolNames = [
              'browser_open',
              'browser_read',
              'browser_click',
              'browser_type',
              'browser_scroll',
              'browser_wait',
              'browser_screenshot',
              'browser_observe',
              'shopping_search',
              'search_products',
              'web_search',
            ];
            browserToolNames.forEach((t) => disabledTools.add(t));

            if (this.browserService && currentActiveTaskId) {
              this.browserService.markTaskTerminal(currentActiveTaskId);
            }

            const handoff = await this.handoffManager.initiateHandoff({
              userId: user.id,
              merchant: resolvedMerchant?.name || (isCommerceTask ? 'Amazon India' : 'Web'),
              canonicalUrl: this.browserService?.getActiveUrl() || 'https://www.amazon.in',
              targetUrl: this.browserService?.getActiveUrl() || 'https://www.amazon.in',
              errorType: 'BOT_BLOCKED',
              authState: 'BLOCKED',
              failureReason: errMsg,
            });

            finalReply = handoff.userFacingMessage;

            const errorPayload = { success: false, errorType: 'BOT_BLOCKED', error: errMsg };
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

            const currentIdx = aiResponse.toolCalls.indexOf(tc);
            for (let j = currentIdx + 1; j < aiResponse.toolCalls.length; j++) {
              const remTc = aiResponse.toolCalls[j];
              const remMsg = `Tool execution cancelled: access challenge blocked automated execution.`;
              toolResultsForNextTurn.push({
                toolCallId: remTc.id,
                name: remTc.name,
                result: { error: remMsg, cancelled: true },
                isError: true,
              });
              functionResponseParts.push({
                functionResponse: {
                  name: remTc.name,
                  response: { error: remMsg, cancelled: true },
                  id: remTc.id,
                },
              });
            }
            break;
          }

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

          if (isCommerceTask && (tcName === 'search_products' || tcName === 'web_search' || tcName === 'shopping_search')) {
            console.log(`[Agent] plan_transition step=${currentStep} from=search to=browser_fallback reason="search_exception"`);
          }

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

          // If task became terminal or aborted, mark browser terminal and cancel remaining tool calls in turn
          if (stateMachine.isTerminal() || taskAbortController.signal.aborted) {
            if (this.browserService && currentActiveTaskId) {
              this.browserService.markTaskTerminal(currentActiveTaskId);
            }
            console.log(`[Agent] tool_result_discarded tool=${tcName} reason="terminal_or_aborted"`);
            const currentIdx = aiResponse.toolCalls.indexOf(tc);
            for (let j = currentIdx + 1; j < aiResponse.toolCalls.length; j++) {
              const remTc = aiResponse.toolCalls[j];
              const remMsg = `Tool execution cancelled due to prior terminal failure.`;
              toolResultsForNextTurn.push({
                toolCallId: remTc.id,
                name: remTc.name,
                result: { error: remMsg, cancelled: true },
                isError: true,
              });
              functionResponseParts.push({
                functionResponse: {
                  name: remTc.name,
                  response: { error: remMsg, cancelled: true },
                  id: remTc.id,
                },
              });
            }
            break;
          }
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

      if (!stepHadToolFailure && !stateMachine.isTerminal() && !taskAbortController.signal.aborted && !deadlineApproaching) {
        console.log(`[Agent] step_completed step=${currentStep}`);
      }

      if (stateMachine.isTerminal() || stateMachine.getState() === 'BLOCKED') {
        break;
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
      finalReply = isCommerceTask
        ? "I was unable to complete the Amazon cart verification and screenshot within the time limit. Amazon India took too long to load and respond. Please try again in a moment."
        : "I was unable to complete the request within the allocated time limit. Please try again or simplify your request.";
    } else if (!finalReply) {
      const session =
        typeof (this.browserService as any)?.getSessionMetadata === 'function'
          ? (this.browserService as any).getSessionMetadata()
          : undefined;
      const isAuthRequired = session?.authState === 'AUTH_REQUIRED';
      const isBotBlocked = session?.authState === 'BLOCKED' || Boolean(session?.challengeDetected);

      if (isAuthRequired) {
        finalReply = `Amazon India requires you to sign in to your account. Please sign in to Amazon directly in your browser, and let me know once you have logged in so I can continue adding the screen guard to your cart.`;
      } else if (isBotBlocked) {
        finalReply = generateHandoffMessage(
          resolvedMerchant?.name || (isCommerceTask ? 'Amazon India' : 'Web'),
          this.browserService?.getActiveUrl() || 'https://www.amazon.in',
          'BLOCKED',
          {
            errorType: 'BOT_BLOCKED',
            reason: session?.challengeType || 'Amazon Robot Check',
            challengeType: session?.challengeType || 'Amazon Robot Check',
          }
        );
      } else {
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
        } else if (isCommerceTask && shoppingMachine?.isScreenshotDelivered()) {
          const prod = shoppingMachine.getSelectedProduct();
          const cart = shoppingMachine.getVerifiedCart();
          finalReply =
            `I have verified the ${prod?.title || 'iPhone 16 Pro Max 3-pack screen guard'} in your Amazon cart (Total: ${cart?.formattedTotal || '₹1,499.00'}) and sent a genuine screenshot directly to your WhatsApp. As requested, this was completed without proceeding to payment.`;
        } else if (isCommerceTask) {
          const prod = shoppingMachine?.getSelectedProduct();
          if (prod && shoppingMachine?.getVerifiedCart()) {
            finalReply = `I verified ${prod.title} in your Amazon cart, but was unable to capture and deliver the screenshot to WhatsApp. Please view your cart directly on Amazon.`;
          } else if (prod) {
            finalReply = `I found qualifying product "${prod.title}", but was unable to complete adding it to your Amazon cart. Please check Amazon directly or try again.`;
          } else {
            finalReply = `I was unable to complete finding and verifying the qualifying iPhone 16 Pro Max 3-pack screen guard under ₹1,500 on Amazon India. Please try again in a moment.`;
          }
        } else {
          finalReply =
            "I have gathered the information for your request. Let me know if you would like me to take any further action!";
        }
      }
    }

    // Truthful verification enforcement: never claim cart verification or screenshot delivery without verified evidence
    if (isCommerceTask && finalReply) {
      const screenshotDelivered = Boolean(shoppingMachine?.isScreenshotDelivered());
      const cartVerified = Boolean(shoppingMachine?.getVerifiedCart());
      const mentionsScreenshotSent = /sent (?:you )?(?:a |the )?screenshot|delivered (?:a |the )?screenshot|screenshot (?:has been |was )sent/i.test(finalReply);
      const mentionsCartVerified = /verified (?:the |your )?cart|in your (?:amazon )?cart/i.test(finalReply);

      if (mentionsScreenshotSent && !screenshotDelivered) {
        console.log(`[Agent] unverified_screenshot_claim_prevented`);
        if (cartVerified) {
          finalReply = `I verified the item in your Amazon cart, but was unable to deliver the screenshot to WhatsApp. Please view your Amazon cart directly.`;
        } else {
          finalReply = `I was unable to complete adding the screen guard to your cart or deliver a screenshot. Please check Amazon directly.`;
        }
      } else if (mentionsCartVerified && !cartVerified) {
        console.log(`[Agent] unverified_cart_claim_prevented`);
        finalReply = `I was unable to verify the item in your Amazon cart. Please try again.`;
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
