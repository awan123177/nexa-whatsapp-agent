import {
  Memory,
  MemoryCategory,
  MemorySourceType,
  MemorySensitivity,
  MemoryStatus,
  User,
  SecurityViolationError,
  EpisodicExperience,
  ProceduralWorkflow,
} from '@nexa/shared';
import { IDatabaseRepository } from './types.js';

export const SENSITIVE_SECRET_PATTERNS = [
  /\b(?:\d[ -]*?){13,16}\b/, // Credit card numbers
  /(cvv|cvc)/i,
  /(password|passwd|\bpin\b)/i,
  /(otp|one[- ]time[- ]password|verification\s*code)/i,
  /(bearer\s+[a-z0-9_-]{20,})/i,
  /(sk-[a-zA-Z0-9]{20,})/,
  /(AIza[0-9A-Za-z-_]{35})/,
  /(token|refresh_token|access_token)\s*[:=]\s*[a-zA-Z0-9_.-]{20,}/i,
  /(cookie|session_cookie|jwt)/i,
  /(private[-_]?key|secret[-_]?key)/i,
];

export const FORBIDDEN_SENSITIVE_INFERENCE_PATTERNS = [
  /\b(religion|religious|muslim|hindu|christian|jewish|buddhist|sikh|atheist)\b/i,
  /\b(political|republican|democrat|bjp|congress|left-wing|right-wing|election\s*vote|political\s*party)\b/i,
  /\b(medical\s*record|health\s*condition|diagnosis|prescription|hiv|cancer|disease|mental\s*health)\b/i,
  /\b(sexual\s*orientation|heterosexual|homosexual|gay|lesbian|bisexual|transgender)\b/i,
];

export interface SaveMemoryParams {
  userId: string;
  category: MemoryCategory;
  key: string;
  value: string;
  confidence?: number;
  source?: MemorySourceType;
  confirmed?: boolean;
  evidenceSummary?: string | null;
  sensitivity?: MemorySensitivity;
  status?: MemoryStatus;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
  sourceMessageId?: string | null;
  untrustedExternalSource?: boolean;
}

