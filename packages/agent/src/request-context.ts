import { MessageIntent, ActiveRequestContext } from '@nexa/shared';

// Cancellation patterns (user explicitly cancels/aborts previous action)
const CANCELLATION_PATTERNS = [
  /^\s*(?:stop|cancel|abort|halt|terminate|quit)(?:!|\.|\?)?\s*$/i,
  /\b(?:actually,?\s*)?(?:forget that|forget it|nevermind|never mind|cancel that|cancel previous|cancel order|cancel the order|stop that|stop order|stop it|abort|cancel this|stop this)\b/i,
  /\bactually,?\s*(?:forget|nevermind|cancel|stop|ignore)\b/i,
];

// Pause patterns (user explicitly pauses active flow)
const PAUSE_PATTERNS = [
  /^\s*(?:wait|pause|hold on|hang on|hold up)(?:!|\.|\?)?\s*$/i,
  /\b(?:wait a minute|wait a sec|give me a second|hold on a second|wait please|pause please|hold please)\b/i,
];

// Continuation patterns (user explicitly continues previous task)
const CONTINUATION_PATTERNS = [
  /^\s*(?:continue|resume|go ahead|continue the order|finish that|continue with the previous task|proceed|yes continue|keep going|do it)\b/i,
  /\b(?:continue with|resume with|go ahead and (?:order|buy|finish|proceed))\b/i,
];

// Conversational / Greeting / Capability patterns
const CONVERSATION_PATTERNS = [
  /^\s*(?:hi|hello|hey|yo|greetings|good (?:morning|afternoon|evening|day))\b/i,
  /\b(?:how are you|how's it going|how are things|how do you do|what's up|sup)\b/i,
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

// Browser automation patterns
const BROWSER_PATTERNS = [
  /\b(?:open page|open url|open website|go to https?:\/\/|navigate to|scrape website|extract from website)\b/i,
  /^https?:\/\//i,
];

// YouTube Intelligence patterns
const YOUTUBE_PATTERNS = [
  /\b(?:youtube|yt video|watch video|video review|video comparison|watch on youtube|youtube video|youtube review|video tutorial|unboxing video)\b/i,
  /\b(?:on youtube|from youtube|youtube link|youtube\.com|youtu\.be)\b/i,
  /\b(?:search youtube|find videos?|watch on yt|look on youtube|videos? comparing|video explaining|videos? testing|video demonstrating)\b/i,
];

// Multimodal patterns
const MULTIMODAL_PATTERNS = [
  /\b(?:analyze this (?:photo|image|picture|video|audio|document|pdf)|what is in this (?:photo|image|picture)|transcribe (?:this|the) (?:audio|voice)|read this (?:pdf|document|file)|summarize this (?:pdf|document)|extract text from (?:image|photo|pdf|document))\b/i,
  /\b(?:describe this (?:image|photo|picture)|ocr|look at this (?:image|photo))\b/i,
];

// Reminder patterns
const REMINDER_PATTERNS = [
  /\b(?:remind me to|set a reminder|create a reminder|reminder for|remind me)\b/i,
];

export function isCancellationMessage(text: string): boolean {
  if (!text) return false;
  return CANCELLATION_PATTERNS.some((p) => p.test(text.trim()));
}

export function isPauseMessage(text: string): boolean {
  if (!text) return false;
  return PAUSE_PATTERNS.some((p) => p.test(text.trim()));
}

export function isContinuationMessage(text: string): boolean {
  if (!text) return false;
  return CONTINUATION_PATTERNS.some((p) => p.test(text));
}

export function classifyMessageIntent(
  text: string,
  options?: { isContinuation?: boolean; isCancellation?: boolean; isPause?: boolean }
): MessageIntent {
  const clean = (text || '').trim();
  if (!clean) return 'CONVERSATION';

  // 0. Control commands
  if (options?.isCancellation || isCancellationMessage(clean)) {
    let withoutCancellation = clean;
    for (const p of CANCELLATION_PATTERNS) {
      withoutCancellation = withoutCancellation.replace(p, '');
    }
    withoutCancellation = withoutCancellation.replace(/^[.,!?\s]+/, '').replace(/[.,!?\s]+$/, '').trim();

    if (!withoutCancellation) {
      if (/^\s*stop/i.test(clean)) return 'CONTROL_STOP';
      return 'CONTROL_CANCEL';
    }
    if (CONVERSATION_PATTERNS.some((p) => p.test(withoutCancellation))) {
      return 'CONVERSATION';
    }
    return classifyMessageIntent(withoutCancellation);
  }

  if (options?.isPause || isPauseMessage(clean)) {
    return 'CONTROL_WAIT';
  }

  if (options?.isContinuation) {
    return 'CONTROL_RESUME';
  }

  // 1. Conversational intent (greetings, capabilities, chit-chat)
  if (CONVERSATION_PATTERNS.some((p) => p.test(clean))) {
    // Unless explicitly a shopping command
    if (!SHOPPING_PATTERNS.some((p) => p.test(clean)) && !TRAVEL_PATTERNS.some((p) => p.test(clean))) {
      return 'CONVERSATION';
    }
  }

  // 1b. YouTube Research intent
  if (YOUTUBE_PATTERNS.some((p) => p.test(clean))) {
    return 'YOUTUBE_RESEARCH';
  }

  // 1c. Multimodal Understanding intent
  if (MULTIMODAL_PATTERNS.some((p) => p.test(clean))) {
    return 'MULTIMODAL_ANALYSIS';
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

  // 6. Reminder intent
  if (REMINDER_PATTERNS.some((p) => p.test(clean))) {
    return 'REMINDER';
  }

  // 7. Calendar intent
  if (CALENDAR_PATTERNS.some((p) => p.test(clean))) {
    return 'CALENDAR';
  }

  // 8. Browser automation intent
  if (BROWSER_PATTERNS.some((p) => p.test(clean))) {
    return 'BROWSER_AUTOMATION';
  }

  // 9. Research intent
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
  const isPause = isPauseMessage(text);
  const isContinue = !isCancel && !isPause && hasPreviousUnfinishedTask && isContinuationMessage(text);

  let taskId = `task_${conversationId}_${Date.now()}`;
  if (isContinue) {
    taskId = `task_${conversationId}_resumed`;
  }

  const intent = classifyMessageIntent(text, { isContinuation: isContinue, isCancellation: isCancel, isPause });

  return {
    requestId,
    taskId,
    intent,
    userMessage: text,
    isContinuation: isContinue,
    timestamp: Date.now(),
  };
}
