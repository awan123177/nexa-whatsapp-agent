import { User, Message, NameSource, TitleSource } from '@nexa/shared';
import { IDatabaseRepository, MemoryService } from '@nexa/database';

export interface IdentityCheckResult {
  handled: boolean;
  replyText?: string;
  user: User;
}

const COMMON_STOP_WORDS = new Set([
  'hello', 'hi', 'hey', 'nexa', 'bot', 'assistant', 'ai', 'yes', 'no', 'nope',
  'ok', 'okay', 'sure', 'fine', 'good', 'morning', 'evening', 'afternoon',
  'help', 'test', 'cancel', 'stop', 'abort', 'why', 'what', 'how', 'who',
  'where', 'when', 'skip', 'nevermind', 'thanks', 'thank', 'you', 'please',
  'book', 'booking', 'flight', 'hotel', 'weather', 'search', 'find', 'check',
  'send', 'money', 'pay', 'payment', 'transfer', 'balance', 'wallet', 'screenshot',
  'open', 'website', 'url', 'browser', 'google', 'today', 'tomorrow', 'none',
  'nothing', 'idk', 'dont', 'know', 'tell', 'me', 'joke', 'news', 'can',
  'out', 'make', 'do', 'not', 'buy', 'order', 'add', 'cart', 'view', 'sign', 'in', 'login',
  'get', 'take', 'put', 'go', 'see', 'item', 'product', 'price', 'guard', 'screen',
  'phone', 'amazon', 'flipkart', 'blinkit', 'zepto', 'swiggy', 'instamart', 'best',
]);

const RECOGNIZED_TITLES = new Set([
  'boss', 'captain', 'chief', 'commander', 'sir', 'maam', "ma'am",
  'doc', 'doctor', 'king', 'queen', 'president', 'bhai', 'bro',
  'master', 'sensei', 'leader', 'lord',
]);

