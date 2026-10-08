import { MessageIntent, ActiveRequestContext } from '@nexa/shared';

// Cancellation patterns (user explicitly cancels/aborts previous action)
const CANCELLATION_PATTERNS = [
  /\b(?:actually,?\s*)?(?:forget that|forget it|nevermind|never mind|cancel that|cancel previous|cancel order|cancel the order|stop that|stop order|abort)\b/i,
  /\bactually,?\s*(?:forget|nevermind|cancel|stop|ignore)\b/i,
];

// Continuation patterns (user explicitly continues previous task)
const CONTINUATION_PATTERNS = [
  /^\s*(?:continue|go ahead|continue the order|finish that|continue with the previous task|proceed|yes continue|keep going|do it)\b/i,
  /\b(?:continue with|go ahead and (?:order|buy|finish|proceed))\b/i,
];

// Conversational / Greeting / Capability patterns
const CONVERSATION_PATTERNS = [
  /^\s*(?:hi|hello|hey|yo|greetings|good (?:morning|afternoon|evening))\b/i,
  /\b(?:what can you do|who are you|who built you|who created you|who made you|help|capabilities|how does this work)\b/i,
  /\b(?:thank you|thanks|bye|goodbye|see you|ok|okay|cool|nice)\b/i,
];

// Weather / Research patterns
const RESEARCH_PATTERNS = [
  /\b(?:weather|forecast|temperature|who is|what is|when was|how to|search|google|find info|research|browse|web search|look up)\b/i,
];

// Shopping patterns
const SHOPPING_PATTERNS = [
  /\b(?:order|buy|cart|checkout|purchase|instamart|blinkit|zepto|amazon|swiggy|flipkart)\b/i,
];

// Travel patterns
const TRAVEL_PATTERNS = [
  /\b(?:flight|flights|hotel|hotels|airline|ticket|travel|book flight|book hotel)\b/i,
];

// Email patterns
const EMAIL_PATTERNS = [
  /\b(?:email|emails|gmail|send email|compose email|inbox)\b/i,
];

// Calendar patterns
const CALENDAR_PATTERNS = [
  /\b(?:calendar|schedule|meeting|reminder|remind me|event|appointment)\b/i,
];

// Wallet patterns
const WALLET_PATTERNS = [
  /\b(?:wallet|balance|pay\b|transfer\b|send money|top ?up|recharge|payment)\b/i,
];

export function isCancellationMessage(text: string): boolean {
  if (!text) return false;
  return CANCELLATION_PATTERNS.some((p) => p.test(text));
}

export function isContinuationMessage(text: string): boolean {
  if (!text) return false;
  return CONTINUATION_PATTERNS.some((p) => p.test(text));
}

export function classifyMessageIntent(
  text: string,
  options?: { isContinuation?: boolean; isCancellation?: boolean }
): MessageIntent {
  const clean = (text || '').trim();
  if (!clean) return 'CONVERSATION';

  if (options?.isContinuation) {
    return 'SHOPPING';
  }

  // If cancellation, check remainder
  if (options?.isCancellation || isCancellationMessage(clean)) {
    let withoutCancellation = clean;
    for (const p of CANCELLATION_PATTERNS) {
      withoutCancellation = withoutCancellation.replace(p, '');
    }
    withoutCancellation = withoutCancellation.replace(/^[.,!?\s]+/, '').replace(/[.,!?\s]+$/, '').trim();

    if (!withoutCancellation || CONVERSATION_PATTERNS.some((p) => p.test(withoutCancellation))) {
      return 'CONVERSATION';
    }
    return classifyMessageIntent(withoutCancellation);
  }

  // 1. Conversational intent (greetings, capabilities, chit-chat)
  if (CONVERSATION_PATTERNS.some((p) => p.test(clean))) {
    // Unless explicitly a shopping command
    if (!SHOPPING_PATTERNS.some((p) => p.test(clean)) && !TRAVEL_PATTERNS.some((p) => p.test(clean))) {
      return 'CONVERSATION';
    }
  }

  // 2. Shopping intent
  if (SHOPPING_PATTERNS.some((p) => p.test(clean))) {
    return 'SHOPPING';
  }

  // 3. Travel intent
  if (TRAVEL_PATTERNS.some((p) => p.test(clean))) {
    return 'TRAVEL';
  }

  // 4. Wallet intent
  if (WALLET_PATTERNS.some((p) => p.test(clean))) {
    return 'WALLET';
  }

  // 5. Email intent
  if (EMAIL_PATTERNS.some((p) => p.test(clean))) {
    return 'EMAIL';
  }

  // 6. Calendar intent
  if (CALENDAR_PATTERNS.some((p) => p.test(clean))) {
    return 'CALENDAR';
  }

  // 7. Research intent
  if (RESEARCH_PATTERNS.some((p) => p.test(clean))) {
    return 'RESEARCH';
  }

  // If starts with greeting, default to CONVERSATION
  if (/^\s*(?:hi|hello|hey)\b/i.test(clean)) {
    return 'CONVERSATION';
  }

  return 'OTHER';
}

/**
 * Creates an isolated request context for an incoming WhatsApp turn.
 */
export function createRequestContext(
  text: string,
  conversationId: string,
  hasPreviousUnfinishedTask: boolean
): ActiveRequestContext {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const isCancel = isCancellationMessage(text);
  const isContinue = !isCancel && hasPreviousUnfinishedTask && isContinuationMessage(text);

  let taskId = `task_${conversationId}_${Date.now()}`;
  if (isContinue) {
    taskId = `task_${conversationId}_resumed`;
  }

  const intent = classifyMessageIntent(text, { isContinuation: isContinue, isCancellation: isCancel });

  return {
    requestId,
    taskId,
    intent,
    userMessage: text,
    isContinuation: isContinue,
    timestamp: Date.now(),
  };
}
