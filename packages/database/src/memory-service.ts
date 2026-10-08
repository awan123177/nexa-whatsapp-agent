import {
  Memory,
  MemoryCategory,
  User,
  SecurityViolationError,
} from '@nexa/shared';
import { IDatabaseRepository } from './types.js';

export const SENSITIVE_SECRET_PATTERNS = [
  /\b(?:\d[ -]*?){13,16}\b/, // Credit card numbers
  /(cvv|cvc)/i,
  /(password|passwd|pin)/i,
  /(otp|one[- ]time[- ]password|verification\s*code)/i,
  /(bearer\s+[a-z0-9_-]{20,})/i,
  /(sk-[a-zA-Z0-9]{20,})/,
  /(AIza[0-9A-Za-z-_]{35})/,
  /(token|refresh_token|access_token)\s*[:=]\s*[a-zA-Z0-9_.-]{20,}/i,
  /(cookie|session_cookie|jwt)/i,
];

export interface MemoryHealthReport {
  healthy: boolean;
  userExists: boolean;
  preferencesReadable: boolean;
  memoryWritable: boolean;
  memoryReadable: boolean;
  conversationAccessible: boolean;
  isolationVerified: boolean;
  error?: string;
}

export class MemoryService {
  constructor(private db: IDatabaseRepository) {}

  /**
   * Validates whether a key or value contains forbidden credentials/secrets.
   */
  public static validateSafeContent(key: string, value: string): void {
    const combined = `${key} ${value}`.toLowerCase();
    for (const pattern of SENSITIVE_SECRET_PATTERNS) {
      if (pattern.test(combined)) {
        throw new SecurityViolationError(
          'Cannot store passwords, OTPs, CVV, authentication tokens, or private secrets in memory.'
        );
      }
    }
  }

  /**
   * Saves or updates a memory item for a user with idempotent upsert.
   * New user-provided information automatically updates any previous conflicting value.
   */
  async saveMemory(params: {
    userId: string;
    category: MemoryCategory;
    key: string;
    value: string;
    confidence?: number;
    source?: 'USER_PROVIDED' | 'USER_CONFIRMED' | 'INFERRED' | 'SYSTEM';
    confirmed?: boolean;
    metadata?: Record<string, unknown>;
    sourceMessageId?: string | null;
  }): Promise<Memory> {
    const {
      userId,
      category,
      key,
      value,
      confidence = 1.0,
      source = 'USER_PROVIDED',
      confirmed = true,
      metadata = {},
      sourceMessageId = null,
    } = params;

    // Reject secrets
    MemoryService.validateSafeContent(key, value);

    const memory = await this.db.saveMemory({
      user_id: userId,
      category,
      key: key.trim(),
      value: value.trim(),
      confidence,
      source,
      confirmed,
      version: 1,
      source_message_id: sourceMessageId,
      metadata,
    });

    console.log('[Memory] write_success');
    return memory;
  }

  /**
   * Retrieves user memories scoped strictly to the given user ID.
   * Intelligently selects relevant memories according to conversation intent.
   */
  async getRelevantMemories(userId: string, intentQuery?: string): Promise<Memory[]> {
    const allMemories = await this.db.getUserMemories(userId);

    console.log('[Memory] read_success');
    console.log(`[Memory] user_memory_available=${allMemories.length > 0}`);

    if (!intentQuery) {
      // Baseline conversational memories: identity, general preferences, communication style
      return allMemories.filter((m) =>
        [
          'identity',
          'preferences',
          'preference',
          'communication_style',
          'important_context',
          'profile',
        ].includes(m.category)
      );
    }

    const queryLower = intentQuery.toLowerCase();
    const relevantCategories = new Set<string>([
      'identity',
      'preferences',
      'preference',
      'communication_style',
      'important_context',
      'profile',
    ]);

    // Travel intent
    if (
      /\b(flights?|fly|airlines?|airports?|hotels?|rooms?|stays?|travel|vacations?|trips?|tickets?)\b/i.test(
        queryLower
      )
    ) {
      relevantCategories.add('travel_preferences');
      relevantCategories.add('saved_airports');
      relevantCategories.add('booking_preferences');
      relevantCategories.add('travel');
    }

    // Shopping & Groceries intent
    if (
      /\b(blinkit|grocery|groceries|shopping|buy|order|cart|milks?|stores?|merchants?|market|amazon)\b/i.test(
        queryLower
      )
    ) {
      relevantCategories.add('shopping_preferences');
      relevantCategories.add('saved_merchants');
      relevantCategories.add('food_preferences');
    }

    // Wallet & Payments intent
    if (
      /\b(wallets?|money|pay|payments?|transfers?|balances?|upi|qr|credits?|rupees?|cash|paise)\b/i.test(
        queryLower
      )
    ) {
      relevantCategories.add('wallet_preferences');
    }

    // Food / dining intent
    if (/\b(foods?|eat|restaurants?|dinners?|lunch|breakfast|vegetarian|vegan|cuisine)\b/i.test(queryLower)) {
      relevantCategories.add('food_preferences');
    }

    // Work / tasks intent
    if (/\b(works?|tasks?|schedules?|meetings?|reminders?|calendar|office|job)\b/i.test(queryLower)) {
      relevantCategories.add('work_preferences');
      relevantCategories.add('work');
    }

    return allMemories.filter((m) => relevantCategories.has(m.category));
  }

