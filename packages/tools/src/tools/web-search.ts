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

/**
 * Free DuckDuckGo / Open Search Adapter.
 * Does not require any API keys. Uses public search endpoints.
 */
export class DuckDuckGoSearchProvider implements SearchProvider {
  async search(
    query: string,
    maxResults = 5,
    options?: SearchProviderOptions
  ): Promise<SearchResultItem[]> {
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? 10_000;
    console.log(`[WebSearch] search_start query="${query.slice(0, 100)}" timeout_ms=${timeoutMs}`);

    const internalAbort = new AbortController();
    const abortListener = () => {
      internalAbort.abort(new Error('Search aborted by caller'));
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        console.log(`[WebSearch] search_timeout timeout_ms=${timeoutMs}`);
        throw new Error('Search aborted by caller');
      }
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    const timer = setTimeout(() => {
      internalAbort.abort(new Error(`Web search timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        signal: internalAbort.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });
      clearTimeout(timer);
      if (options?.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }

      if (!res.ok) {
        throw new Error(`Search provider returned status ${res.status}`);
      }

      const html = await res.text();
      const results: SearchResultItem[] = [];

      // Extract results from HTML
      const regex = /<a class="result__url" href="([^"]+)".*?<h2 class="result__title">[\s\S]*?<a.*?>(.*?)<\/a>[\s\S]*?<a class="result__snippet".*?>(.*?)<\/a>/g;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(html)) !== null && results.length < maxResults) {
        const rawUrl = match[1]?.trim();
        const rawTitle = match[2]?.replace(/<[^>]+>/g, '').trim();
        const rawSnippet = match[3]?.replace(/<[^>]+>/g, '').trim();

        if (rawTitle && rawUrl) {
          // Decode URL if routed through duckduckgo redirect uddg=...
          let finalUrl = rawUrl;
          if (rawUrl.includes('uddg=')) {
            const parsedUrl = new URL(`https:${rawUrl.startsWith('//') ? '' : '//'}${rawUrl}`);
            const uddg = parsedUrl.searchParams.get('uddg');
            if (uddg) finalUrl = decodeURIComponent(uddg);
          }

          results.push({
            title: rawTitle,
            snippet: rawSnippet || '',
            url: finalUrl,
          });
        }
      }

      console.log(`[WebSearch] search_success count=${results.length} latency_ms=${Date.now() - startTime}`);
      return results;
    } catch (err: any) {
      clearTimeout(timer);
      if (options?.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }

      const isTimeout =
        err.name === 'AbortError' ||
        (err.message && err.message.toLowerCase().includes('time')) ||
        Boolean(options?.signal?.aborted);

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
        const isTimeout = errMsg.toLowerCase().includes('timed out');
        return {
          success: false,
          error: errMsg,
          data: {
            success: false,
            errorType: isTimeout ? 'TIMEOUT' : 'SEARCH_FAILED',
            message: errMsg,
          },
          userFacingMessage: 'Web search was unable to retrieve results at this time.',
        };
      }
    },
  };
}
