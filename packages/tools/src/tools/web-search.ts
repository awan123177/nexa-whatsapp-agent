import { z } from 'zod';
import { BaseTool, ToolExecutionContext, ToolResult } from '@nexa/shared';

export interface SearchResultItem {
  title: string;
  snippet: string;
  url: string;
}

export interface SearchProviderOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SearchProvider {
  search(query: string, maxResults?: number, options?: SearchProviderOptions): Promise<SearchResultItem[]>;
}

function decodeDdgUrl(rawUrl: string): string {
  if (rawUrl.includes('uddg=')) {
    try {
      const parsedUrl = new URL(`https:${rawUrl.startsWith('//') ? '' : '//'}${rawUrl}`);
      const uddg = parsedUrl.searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
    } catch {}
  }
  return rawUrl;
}

/**
 * Free DuckDuckGo / Open Search Adapter.
 * Does not require any API keys. Uses public search endpoints with multi-tier fallback:
 * Tier 1: HTML endpoint (bounded budget)
 * Tier 2: Lite endpoint (fast, minimal, resilient to cloud bot challenges)
 * Tier 3: Instant Answer API endpoint
 */
export class DuckDuckGoSearchProvider implements SearchProvider {
  private parseHtmlResults(html: string, maxResults: number): SearchResultItem[] {
    const results: SearchResultItem[] = [];
    const regex = /<a class="result__url" href="([^"]+)".*?<h2 class="result__title">[\s\S]*?<a.*?>(.*?)<\/a>[\s\S]*?<a class="result__snippet".*?>(.*?)<\/a>/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(html)) !== null && results.length < maxResults) {
      const rawUrl = match[1]?.trim();
      const rawTitle = match[2]?.replace(/<[^>]+>/g, '').trim();
      const rawSnippet = match[3]?.replace(/<[^>]+>/g, '').trim();

      if (rawTitle && rawUrl) {
        results.push({
          title: rawTitle,
          snippet: rawSnippet || '',
          url: decodeDdgUrl(rawUrl),
        });
      }
    }
    return results;
  }

  private parseLiteResults(html: string, maxResults: number): SearchResultItem[] {
    const results: SearchResultItem[] = [];
    const liteRegex = /<a class="result-link" href="([^"]+)".*?>(.*?)<\/a>[\s\S]*?<td class="result-snippet">([\s\S]*?)<\/td>/g;
    let match: RegExpExecArray | null;

    while ((match = liteRegex.exec(html)) !== null && results.length < maxResults) {
      const rawUrl = match[1]?.trim();
      const rawTitle = match[2]?.replace(/<[^>]+>/g, '').trim();
      const rawSnippet = match[3]?.replace(/<[^>]+>/g, '').trim();

      if (rawTitle && rawUrl) {
        results.push({
          title: rawTitle,
          snippet: rawSnippet || '',
          url: decodeDdgUrl(rawUrl),
        });
      }
    }
    return results;
  }

  private async executeTierFetch(
    url: string,
    fetchInit: RequestInit,
    budgetMs: number,
    parentSignal?: AbortSignal
  ): Promise<Response> {
    if (parentSignal?.aborted) {
      throw parentSignal.reason || new Error(`Web search timed out after ${budgetMs}ms`);
    }

    const tierController = new AbortController();
    let timedOut = false;
    const tierTimer = setTimeout(() => {
      timedOut = true;
      tierController.abort(new Error(`Tier request timed out after ${budgetMs}ms`));
    }, budgetMs);

    const onParentAbort = () => {
      tierController.abort(parentSignal?.reason || new Error(`Web search timed out after ${budgetMs}ms`));
    };

    if (parentSignal) {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }

    try {
      const response = await fetch(url, {
        ...fetchInit,
        signal: tierController.signal,
      });
      return response;
    } catch (err: any) {
      if (parentSignal?.aborted) {
        throw parentSignal.reason || new Error(`Web search timed out after ${budgetMs}ms`);
      }
      if (timedOut || err.name === 'AbortError' || err.message?.includes('aborted')) {
        throw new Error(`Tier request timed out after ${budgetMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(tierTimer);
      if (parentSignal) {
        parentSignal.removeEventListener('abort', onParentAbort);
      }
    }
  }

  async search(
    query: string,
    maxResults = 5,
    options?: SearchProviderOptions
  ): Promise<SearchResultItem[]> {
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? 10_000;
    console.log(`[WebSearch] search_start query="${query.slice(0, 100)}" timeout_ms=${timeoutMs}`);

    if (options?.signal?.aborted) {
      console.log(`[WebSearch] search_aborted query="${query.slice(0, 50)}"`);
      throw new Error('Search aborted by caller');
    }

    const abortController = new AbortController();
    const callerSignal = options?.signal;
    const abortListener = () => {
      abortController.abort(new Error('Search aborted by caller'));
    };

    if (callerSignal) {
      callerSignal.addEventListener('abort', abortListener, { once: true });
    }

    const timer = setTimeout(() => {
      abortController.abort(new Error(`Web search timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      // Tier 1: HTML endpoint (budgeted to half of timeout or 4000ms max)
      const tier1BudgetMs = Math.min(4000, Math.floor(timeoutMs / 2));
      try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await this.executeTierFetch(
          url,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
          },
          tier1BudgetMs,
          abortController.signal
        );

        if (res.ok) {
          const html = await res.text();
          const results = this.parseHtmlResults(html, maxResults);
          if (results.length > 0) {
            clearTimeout(timer);
            if (callerSignal) callerSignal.removeEventListener('abort', abortListener);
            console.log(`[WebSearch] search_success count=${results.length} latency_ms=${Date.now() - startTime} tier=html`);
            return results;
          }
        }
      } catch (tier1Err: any) {
        if (abortController.signal.aborted || callerSignal?.aborted) throw tier1Err;
        console.warn(`[WebSearch] tier1_html_fallback query="${query.slice(0, 50)}" reason="${tier1Err.message}"`);
      }

      // Tier 2: Lite endpoint (fast, minimal, highly reliable)
      if (!abortController.signal.aborted) {
        try {
          const tier2BudgetMs = Math.min(4000, timeoutMs - (Date.now() - startTime));
          if (tier2BudgetMs > 500) {
            const liteUrl = `https://lite.duckduckgo.com/lite/`;
            const liteRes = await this.executeTierFetch(
              liteUrl,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                },
                body: `q=${encodeURIComponent(query)}`,
              },
              tier2BudgetMs,
              abortController.signal
            );

            if (liteRes.ok) {
              const liteHtml = await liteRes.text();
              const results = this.parseLiteResults(liteHtml, maxResults);
              if (results.length > 0) {
                clearTimeout(timer);
                if (callerSignal) callerSignal.removeEventListener('abort', abortListener);
                console.log(`[WebSearch] search_success count=${results.length} latency_ms=${Date.now() - startTime} tier=lite`);
                return results;
              }
            }
          }
        } catch (tier2Err: any) {
          if (abortController.signal.aborted || callerSignal?.aborted) throw tier2Err;
          console.warn(`[WebSearch] tier2_lite_fallback query="${query.slice(0, 50)}" reason="${tier2Err.message}"`);
        }
      }

      // Tier 3: Instant Answer API endpoint
      if (!abortController.signal.aborted) {
        try {
          const tier3BudgetMs = Math.min(2500, timeoutMs - (Date.now() - startTime));
          if (tier3BudgetMs > 500) {
            const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
            const apiRes = await this.executeTierFetch(
              apiUrl,
              {
                headers: { 'User-Agent': 'NEXA-Agent/2.0' },
              },
              tier3BudgetMs,
              abortController.signal
            );

            if (apiRes.ok) {
              const data = (await apiRes.json()) as any;
              const results: SearchResultItem[] = [];
              if (data.AbstractURL && data.AbstractText) {
                results.push({
                  title: data.Heading || query,
                  snippet: data.AbstractText,
                  url: data.AbstractURL,
                });
              }
              if (Array.isArray(data.RelatedTopics)) {
                for (const topic of data.RelatedTopics) {
                  if (results.length >= maxResults) break;
                  if (topic.FirstURL && topic.Text) {
                    results.push({
                      title: topic.Text.split(' - ')[0] || topic.Text,
                      snippet: topic.Text,
                      url: topic.FirstURL,
                    });
                  }
                }
              }
              if (results.length > 0) {
                clearTimeout(timer);
                if (callerSignal) callerSignal.removeEventListener('abort', abortListener);
                console.log(`[WebSearch] search_success count=${results.length} latency_ms=${Date.now() - startTime} tier=api`);
                return results;
              }
            }
          }
        } catch (tier3Err: any) {
          if (abortController.signal.aborted || callerSignal?.aborted) throw tier3Err;
          console.warn(`[WebSearch] tier3_api_fallback query="${query.slice(0, 50)}" reason="${tier3Err.message}"`);
        }
      }

      clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener('abort', abortListener);
      console.log(`[WebSearch] search_success count=0 latency_ms=${Date.now() - startTime}`);
      return [];
    } catch (err: any) {
      clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener('abort', abortListener);

      const isCallerAborted = Boolean(callerSignal?.aborted) || (err.message === 'Search aborted by caller' && Boolean(callerSignal));
      if (isCallerAborted) {
        console.log(`[WebSearch] search_aborted query="${query.slice(0, 50)}"`);
        throw new Error('Search aborted by caller');
      }

      const isTimeout =
        abortController.signal.aborted ||
        err.name === 'AbortError' ||
        (err.message && err.message.toLowerCase().includes('time'));

      if (isTimeout) {
        console.log(`[WebSearch] search_timeout timeout_ms=${timeoutMs}`);
        throw new Error(`Web search timed out after ${timeoutMs}ms`);
      } else {
        console.warn(`[WebSearch] search_failed error="${err.message}"`);
        throw new Error(`Web search failed: ${err.message}`);
      }
    }
  }
}

