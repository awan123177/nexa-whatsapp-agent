import { z } from 'zod';
import { BaseTool, ToolExecutionContext, ToolResult } from '@nexa/shared';
import { SearchProvider } from './web-search.js';

export interface ProductItem {
  title: string;
  store: string;
  price?: number;
  currency?: string;
  url: string;
  snippet?: string;
}

export function createShoppingTools(searchProvider: SearchProvider): BaseTool[] {
  const searchProductsTool: BaseTool = {
    name: 'search_products',
    description: 'Searches across e-commerce platforms and online stores for products, specs, and current availability.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      query: z.string().describe('Product name, model, or keywords (e.g. Sony WH-1000XM5 headphones)'),
      category: z.string().optional().describe('Optional category filter (e.g. electronics, footwear)'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { query: string; category?: string }, _context: ToolExecutionContext): Promise<ToolResult> => {
      const searchTerms = `${args.query} buy online price`;
      const results = await searchProvider.search(searchTerms, 6);

      const products: ProductItem[] = results.map((r) => ({
        title: r.title,
        store: new URL(r.url).hostname.replace('www.', ''),
        url: r.url,
        snippet: r.snippet,
      }));

      return {
        success: true,
        data: {
          query: args.query,
          products,
        },
      };
    },
  };

  const comparePricesTool: BaseTool = {
    name: 'compare_prices',
    description: 'Compares prices and offers for a specific product across multiple verified retailers.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      productName: z.string().describe('Exact product name or model'),
      targetStores: z.array(z.string()).optional().describe('Optional list of specific retailers to compare'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { productName: string; targetStores?: string[] }, _context: ToolExecutionContext): Promise<ToolResult> => {
      const query = `compare price "${args.productName}"`;
      const results = await searchProvider.search(query, 6);

      return {
        success: true,
        data: {
          product: args.productName,
          sourcesChecked: results.length,
          findings: results.map((r) => ({
            source: new URL(r.url).hostname,
            title: r.title,
            url: r.url,
            snippet: r.snippet,
          })),
        },
      };
    },
  };

  return [searchProductsTool, comparePricesTool];
}