export class IdentityManager {
  /**
   * Capitalizes each word in a name properly (e.g. "rahul sharma" -> "Rahul Sharma", "mary-jane" -> "Mary-Jane").
   */
  static formatName(raw: string): string {
    return raw
      .trim()
      .split(/\s+/)
      .map((part) => {
        return part
          .split('-')
          .map((subPart) => {
            return subPart
              .split("'")
              .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1).toLowerCase())
              .join("'");
          })
          .join('-');
      })
      .join(' ');
  }

  /**
   * Capitalizes and normalizes titles (e.g. "boss" -> "Boss", "captain" -> "Captain", "doc" -> "Doctor").
   */
  static formatTitle(raw: string): string {
    const clean = raw.trim().toLowerCase();
    if (clean === 'dr' || clean === 'doctor' || clean === 'doc') return 'Doctor';
    if (clean === "ma'am" || clean === 'maam') return "Ma'am";
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }

  /**
   * Detects title declarations, replacements, or revocations (e.g. "Call me boss", "Don't call me boss", "Call me captain").
   */
  static detectTitle(text: string): {
    hasTitle: boolean;
    title?: string;
    isRevocation?: boolean;
    removedTitle?: string;
    newTitle?: string;
  } {
    const lower = text.toLowerCase().trim();

    // 1. Replacement: "Don't call me boss, call me captain" or "Don't call me boss. Call me captain"
    const matchReplace = lower.match(/(?:don['’]?t\s+call\s+me|stop\s+calling\s+me)\s+([a-zA-Z]+)[,.\s]+(?:call\s+me|you\s+can\s+call\s+me)\s+([a-zA-Z]+)/i);
    if (matchReplace) {
      const removed = matchReplace[1]?.trim().toLowerCase();
      const added = matchReplace[2]?.trim().toLowerCase();
      if (RECOGNIZED_TITLES.has(removed) || RECOGNIZED_TITLES.has(added)) {
        return {
          hasTitle: true,
          isRevocation: false,
          removedTitle: this.formatTitle(removed),
          newTitle: this.formatTitle(added),
          title: this.formatTitle(added),
        };
      }
    }

    // 2. Revocation: "Don't call me boss anymore", "Don't call me boss", "Stop calling me boss"
    const matchRevoke = lower.match(/(?:don['’]?t\s+call\s+me|stop\s+calling\s+me)\s+([a-zA-Z]+)(?:\s+anymore)?/i);
    if (matchRevoke && matchRevoke[1]) {
      const target = matchRevoke[1].trim().toLowerCase();
      if (RECOGNIZED_TITLES.has(target) || target === 'boss') {
        return {
          hasTitle: true,
          isRevocation: true,
          removedTitle: this.formatTitle(target),
        };
      }
    }

    // 3. Declaration: "Call me boss", "You can call me boss", "From now call me boss", "From now on call me boss", "Call me captain"
    const matchDecl = lower.match(/(?:(?:from\s+now\s+(?:on\s+)?)?(?:you\s+can\s+)?call\s+me)\s+([a-zA-Z]+)(?:\s+(?:from\s+now\s+on|please))?/i);
    if (matchDecl && matchDecl[1]) {
      const candidate = matchDecl[1].trim().toLowerCase();
      if (RECOGNIZED_TITLES.has(candidate)) {
        return {
          hasTitle: true,
          isRevocation: false,
          title: this.formatTitle(candidate),
        };
      }
    }

    return { hasTitle: false };
  }

  /**
   * Detects if the user is asking not to be called a name, e.g. "Don't call me Awan".
   */
  static detectCorrection(text: string): { isCorrection: boolean; removedName?: string; newName?: string } {
    const clean = text.trim();
    if (clean.length > 80 || clean.includes('\n')) return { isCorrection: false };
    const lower = clean.toLowerCase();

    // Pattern: "Don't call me X, call me Y" or "Don't call me X, I'm Y"
    const matchBoth = lower.match(
      /^(?:no[,\s]+)?(?:don['’]?t\s+call\s+me|not)\s+([a-zA-Z]+)[,\s]+(?:call\s+me|i['’]?m|my\s+name\s+is)\s+([a-zA-Z\s]+)[.!?]*$/i
    );
    if (matchBoth) {
      const removedName = matchBoth[1]?.trim();
      const newName = this.formatName(matchBoth[2]?.trim().replace(/[.!?]+$/, ''));
      return { isCorrection: true, removedName, newName };
    }

    // Pattern: "Don't call me X"
    const matchRemove = lower.match(/^(?:no[,\s]+)?don['’]?t\s+call\s+me\s+([a-zA-Z\s]+)[.!?]*$/i);
    if (matchRemove) {
      const removedName = matchRemove[1]?.trim().replace(/[.!?]+$/, '');
      return { isCorrection: true, removedName };
    }

    // Pattern: "Actually my name is Y" or "Actually, call me Y"
    const matchActually = lower.match(
      /^actually[,\s]+(?:my\s+name\s+is|call\s+me|i['’]?m)\s+([a-zA-Z\s]+)[.!?]*$/i
    );
    if (matchActually) {
      const newName = this.formatName(matchActually[1]?.trim().replace(/[.!?]+$/, ''));
      return { isCorrection: true, newName };
    }

    return { isCorrection: false };
  }

  /**
   * Detects if user input presents ambiguous names, e.g. "Rahul or Alex" / "Call me Rahul or Alex".
   */
  static detectAmbiguity(
    text: string,
    isAwaitingNameResponse = false
  ): { isAmbiguous: boolean; options?: string[] } {
    const clean = text.trim();
    if (clean.length > 50 || clean.includes('\n') || clean.split(/\s+/).length > 6) {
      return { isAmbiguous: false };
    }
    const lower = clean.toLowerCase();

    // Pattern 1: Explicit introduction phrase, e.g. "Call me Rahul or Alex", "You can call me Rahul or Alex"
    const explicitMatch = lower.match(
      /^(?:(?:you\s+can\s+)?call\s+me\s+|i['’]?m\s+|my\s+name\s+is\s+|name['’]?s\s+)(?:maybe\s+)?([a-zA-Z]+)\s+or\s+(?:maybe\s+)?([a-zA-Z]+)[.!?]*$/i
    );
    if (explicitMatch) {
      const name1 = this.formatName(explicitMatch[1]);
      const name2 = this.formatName(explicitMatch[2]);
      if (!COMMON_STOP_WORDS.has(name1.toLowerCase()) && !COMMON_STOP_WORDS.has(name2.toLowerCase())) {
        return { isAmbiguous: true, options: [name1, name2] };
      }
    }

    // Pattern 2: Short direct choice ONLY if NEXA specifically asked for the name in the preceding turn
    if (isAwaitingNameResponse) {
      const directMatch = lower.match(
        /^(?:maybe\s+)?([a-zA-Z]+)\s+or\s+(?:maybe\s+)?([a-zA-Z]+)[.!?]*$/i
      );
      if (directMatch) {
        const name1 = this.formatName(directMatch[1]);
        const name2 = this.formatName(directMatch[2]);
        if (!COMMON_STOP_WORDS.has(name1.toLowerCase()) && !COMMON_STOP_WORDS.has(name2.toLowerCase())) {
          return { isAmbiguous: true, options: [name1, name2] };
        }
      }
    }

    return { isAmbiguous: false };
  }

  /**
   * Detects questions inquiring about NEXA's creator, builder, founder, or developer.
   */
  static detectCreatorQuestion(text: string): boolean {
    const clean = text
      .toLowerCase()
      .trim()
      .replace(/[?!.,;:]+$/, '');

    const patterns = [
      /\bwho\s+(?:built|created|made|developed|programmed|founded|designed)\s+(?:you|u|nexa)\b/i,
      /\bwho(?:'s|\s+is)\s+(?:your|the)\s+(?:creator|builder|developer|founder|maker|author|owner)\b/i,
      /\bwho(?:'s|\s+is)\s+behind\s+(?:you|u|nexa)\b/i,
      /\bwho\s+owns\s+(?:you|u|nexa)\b/i,
      /\bwho(?:'s|\s+is)\s+nexa(?:'s)?\s+(?:creator|builder|developer|founder|maker)\b/i,
      /\bwho\s+(?:runs|started)\s+nexa\b/i,
      /\bwho\s+(?:is|was)\s+(?:the\s+)?(?:developer|founder|creator|builder)\s+of\s+nexa\b/i,
    ];

    return patterns.some((p) => p.test(clean));
  }

  /**
   * Extracts preferred name from an introduction phrase in conversational speech.
   */
  static extractName(text: string): string | null {
    const clean = text
      .replace(/[\r\n]+/g, ' ')
      .replace(/\b(dr|mr|mrs|ms|prof)\./gi, '$1')
      .trim();
    if (!clean) return null;

    // Remove greetings at the start (e.g. "Hello NEXA,", "Hey,", "Hi!")
    const strippedGreeting = clean.replace(/^(?:hello|hi|hey|good\s+(?:morning|afternoon|evening))\s*(?:nexa)?[,!\s]*/i, '').trim();

    // 1. Check introduction phrases
    const patterns = [
      /^(?:my\s+name\s+is|my\s+name's|name\s+is)\s+([a-zA-Z\s'-]+)/i,
      /^(?:i['’]?m|i\s+am)\s+([a-zA-Z\s'-]+)/i,
      /^(?:call\s+me|you\s+can\s+call\s+me|please\s+call\s+me)\s+([a-zA-Z\s'-]+)/i,
      /^(?:this\s+is)\s+([a-zA-Z\s'-]+)/i,
      /^([a-zA-Z\s'-]+)\s+here$/i,
      /^(?:it['’]?s)\s+([a-zA-Z\s'-]+)/i,
    ];

    for (const pattern of patterns) {
      const match = strippedGreeting.match(pattern);
      if (match && match[1]) {
        const candidate = match[1]
          .split(/[,.!?]|(?:\s+and\b)/)[0] // take up to sentence delimiter or "and"
          .trim();
        if (candidate && this.isValidNameCandidate(candidate)) {
          return this.formatName(candidate);
        }
      }
    }

    // 2. Direct name response (e.g. "Rahul", "Rahul Sharma")
    // If the input consists of 1-3 words and is not a stop word or question
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length >= 1 && words.length <= 3) {
      const directCandidate = clean.replace(/[.!?]+$/, '').trim();
      if (this.isValidNameCandidate(directCandidate)) {
        return this.formatName(directCandidate);
      }
    }

    return null;
  }

  private static isValidNameCandidate(name: string): boolean {
    const clean = name.trim().toLowerCase();
    if (!clean || clean.length < 2 || clean.length > 40) return false;

    // Must be alphabetic characters, spaces, hyphens, or apostrophes
    if (!/^[a-zA-Z\s'-]+$/.test(clean)) return false;

    const parts = clean.split(/\s+/);
    // Reject if any part is a stop word
    if (parts.some((p) => COMMON_STOP_WORDS.has(p))) return false;

    return true;
  }

  /**
   * Evaluates inbound message and updates or queries identity state.
   */
  static async handleInboundMessage(params: {
    user: User;
    text: string;
    conversationHistory: Message[];
    db: IDatabaseRepository;
    whatsappProfileName?: string;
    explicitName?: string;
    explicitConfirmed?: boolean;
    explicitSource?: NameSource;
  }): Promise<IdentityCheckResult> {
    const {
      text,
      conversationHistory,
      db,
      whatsappProfileName,
      explicitName,
      explicitConfirmed,
      explicitSource,
    } = params;

    let user = params.user;
    const trimmedText = text.trim();

    // 1. Initial State Resolution
    let preferredName =
      (user.preferences?.preferred_name as string) ||
      user.preferred_name ||
      null;

    let nameConfirmed = Boolean(
      user.preferences?.name_confirmed ?? user.name_confirmed
    );

    let nameSource =
      (user.preferences?.name_source as NameSource) ||
      user.name_source ||
      (whatsappProfileName ? 'WHATSAPP_PROFILE_UNCONFIRMED' : null);

    // If explicit confirmed name was passed (e.g. from tests or authenticated API)
    if (explicitName && !whatsappProfileName && explicitConfirmed !== false) {
      preferredName = explicitName;
      nameConfirmed = true;
      nameSource = explicitSource || 'USER_CONFIRMED';
      user = await db.updateUser(user.id, {
        name: explicitName,
        preferred_name: explicitName,
        name_confirmed: true,
        name_source: nameSource,
        preferences: {
          ...user.preferences,
          preferred_name: explicitName,
          name_confirmed: true,
          name_source: nameSource,
        },
      });
    }

    // Handle incoming WhatsApp profile display name (Rule 1 & Rule 6)
    if (whatsappProfileName) {
      const currentWaProfile = user.preferences?.whatsapp_profile_name as string;
      if (currentWaProfile !== whatsappProfileName) {
        // WhatsApp display name metadata changed: record it as metadata
        const updatedPrefs: Record<string, unknown> = {
          ...user.preferences,
          whatsapp_profile_name: whatsappProfileName,
        };

        // If not already confirmed by user, mark source as unconfirmed WhatsApp profile
        if (!nameConfirmed) {
          updatedPrefs.name_source = 'WHATSAPP_PROFILE_UNCONFIRMED';
          updatedPrefs.name_confirmed = false;
          nameSource = 'WHATSAPP_PROFILE_UNCONFIRMED';
        }

        user = await db.updateUser(user.id, {
          preferences: updatedPrefs,
          name_source: nameSource,
        });
      }
    }

    // Determine first contact status (<= 1 message in history, i.e., current message)
    const isFirstContact = conversationHistory.length <= 1;

    // Resolve Title State
    let preferredTitle =
      (user.preferences?.preferred_title as string) ||
      user.preferred_title ||
      null;

    let titleConfirmed = Boolean(
      user.preferences?.title_confirmed ?? user.title_confirmed
    );

    let titleSource =
      (user.preferences?.title_source as TitleSource) ||
      user.title_source ||
      null;

    // Production observability logging (Strictly sanitized, no user personal name)
    console.log(`[Identity] first_contact=${isFirstContact}`);
    console.log(`[Identity] preferred_name_present=${Boolean(preferredName)}`);
    console.log(`[Identity] name_confirmed=${nameConfirmed}`);
    if (nameSource) {
      console.log(`[Identity] name_source=${nameSource}`);
    }
    console.log(`[Identity] preferred_title_present=${Boolean(preferredTitle)}`);
    console.log(`[Identity] title_confirmed=${titleConfirmed}`);
    if (titleSource) {
      console.log(`[Identity] title_source=${titleSource}`);
    }

    // Automatically extract and immediately persist explicit durable preferences
    const explicitPrefs = MemoryService.extractExplicitPreferences(trimmedText);
    for (const pref of explicitPrefs) {
      await db.saveMemory({
        user_id: user.id,
        category: pref.category,
        key: pref.key,
        value: pref.value,
        confidence: 1.0,
        source: 'USER_PROVIDED',
        confirmed: true,
        version: 1,
        metadata: {},
      });
      console.log('[Memory] write_success');
    }

    // 2. Check for Title Revocation or Replacement
    const titleCheck = this.detectTitle(trimmedText);
    if (titleCheck.hasTitle) {
      // 2a. Title Revocation (e.g. "Don't call me boss anymore", "Don't call me boss")
      if (titleCheck.isRevocation) {
        user = await db.updateUser(user.id, {
          preferred_title: null,
          title_confirmed: false,
          title_source: null,
          preferences: {
            ...user.preferences,
            preferred_title: null,
            title_confirmed: false,
            title_source: null,
          },
        });

        try {
          const memories = await db.getUserMemories(user.id, 'identity');
          const titleMem = memories.find((m) => m.key === 'preferred_title');
          if (titleMem) {
            await db.deleteMemory(titleMem.id, user.id);
          }
        } catch {}

        return {
          handled: true,
          replyText: `Got it, I won't call you ${titleCheck.removedTitle || 'that'} anymore.`,
          user,
        };
      }

      // 2b. Title Replacement (e.g. "Don't call me boss, call me captain")
      if (titleCheck.removedTitle && titleCheck.newTitle) {
        const newTitle = titleCheck.newTitle;
        user = await db.updateUser(user.id, {
          preferred_title: newTitle,
          title_confirmed: true,
          title_source: 'USER_PROVIDED',
          preferences: {
            ...user.preferences,
            preferred_title: newTitle,
            title_confirmed: true,
            title_source: 'USER_PROVIDED',
          },
        });

        await db.saveMemory({
          user_id: user.id,
          category: 'identity',
          key: 'preferred_title',
          value: newTitle,
          confidence: 1.0,
          source: 'USER_PROVIDED',
          confirmed: true,
          version: 1,
          metadata: {},
        });

        return {
          handled: true,
          replyText: `Understood! I'll call you ${newTitle} from now on.`,
          user,
        };
      }
    }

    // 3. Check for Name Corrections (Rules 4 & 5)
    // E.g. "Don't call me Awan, call me Rahul" or "Don't call me Awan"
    const correction = this.detectCorrection(trimmedText);
    if (correction.isCorrection) {
      if (correction.newName) {
        const newName = correction.newName;
        user = await db.updateUser(user.id, {
          name: newName,
          preferred_name: newName,
          name_confirmed: true,
          name_source: 'USER_PROVIDED',
          preferences: {
            ...user.preferences,
            preferred_name: newName,
            name_confirmed: true,
            name_source: 'USER_PROVIDED',
          },
        });

        await db.saveMemory({
          user_id: user.id,
          category: 'profile',
          key: 'preferred_name',
          value: newName,
          confidence: 1.0,
          metadata: {},
        });

        return {
          handled: true,
          replyText: `Got it! I'll call you ${newName} from now on. 😊 What can I help you with?`,
          user,
        };
      } else {
        // User asked not to be called removedName without specifying new name
        user = await db.updateUser(user.id, {
          name: null,
          preferred_name: null,
          name_confirmed: false,
          name_source: null,
          preferences: {
            ...user.preferences,
            preferred_name: null,
            name_confirmed: false,
            name_source: null,
          },
        });

        // Also clean up any persisted profile memory for preferred_name!
        try {
          const memories = await db.getUserMemories(user.id, 'profile');
          const nameMem = memories.find((m) => m.key === 'preferred_name');
          if (nameMem) {
            await db.deleteMemory(nameMem.id, user.id);
          }
        } catch {
          // Continue if memory cleanup encounters non-fatal error
        }

        return {
          handled: true,
          replyText: "Got it, I won't call you that. What name should I use instead?",
          user,
        };
      }
    }

    const hasAskedName = Boolean(user.preferences?.has_asked_name);

    // Check if previous turn asked for the user's name
    // (e.g. NEXA asked "What’s your name?" or "What's your name?")
    const lastAssistantMsg = [...conversationHistory]
      .reverse()
      .find((m) => m.sender_type === 'assistant');

    const lastAskedForName =
      (lastAssistantMsg &&
        (lastAssistantMsg.content.includes("What’s your name?") ||
          lastAssistantMsg.content.includes("What's your name?") ||
          lastAssistantMsg.content.includes("What should I use instead?") ||
          lastAssistantMsg.content.includes("What should I call you?"))) ||
      hasAskedName;

    // 3. Check for Ambiguous Name Declarations (Rule 11)
    const ambiguity = this.detectAmbiguity(trimmedText, lastAskedForName);
    if (ambiguity.isAmbiguous && ambiguity.options) {
      const [opt1, opt2] = ambiguity.options;
      return {
        handled: true,
        replyText: `Should I call you ${opt1} or ${opt2}?`,
        user,
      };
    }

    // 4. Check for Creator / Builder Questions ("Who built you?", "Who created you?", etc.)
    if (this.detectCreatorQuestion(trimmedText)) {
      return {
        handled: true,
        replyText: "I was built by Awan Warsi — he's the creator behind NEXA.",
        user,
      };
    }

    // 5. Check for Title Declaration or Compound Introduction (e.g. "I'm Awan Warsi. Call me Boss.", "Call me boss")
    if (titleCheck.hasTitle && !titleCheck.isRevocation && titleCheck.title) {
      const assignedTitle = titleCheck.title;
      const textWithoutTitle = trimmedText
        .replace(/(?:(?:from\s+now\s+(?:on\s+)?)?(?:you\s+can\s+)?call\s+me)\s+[a-zA-Z]+/i, '')
        .trim();
      const extractedCompoundName = this.extractName(textWithoutTitle);

      const isCompound =
        Boolean(extractedCompoundName) &&
        (/^(?:hello|hi|hey)?[,\s]*(?:i['’]?m|my\s+name\s+is|this\s+is)\s+/i.test(trimmedText) ||
          lastAskedForName);

      if (isCompound && extractedCompoundName) {
        user = await db.updateUser(user.id, {
          name: extractedCompoundName,
          preferred_name: extractedCompoundName,
          name_confirmed: true,
          name_source: 'USER_PROVIDED',
          preferred_title: assignedTitle,
          title_confirmed: true,
          title_source: 'USER_PROVIDED',
          preferences: {
            ...user.preferences,
            preferred_name: extractedCompoundName,
            name_confirmed: true,
            name_source: 'USER_PROVIDED',
            preferred_title: assignedTitle,
            title_confirmed: true,
            title_source: 'USER_PROVIDED',
            has_asked_name: true,
          },
        });

        await db.saveMemory({
          user_id: user.id,
          category: 'profile',
          key: 'preferred_name',
          value: extractedCompoundName,
          confidence: 1.0,
          source: 'USER_PROVIDED',
          confirmed: true,
          version: 1,
          metadata: {},
        });

        await db.saveMemory({
          user_id: user.id,
          category: 'identity',
          key: 'preferred_title',
          value: assignedTitle,
          confidence: 1.0,
          source: 'USER_PROVIDED',
          confirmed: true,
          version: 1,
          metadata: {},
        });

        return {
          handled: true,
          replyText: `Nice to meet you, ${assignedTitle}! What can I help you with?`,
          user,
        };
      }

      // Standalone Title Declaration ("Call me boss", "you can call me boss", "from now call me boss")
      user = await db.updateUser(user.id, {
        preferred_title: assignedTitle,
        title_confirmed: true,
        title_source: 'USER_PROVIDED',
        preferences: {
          ...user.preferences,
          preferred_title: assignedTitle,
          title_confirmed: true,
          title_source: 'USER_PROVIDED',
        },
      });

      await db.saveMemory({
        user_id: user.id,
        category: 'identity',
        key: 'preferred_title',
        value: assignedTitle,
        confidence: 1.0,
        source: 'USER_PROVIDED',
        confirmed: true,
        version: 1,
        metadata: {},
      });

      if (lastAskedForName) {
        return {
          handled: true,
          replyText: `Nice to meet you, ${assignedTitle}! What can I help you with?`,
          user,
        };
      }

      const isOnlyTitle = /^(?:(?:from\s+now\s+(?:on\s+)?)?(?:you\s+can\s+)?call\s+me)\s+[a-zA-Z]+[.!?]*$/i.test(trimmedText);
      if (isOnlyTitle) {
        return {
          handled: true,
          replyText: `Sure, ${assignedTitle}.`,
          user,
        };
      }
    }

    if (lastAskedForName && !nameConfirmed) {
      const extracted = this.extractName(trimmedText);
      if (extracted) {
        user = await db.updateUser(user.id, {
          name: extracted,
          preferred_name: extracted,
          name_confirmed: true,
          name_source: 'USER_PROVIDED',
          preferences: {
            ...user.preferences,
            preferred_name: extracted,
            name_confirmed: true,
            name_source: 'USER_PROVIDED',
            has_asked_name: true,
          },
        });

        await db.saveMemory({
          user_id: user.id,
          category: 'profile',
          key: 'preferred_name',
          value: extracted,
          confidence: 1.0,
          metadata: {},
        });

        return {
          handled: true,
          replyText: `Nice to meet you, ${extracted}! 😊 What can I help you with?`,
          user,
        };
      }
    }

    // 5. If User Introduces Themselves at any point (Rule 3, 9, 10)
    // E.g. "I'm Rahul", "My name is Rahul", "Call me Awan", "Hello NEXA, I'm Rahul"
    const introName = this.extractName(trimmedText);
    const hasIntroPhrase =
      /^(?:hello|hi|hey)?[,\s]*(?:i['’]?m|my\s+name\s+is|call\s+me|you\s+can\s+call\s+me)\s+/i.test(
        trimmedText
      );

    if (introName && (hasIntroPhrase || lastAskedForName)) {
      user = await db.updateUser(user.id, {
        name: introName,
        preferred_name: introName,
        name_confirmed: true,
        name_source: 'USER_PROVIDED',
        preferences: {
          ...user.preferences,
          preferred_name: introName,
          name_confirmed: true,
          name_source: 'USER_PROVIDED',
          has_asked_name: true,
        },
      });

      await db.saveMemory({
        user_id: user.id,
        category: 'profile',
        key: 'preferred_name',
        value: introName,
        confidence: 1.0,
        metadata: {},
      });

      // If the message was solely an introduction without another command/task, reply warmly and stop turn
      const isOnlyIntro = trimmedText
        .replace(/^(?:hello|hi|hey|good\s+(?:morning|evening|afternoon))?\s*(?:nexa)?[,!\s]*/i, '')
        .replace(/^(?:i['’]?m|my\s+name\s+is|call\s+me|you\s+can\s+call\s+me)\s+[a-zA-Z\s'.-]+/i, '')
        .trim().length === 0;

      if (isOnlyIntro) {
        return {
          handled: true,
          replyText: `Nice to meet you, ${introName}! 😊 What can I help you with?`,
          user,
        };
      }

      // If user introduced themselves alongside a task (e.g. "Hi, I'm Rahul. Book a hotel"),
      // user is now confirmed, and we proceed to normal execution.
      return { handled: false, user };
    }

    // 6. First-Interaction Greeting / Inquiry without Confirmed Name (Rule 2)
    // On first contact, if preferred_name is absent or unconfirmed:
    // Ask for the user's name and STOP the turn ("Do not answer a second unrelated question before getting the name")
    const isFirstContactGreeting =
      /^(?:hello|hi|hey|good\s+(?:morning|afternoon|evening))\s*(?:nexa\b|[!.,\s]*$)/i.test(trimmedText) ||
      /^(?:hello|hi|hey|good\s+(?:morning|afternoon|evening))[!,.\s]+nexa\b/i.test(trimmedText);

    if (!nameConfirmed && !preferredName && (isFirstContact || !hasAskedName) && isFirstContactGreeting) {
      user = await db.updateUser(user.id, {
        preferences: {
          ...user.preferences,
          has_asked_name: true,
        },
      });

      return {
        handled: true,
        replyText: 'Hey! 👋 Nice to meet you. What’s your name?',
        user,
      };
    }

    return { handled: false, user };
  }
}
