import { z } from 'zod';
import { BaseTool, ToolExecutionContext, ToolResult } from '@nexa/shared';

export interface SearchResultItem {
  title: string;
  snippet: string;
  url: string;
}

export interface SearchProvider {
  search(query: string, maxResults?: number): Promise<SearchResultItem[]>;
}

/**
 * Free DuckDuckGo / Open Search Adapter.
 * Does not require any API keys. Uses public search endpoints.
 */
export class DuckDuckGoSearchProvider implements SearchProvider {
  async search(query: string, maxResults = 5): Promise<SearchResultItem[]> {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

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

      return results;
    } catch (err: any) {
      console.warn(`[WebSearch] Search request failed: ${err.message}`);
      return [];
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
    execute: async (args: { query: string; maxResults?: number }, _context: ToolExecutionContext): Promise<ToolResult> => {
      const results = await provider.search(args.query, args.maxResults || 5);

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
    },
  };
}