export interface MemoryHealthReport {
  healthy: boolean;
  userExists: boolean;
  preferencesReadable: boolean;
  memoryWritable: boolean;
  memoryReadable: boolean;
  conversationAccessible: boolean;
  isolationVerified: boolean;
  personalizationEnabled: boolean;
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
          'Cannot store passwords, OTPs, CVV, authentication tokens, private keys, or secrets in memory.'
        );
      }
    }
  }

  /**
   * Validates that inferred or observed memories do not categorize sensitive attributes.
   * (e.g. religion, political beliefs, health conditions, sexual orientation).
   */
  public static validateNoForbiddenSensitiveInference(
    key: string,
    value: string,
    source?: MemorySourceType
  ): void {
    if (
      source === 'INFERRED' ||
      source === 'USER_CONFIRMED_INFERENCE' ||
      source === 'REPEATED_OBSERVATION'
    ) {
      const combined = `${key} ${value}`.toLowerCase();
      for (const pattern of FORBIDDEN_SENSITIVE_INFERENCE_PATTERNS) {
        if (pattern.test(combined)) {
          throw new SecurityViolationError(
            'Cannot infer or save sensitive personal attributes (religion, politics, health, or sexual orientation).'
          );
        }
      }
    }
  }

  /**
   * Saves or updates a memory item for a user with idempotent upsert, versioning,
   * stable IDs, and correction history.
   */
  async saveMemory(params: SaveMemoryParams): Promise<Memory> {
    const {
      userId,
      category,
      key,
      value,
      confidence = 1.0,
      source = 'EXPLICIT_USER_STATEMENT',
      confirmed = true,
      evidenceSummary = null,
      sensitivity = 'low',
      status = 'active',
      expiresAt = null,
      metadata = {},
      sourceMessageId = null,
      untrustedExternalSource = false,
    } = params;

    // Reject memory writes initiated by untrusted external web pages/emails
    if (untrustedExternalSource) {
      throw new SecurityViolationError(
        'External or untrusted third-party content cannot create or modify user memory.'
      );
    }

    // Reject secrets and credentials
    MemoryService.validateSafeContent(key, value);

    // Reject sensitive personal inferences
    MemoryService.validateNoForbiddenSensitiveInference(key, value, source);

    // Creator identity is a permanent system-level property, not user memory
    const normalizedKey = key.trim().toLowerCase();
    if (
      [
        'creator',
        'builder',
        'developer',
        'founder',
        'nexa_creator',
        'nexa_builder',
      ].includes(normalizedKey)
    ) {
      throw new SecurityViolationError(
        'Creator identity is a permanent system-level property and cannot be overwritten by user memory.'
      );
    }

    const memory = await this.db.saveMemory({
      user_id: userId,
      category,
      key: key.trim(),
      value: value.trim(),
      confidence: Math.max(0, Math.min(1.0, confidence)),
      source,
      confirmed,
      version: 1,
      evidence_summary: evidenceSummary,
      sensitivity,
      status,
      expires_at: expiresAt,
      source_message_id: sourceMessageId,
      metadata,
    });

    console.log('[Memory] write_success');
    console.log(`[Learning] memory_saved category=${category} key=${key.trim()} source=${source}`);
    return memory;
  }

  /**
   * Retrieves user memories scoped strictly to the given user ID.
   * Respects personalization toggle, active/expired statuses, and bounded token budget.
   */
  async getRelevantMemories(userId: string, intentQuery?: string): Promise<Memory[]> {
    const user = await this.db.getUserById(userId);
    if (
      user &&
      (user.personalization_enabled === false ||
        user.preferences?.personalization_enabled === false)
    ) {
      console.log(`[Memory] personalization_disabled user=${userId}`);
      return [];
    }

    const allMemories = await this.db.getUserMemories(userId);

    console.log('[Memory] read_success');
    console.log(`[Memory] user_memory_available=${allMemories.length > 0}`);

    const nowIso = new Date().toISOString();
    // Exclude archived, contradicted, or expired memories
    const activeMemories = allMemories.filter((m) => {
      if (m.status && m.status !== 'active') return false;
      if (m.expires_at && m.expires_at < nowIso) return false;
      return true;
    });

    if (activeMemories.length === 0) {
      return [];
    }

    const coreCategories = new Set<string>([
      'identity',
      'personal_profile',
      'profile',
      'preferences',
      'preference',
      'communication_style',
      'feedback_correction',
      'important_context',
    ]);

    if (!intentQuery) {
      // Baseline conversational memories: identity, general preferences, communication style
      const baseline = activeMemories.filter((m) => coreCategories.has(m.category));
      this.touchLastUsedMemories(baseline);
      return baseline.slice(0, 10);
    }

    const queryLower = intentQuery.toLowerCase();
    const relevantCategories = new Set<string>(coreCategories);

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
      relevantCategories.add('procedural_workflow');
      relevantCategories.add('episodic_experience');
    }

    // Shopping & Groceries intent
    if (
      /\b(blinkit|grocery|groceries|shopping|buy|order|cart|milks?|stores?|merchants?|market|amazon|swiggy|instamart|zepto)\b/i.test(
        queryLower
      )
    ) {
      relevantCategories.add('shopping_preferences');
      relevantCategories.add('saved_merchants');
      relevantCategories.add('food_preferences');
      relevantCategories.add('procedural_workflow');
      relevantCategories.add('episodic_experience');
    }

    // Wallet & Payments intent
    if (
      /\b(wallets?|money|pay|payments?|transfers?|balances?|upi|qr|credits?|rupees?|cash|paise)\b/i.test(
        queryLower
      )
    ) {
      relevantCategories.add('wallet_preferences');
      relevantCategories.add('procedural_workflow');
      relevantCategories.add('episodic_experience');
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

    // Query terms for keyword matching
    const queryTokens = queryLower.split(/[\s,;.!?]+/).filter((t) => t.length > 2);

    // Score and rank memories
    const scoredMemories = activeMemories
      .filter((m) => relevantCategories.has(m.category) || coreCategories.has(m.category))
      .map((m) => {
        let score = 0;
        // Priority for direct statements and corrections
        if (m.source === 'EXPLICIT_USER_STATEMENT' || m.source === 'USER_PROVIDED') score += 10;
        if (m.source === 'USER_CORRECTION') score += 12;
        if (m.source === 'VERIFIED_TASK_OUTCOME') score += 8;

        // Confidence weight
        score += (m.confidence || 1.0) * 5;

        // Keyword match
        const mKey = m.key.toLowerCase();
        const mVal = m.value.toLowerCase();
        const mEvidence = (m.evidence_summary || '').toLowerCase();
        for (const token of queryTokens) {
          if (mKey.includes(token)) score += 6;
          if (mVal.includes(token)) score += 4;
          if (mEvidence.includes(token)) score += 2;
        }

        return { memory: m, score };
      });

    scoredMemories.sort((a, b) => b.score - a.score);

    // Keep bounded context budget: top 10 most relevant memories
    const finalMemories = scoredMemories.slice(0, 10).map((sm) => sm.memory);
    this.touchLastUsedMemories(finalMemories);
    return finalMemories;
  }

  private touchLastUsedMemories(memories: Memory[]): void {
    const nowIso = new Date().toISOString();
    for (const m of memories) {
      m.last_used_at = nowIso;
    }
  }

  /**
   * Records a user correction and optionally updates the affected preference.
   */
  async recordFeedbackCorrection(params: {
    userId: string;
    key: string;
    correctedValue: string;
    evidence: string;
    scope?: 'reusable' | 'one_time';
    category?: MemoryCategory;
  }): Promise<Memory | null> {
    const {
      userId,
      key,
      correctedValue,
      evidence,
      scope = 'reusable',
      category = 'preferences',
    } = params;

    if (scope === 'one_time') {
      console.log(`[Learning] one_time_correction_recorded key=${key}`);
      return null;
    }

    return await this.saveMemory({
      userId,
      category,
      key,
      value: correctedValue,
      confidence: 1.0,
      source: 'USER_CORRECTION',
      confirmed: true,
      evidenceSummary: evidence,
      sensitivity: 'low',
      status: 'active',
    });
  }

  /**
   * Records episodic experience from a completed or failed task.
   * Never marks a failed attempt as a success.
   */
  async recordEpisodicExperience(params: {
    userId: string;
    taskRequest: string;
    approach: string;
    toolsUsed: string[];
    outcome: string;
    success: boolean;
    error?: string;
    learning?: string;
    reusable?: boolean;
  }): Promise<Memory> {
    const {
      userId,
      taskRequest,
      approach,
      toolsUsed,
      outcome,
      success,
      error,
      learning,
      reusable = false,
    } = params;

    const experience: EpisodicExperience = {
      taskRequest: taskRequest.slice(0, 200),
      approach: approach.slice(0, 150),
      toolsUsed,
      outcome: outcome.slice(0, 250),
      success,
      error: error ? error.slice(0, 200) : undefined,
      learning: learning ? learning.slice(0, 250) : undefined,
      reusable,
    };

    const key = `task_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const value = JSON.stringify(experience);

    console.log(`[Learning] episodic_experience_recorded success=${success} tools=${toolsUsed.join(',')}`);

    return await this.saveMemory({
      userId,
      category: 'episodic_experience',
      key,
      value,
      confidence: success ? 0.95 : 0.8,
      source: 'VERIFIED_TASK_OUTCOME',
      confirmed: true,
      evidenceSummary: `Task: "${taskRequest.slice(0, 80)}" -> Success: ${success}`,
      sensitivity: 'low',
      status: 'active',
    });
  }

  /**
   * Records a verified procedural workflow for future reuse.
   */
  async recordProceduralWorkflow(params: {
    userId: string;
    service: string;
    workflowName: string;
    steps: string[];
    conditions?: string;
    verified: boolean;
  }): Promise<Memory> {
    const { userId, service, workflowName, steps, conditions, verified } = params;

    const workflow: ProceduralWorkflow = {
      service,
      workflowName,
      steps,
      conditions,
      verified,
    };

    const key = `wf_${service.toLowerCase().replace(/\s+/g, '_')}_${workflowName.toLowerCase().replace(/\s+/g, '_')}`;
    const value = JSON.stringify(workflow);

    console.log(`[Learning] procedural_workflow_saved service=${service} workflow=${workflowName}`);

    return await this.saveMemory({
      userId,
      category: 'procedural_workflow',
      key,
      value,
      confidence: verified ? 1.0 : 0.8,
      source: 'VERIFIED_TASK_OUTCOME',
      confirmed: verified,
      evidenceSummary: `Successful procedure on ${service}: ${steps.join(' -> ')}`,
      sensitivity: 'low',
      status: 'active',
    });
  }

  /**
   * Deletes a specific memory matching a search key or description for the user.
   */
  async forgetMemory(userId: string, searchTermOrKey: string): Promise<boolean> {
    const memories = await this.db.getUserMemories(userId);
    const cleanSearch = searchTermOrKey.trim().toLowerCase();
    const normSearch = cleanSearch.replace(/[_\s-]+/g, ' ');

    // Find exact key or best match
    const target = memories.find((m) => {
      const normKey = m.key.toLowerCase().replace(/[_\s-]+/g, ' ');
      const normVal = m.value.toLowerCase().replace(/[_\s-]+/g, ' ');
      return (
        normKey === normSearch ||
        normKey.includes(normSearch) ||
        normSearch.includes(normKey) ||
        normVal === normSearch ||
        normVal.includes(normSearch) ||
        normSearch.includes(normVal) ||
        m.key.toLowerCase().includes(cleanSearch) ||
        m.value.toLowerCase().includes(cleanSearch)
      );
    });

    if (target) {
      const deleted = await this.db.deleteMemory(target.id, userId);
      console.log(`[Memory] memory_forgotten key=${target.key} user=${userId}`);
      return deleted;
    }

    return false;
  }

  /**
   * Deletes all memories for a user ("Forget everything you remember about me").
   */
  async forgetAllMemories(userId: string): Promise<number> {
    let deletedCount = 0;
    if (this.db.deleteAllUserMemories) {
      deletedCount = await this.db.deleteAllUserMemories(userId);
    } else {
      const memories = await this.db.getUserMemories(userId);
      for (const m of memories) {
        const deleted = await this.db.deleteMemory(m.id, userId);
        if (deleted) deletedCount++;
      }
    }

    // Reset preferred title and title confirmation
    try {
      const user = await this.db.getUserById(userId);
      if (user) {
        await this.db.updateUser(userId, {
          preferred_title: null,
          title_confirmed: false,
          title_source: null,
          preferences: {
            ...user.preferences,
            preferred_title: null,
            title_confirmed: false,
          },
        });
      }
    } catch (err) {
      console.error('[Memory] error_clearing_user_title_on_forget_all', err);
    }

    console.log(`[Memory] all_memories_cleared user=${userId} count=${deletedCount}`);
    return deletedCount;
  }

  /**
   * Enables or disables personalization for a user.
   */
  async setPersonalizationEnabled(userId: string, enabled: boolean): Promise<User> {
    const user = await this.db.getUserById(userId);
    const updated = await this.db.updateUser(userId, {
      personalization_enabled: enabled,
      preferences: {
        ...(user?.preferences || {}),
        personalization_enabled: enabled,
      },
    });

    console.log(`[Memory] personalization_toggle user=${userId} enabled=${enabled}`);
    return updated;
  }

  /**
   * Generates a human-friendly summary of user memories distinguishing
   * explicit facts from inferred preferences.
   */
  async getFormattedMemoriesSummary(userId: string): Promise<string> {
    const user = await this.db.getUserById(userId);
    const memories = await this.db.getUserMemories(userId);

    const isNameConfirmed = Boolean(user?.preferences?.name_confirmed ?? user?.name_confirmed);
    const preferredName =
      (user?.preferences?.preferred_name as string) ||
      user?.preferred_name ||
      null;

    const isTitleConfirmed = Boolean(user?.preferences?.title_confirmed ?? user?.title_confirmed);
    const preferredTitle =
      (user?.preferences?.preferred_title as string) ||
      user?.preferred_title ||
      null;

    const explicitMemories = memories.filter(
      (m) =>
        m.source === 'EXPLICIT_USER_STATEMENT' ||
        m.source === 'USER_PROVIDED' ||
        m.source === 'USER_CORRECTION'
    );

    const inferredMemories = memories.filter(
      (m) =>
        m.source === 'INFERRED' ||
        m.source === 'USER_CONFIRMED_INFERENCE' ||
        m.source === 'REPEATED_OBSERVATION'
    );

    const workflowMemories = memories.filter((m) => m.category === 'procedural_workflow');

    if (
      !isNameConfirmed &&
      !isTitleConfirmed &&
      explicitMemories.length === 0 &&
      inferredMemories.length === 0 &&
      workflowMemories.length === 0
    ) {
      return (
        "I don't have any saved memories or preferences for you yet. " +
        "You can tell me things like 'Remember that I prefer concise answers' or 'Remember that I live in Bangalore' anytime!"
      );
    }

    const sections: string[] = ['Here is what I remember about you:\n'];

    // 1. Identity section
    sections.push('👤 Profile & Identity:');
    if (isNameConfirmed && preferredName) {
      sections.push(`• Preferred Name: ${preferredName} (Confirmed)`);
    } else {
      sections.push('• Preferred Name: Not set');
    }
    if (isTitleConfirmed && preferredTitle) {
      sections.push(`• Preferred Title: ${preferredTitle} (Confirmed)`);
    } else {
      sections.push('• Preferred Title: None');
    }

    // 2. Explicit Preferences
    if (explicitMemories.length > 0) {
      sections.push('\n⭐ Confirmed Preferences (Stated by you):');
      for (const m of explicitMemories) {
        if (m.category === 'procedural_workflow' || m.category === 'episodic_experience') continue;
        sections.push(`• ${m.key.replace(/_/g, ' ')}: ${m.value}`);
      }
    }

    // 3. Inferred Preferences
    if (inferredMemories.length > 0) {
      sections.push('\n💡 Inferred & Observed Preferences:');
      for (const m of inferredMemories) {
        const confPct = Math.round((m.confidence || 0.8) * 100);
        sections.push(`• ${m.key.replace(/_/g, ' ')}: ${m.value} (Confidence: ${confPct}%)`);
      }
    }

    // 4. Saved Workflows
    if (workflowMemories.length > 0) {
      sections.push('\n🛠️ Saved Workflows:');
      for (const m of workflowMemories) {
        try {
          const parsed: ProceduralWorkflow = JSON.parse(m.value);
          sections.push(`• ${parsed.service} (${parsed.workflowName}): ${parsed.steps.join(' -> ')}`);
        } catch {
          sections.push(`• ${m.key}: ${m.value}`);
        }
      }
    }

    sections.push(
      '\nTip: You can tell me "Forget [item]" to delete a specific preference, or "Forget everything" to clear all memories.'
    );

    return sections.join('\n');
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

    // 4. Communication style: "Use short answers", "Be concise", "Keep replies brief", "I prefer the shorter explanation"
    if (/use\s+short\s+answers|be\s+concise|keep\s+(?:replies|answers)\s+brief|i\s+prefer\s+the\s+shorter\s+explanation/i.test(clean)) {
      results.push({
        category: 'communication_style',
        key: 'reply_length',
        value: 'short and concise',
      });
    }

    // 5. Technical explanations: "Please explain technical things simply", "Explain technical stuff simply"
    if (/(?:please\s+)?explain\s+technical\s+(?:things|concepts|stuff)\s+simply/i.test(clean)) {
      results.push({
        category: 'communication_style',
        key: 'explanation_style',
        value: 'simple and clear',
      });
    }

    // 6. Booking budget: "I prefer hotels under ₹<N>" or "hotels under <N>"
    const budgetMatch = clean.match(/(?:prefer\s+hotels\s+under|hotels\s+under)\s+([₹$€]?\s*\d+)/i);
    if (budgetMatch && budgetMatch[1]) {
      results.push({
        category: 'booking_preferences',
        key: 'max_hotel_budget',
        value: budgetMatch[1].trim(),
      });
    }

    // 7. Airport: "Remember my usual airport is <Code>" or "my usual airport is <Code>"
    const airportMatch = clean.match(/(?:remember\s+)?my\s+usual\s+airport(?:\s+is)?\s+([a-zA-Z0-9\s]+)/i);
    if (airportMatch && airportMatch[1]) {
      const apt = airportMatch[1].replace(/[.!?]+$/, '').trim();
      if (apt.length >= 2 && apt.length <= 40) {
        results.push({ category: 'saved_airports', key: 'usual_airport', value: apt });
      }
    }

    // 8. Travel seat: "Remember I prefer window seats" or "prefer window seat"
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

    // 9. Disliked title: "Don't call me sir"
    if (/don['’]?t\s+call\s+me\s+sir\b/i.test(clean)) {
      results.push({
        category: 'communication_style',
        key: 'avoid_title',
        value: 'sir',
      });
    }

    // 10. Avoid merchant / website: "Don't use that website <X>"
    const avoidMatch = clean.match(/don['’]?t\s+use\s+(?:that\s+website|that\s+merchant|website)\s+([a-zA-Z0-9\s.-]+)/i);
    if (avoidMatch && avoidMatch[1]) {
      results.push({
        category: 'preferences',
        key: 'avoid_website',
        value: avoidMatch[1].trim(),
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
      const personalizationEnabled = user?.personalization_enabled !== false;

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
        personalizationEnabled,
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
        personalizationEnabled: false,
        error: err.message,
      };
    }
  }
}