export function createWebSearchTool(provider: SearchProvider = new DuckDuckGoSearchProvider()): BaseTool {
  return {
    name: 'web_search',
    description: 'Searches the live web for current information, facts, real-time news, flight details, prices, or guides.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      query: z.string().describe('The search query string'),
      maxResults: z.number().min(1).max(10).optional().describe('Maximum number of results to return (default 5)'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { query: string; maxResults?: number }, context: ToolExecutionContext): Promise<ToolResult> => {
      try {
        const results = await provider.search(args.query, args.maxResults || 5, {
          signal: context.abortSignal,
          timeoutMs: context.timeoutMs ?? 10_000,
        });

        if (results.length === 0) {
          return {
            success: true,
            data: {
              results: [],
              message: `No search results found for query: "${args.query}". Try rephrasing or searching for specific terms.`,
            },
          };
        }

        return {
          success: true,
          data: {
            query: args.query,
            count: results.length,
            results,
          },
        };
      } catch (err: any) {
        const errMsg = err.message || 'Web search failed';
        const isTimeout =
          errMsg.toLowerCase().includes('timed out') ||
          errMsg.toLowerCase().includes('timeout') ||
          Boolean(context.abortSignal?.aborted);

        const isCommerceQuery = /\b(buy|price|order|amazon|flipkart|blinkit|zepto|instamart|store|cart|screen guard|iphone|protector)\b/i.test(args.query);

        return {
          success: false,
          error: errMsg,
          data: {
            success: false,
            errorType: isTimeout ? 'TIMEOUT' : 'SEARCH_FAILED',
            message: errMsg,
            retriable: true,
            transient: true,
            suggestedAction: isCommerceQuery
              ? 'Web search timed out. Use browser_open, shopping_search, or search_products directly on the target merchant (e.g. Amazon) to find products.'
              : 'Web search timed out. Rephrase the query or use direct browser tools.',
          },
          userFacingMessage: 'Web search was unable to retrieve results at this time.',
        };
      }
    },
  };
}