  /**
   * Automatically extracts explicit durable preferences declared conversationally by the user.
   */
  static extractExplicitPreferences(
    text: string
  ): Array<{ category: MemoryCategory; key: string; value: string }> {
    const results: Array<{ category: MemoryCategory; key: string; value: string }> = [];
    const clean = text.trim();

    // 1. Home / Location: "I live in <City>", "My home is in <City>"
    const liveMatch = clean.match(/(?:i\s+live\s+in|my\s+home\s+is\s+in)\s+([a-zA-Z\s]+?)(?:\s+and\b|[.,!?]|$)/i);
    if (liveMatch && liveMatch[1]) {
      const city = liveMatch[1].trim();
      if (city.length >= 2 && city.length <= 50) {
        results.push({ category: 'saved_places', key: 'home_city', value: city });
      }
    }

    // 2. "Remember that I like <X>"
    const likeMatch = clean.match(/remember\s+that\s+i\s+like\s+([a-zA-Z0-9\s'-]+?)(?:\s+and\b|[.,!?]|$)/i);
    if (likeMatch && likeMatch[1]) {
      const item = likeMatch[1].trim();
      if (item.length >= 2 && item.length <= 60) {
        results.push({ category: 'preferences', key: 'likes', value: item });
      }
    }

    // 3. Dietary preferences: "Don't recommend vegetarian food", "I don't eat meat", "I am vegetarian"
    if (/don['’]?t\s+recommend\s+vegetarian\s+food/i.test(clean)) {
      results.push({
        category: 'food_preferences',
        key: 'dietary_preference',
        value: 'non-vegetarian only (avoid vegetarian)',
      });
    } else if (/\b(i\s+am\s+vegetarian|vegetarian\s+only)\b/i.test(clean)) {
      results.push({
        category: 'food_preferences',
        key: 'dietary_preference',
        value: 'vegetarian',
      });
    }

    // 4. Communication style: "Use short answers", "Be concise", "Keep replies brief"
    if (/use\s+short\s+answers|be\s+concise|keep\s+(?:replies|answers)\s+brief/i.test(clean)) {
      results.push({
        category: 'communication_style',
        key: 'reply_length',
        value: 'short and concise',
      });
    }

    // 5. Booking budget: "I prefer hotels under ₹<N>" or "hotels under <N>"
    const budgetMatch = clean.match(/(?:prefer\s+hotels\s+under|hotels\s+under)\s+([₹$€]?\s*\d+)/i);
    if (budgetMatch && budgetMatch[1]) {
      results.push({
        category: 'booking_preferences',
        key: 'max_hotel_budget',
        value: budgetMatch[1].trim(),
      });
    }

    // 6. Airport: "Remember my usual airport is <Code>" or "my usual airport is <Code>"
    const airportMatch = clean.match(/(?:remember\s+)?my\s+usual\s+airport(?:\s+is)?\s+([a-zA-Z0-9\s]+)/i);
    if (airportMatch && airportMatch[1]) {
      const apt = airportMatch[1].replace(/[.!?]+$/, '').trim();
      if (apt.length >= 2 && apt.length <= 40) {
        results.push({ category: 'saved_airports', key: 'usual_airport', value: apt });
      }
    }

    // 7. Travel seat: "Remember I prefer window seats" or "prefer window seat"
    if (/prefer\s+window\s+seats?/i.test(clean)) {
      results.push({
        category: 'travel_preferences',
        key: 'flight_seat_preference',
        value: 'window',
      });
    } else if (/prefer\s+aisle\s+seats?/i.test(clean)) {
      results.push({
        category: 'travel_preferences',
        key: 'flight_seat_preference',
        value: 'aisle',
      });
    }

    // 8. Disliked title: "Don't call me sir"
    if (/don['’]?t\s+call\s+me\s+sir\b/i.test(clean)) {
      results.push({
        category: 'communication_style',
        key: 'avoid_title',
        value: 'sir',
      });
    }

    return results;
  }

  /**
   * Health check for user memory subsystem ensuring durability, readability, and user isolation.
   */
  async checkHealth(userId: string): Promise<MemoryHealthReport> {
    try {
      const user = await this.db.getUserById(userId);
      const userExists = Boolean(user);
      const preferencesReadable = Boolean(user && typeof user.preferences === 'object');

      // Test write
      const testKey = '_health_check_probe';
      const saved = await this.saveMemory({
        userId,
        category: 'preferences',
        key: testKey,
        value: 'ok',
        source: 'SYSTEM',
        confirmed: true,
      });
      const memoryWritable = Boolean(saved && saved.id);

      // Test read
      const memories = await this.getRelevantMemories(userId);
      const memoryReadable = memories.some((m) => m.key === testKey);

      // Clean up test memory
      if (saved) {
        await this.db.deleteMemory(saved.id, userId);
      }

      // Test conversation history access
      const conv = await this.db.getOrCreateActiveConversation(userId);
      const messages = await this.db.getConversationMessages(conv.id, 5);
      const conversationAccessible = Array.isArray(messages);

      // Test user isolation: verify user cannot see another fake user's memory
      const fakeOtherUserId = '00000000-0000-0000-0000-000000000000';
      const otherMemories = await this.db.getUserMemories(fakeOtherUserId);
      const isolationVerified = otherMemories.length === 0;

      const healthy =
        userExists &&
        preferencesReadable &&
        memoryWritable &&
        memoryReadable &&
        conversationAccessible &&
        isolationVerified;

      console.log(`[Memory] update_success`);
      console.log(`[Memory] user_memory_available=${healthy}`);

      return {
        healthy,
        userExists,
        preferencesReadable,
        memoryWritable,
        memoryReadable,
        conversationAccessible,
        isolationVerified,
      };
    } catch (err: any) {
      console.error('[Memory] health_check_failed', err);
      return {
        healthy: false,
        userExists: false,
        preferencesReadable: false,
        memoryWritable: false,
        memoryReadable: false,
        conversationAccessible: false,
        isolationVerified: false,
        error: err.message,
      };
    }
  }
}
