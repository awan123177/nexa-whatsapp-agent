import { User } from '@nexa/shared';
import { IDatabaseRepository, MemoryService } from '@nexa/database';

export interface MemoryCommandResult {
  handled: boolean;
  replyText?: string;
  doNotRememberConversation?: boolean;
}

export class MemoryCommandHandler {
  /**
   * Evaluates if a user message is a direct memory control command.
   * If matched, executes the command server-side and returns a friendly response.
   */
  static async handleCommand(params: {
    user: User;
    text: string;
    db: IDatabaseRepository;
  }): Promise<MemoryCommandResult> {
    const { user, text, db } = params;
    const clean = text.trim();
    const lower = clean.toLowerCase();
    const memoryService = new MemoryService(db);

    // 1. Turn personalization off: "Turn personalization off", "Disable personalization"
    if (/^(?:turn\s+(?:off\s+personalization|personalization\s+off)|disable\s+personalization)\b/i.test(lower)) {
      await memoryService.setPersonalizationEnabled(user.id, false);
      return {
        handled: true,
        replyText:
          'Personalization is now turned off. I will no longer use your saved preferences or memory to adjust my responses.',
      };
    }

    // 2. Turn personalization on: "Turn personalization on", "Enable personalization"
    if (/^(?:turn\s+(?:on\s+personalization|personalization\s+on)|enable\s+personalization)\b/i.test(lower)) {
      await memoryService.setPersonalizationEnabled(user.id, true);
      return {
        handled: true,
        replyText:
          'Personalization is now turned on! I’ll adapt my responses, tone, and workflows to your confirmed preferences.',
      };
    }

    // 3. "Forget everything you remember about me" / "Clear all my memories"
    if (
      /^(?:forget\s+everything(?:\s+you\s+remember\s+about\s+me)?|clear\s+all\s+(?:my\s+)?memories|delete\s+all\s+(?:my\s+)?memories|forget\s+all\s+memories)\b/i.test(
        lower
      )
    ) {
      await memoryService.forgetAllMemories(user.id);
      return {
        handled: true,
        replyText:
          "I've forgotten everything I remembered about you. Your memory profile has been completely cleared, and we're starting fresh!",
      };
    }

    // 4. "Don't remember this conversation" / "Do not remember this"
    if (/^(?:don['’]?t|do\s+not)\s+remember\s+this(?:\s+conversation)?\b/i.test(lower)) {
      console.log(`[Memory] session_marked_do_not_remember user=${user.id}`);
      return {
        handled: true,
        replyText:
          "Understood. I won't save any notes, preferences, or summaries from this conversation.",
        doNotRememberConversation: true,
      };
    }

    // 5. "What do you remember about me?" / "What do you know about me?" / "Show my memories"
    if (
      /^(?:what\s+do\s+you\s+(?:remember|know)\s+about\s+me|show\s+(?:my\s+)?memories|list\s+(?:my\s+)?memories|what\s+have\s+you\s+remembered)\b/i.test(
        lower
      )
    ) {
      const summary = await memoryService.getFormattedMemoriesSummary(user.id);
      return {
        handled: true,
        replyText: summary,
      };
    }

    // 6. "Stop using that preference"
    if (/^stop\s+using\s+(?:that|this)\s+preference\b/i.test(lower)) {
      // Find latest non-identity preference and archive or remove it
      const memories = await db.getUserMemories(user.id);
      const candidates = memories.filter((m) => m.category !== 'identity');
      if (candidates.length > 0) {
        const latest = candidates[0];
        await db.deleteMemory(latest.id, user.id);
        return {
          handled: true,
          replyText: `I've removed that preference (${latest.key.replace(/_/g, ' ')}: "${latest.value}").`,
        };
      }
      return {
        handled: true,
        replyText: "I don't have an active preference to remove right now.",
      };
    }

    // 7. "Forget [target]" (e.g. "Forget my flight seat preference", "Forget aisle seat preference")
    const forgetMatch = lower.match(/^forget\s+(?:that\s+i\s+prefer\s+|that\s+i\s+like\s+|that\s+|my\s+)?(.+)/i);
    if (forgetMatch && forgetMatch[1]) {
      const targetQuery = forgetMatch[1].replace(/[.!?]+$/, '').trim();
      // Ensure target query isn't just "everything" which was handled above
      if (targetQuery && !targetQuery.startsWith('everything') && !targetQuery.startsWith('all')) {
        const deleted = await memoryService.forgetMemory(user.id, targetQuery);
        if (deleted) {
          return {
            handled: true,
            replyText: `Got it! I've forgotten your preference for "${targetQuery}".`,
          };
        } else {
          return {
            handled: true,
            replyText: `I couldn't find a stored memory matching "${targetQuery}". You can ask "What do you remember about me?" to view your active memories.`,
          };
        }
      }
    }

    // 8. Explicit "Remember that I prefer ..."
    if (/^remember\s+that\s+i\s+prefer\b/i.test(lower)) {
      const extracted = MemoryService.extractExplicitPreferences(clean);
      if (extracted.length > 0) {
        for (const item of extracted) {
          await memoryService.saveMemory({
            userId: user.id,
            category: item.category,
            key: item.key,
            value: item.value,
            confidence: 1.0,
            source: 'EXPLICIT_USER_STATEMENT',
            confirmed: true,
            evidenceSummary: clean,
          });
        }
        const formatted = extracted
          .map((e) => `${e.key.replace(/_/g, ' ')}: "${e.value}"`)
          .join(', ');
        return {
          handled: true,
          replyText: `Got it! I've remembered that for you (${formatted}). 😊`,
        };
      } else {
        const preference = clean.replace(/^remember\s+that\s+i\s+prefer\s+/i, '').trim();
        if (preference.length > 2) {
          await memoryService.saveMemory({
            userId: user.id,
            category: 'preferences',
            key: 'user_preference',
            value: preference,
            confidence: 1.0,
            source: 'EXPLICIT_USER_STATEMENT',
            confirmed: true,
            evidenceSummary: clean,
          });
          return {
            handled: true,
            replyText: `Got it! I've remembered that you prefer: "${preference}". 😊`,
          };
        }
      }
    }

    return { handled: false };
  }
}
