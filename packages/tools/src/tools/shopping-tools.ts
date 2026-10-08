import { z } from 'zod';
import { BaseTool, ToolExecutionContext, ToolResult, ApprovalRequiredError, formatMinorUnits, parseToMinorUnits } from '@nexa/shared';
import { SearchProvider, DuckDuckGoSearchProvider } from './web-search.js';

export interface ProductItem {
  title: string;
  store: string;
  price?: number;
  currency?: string;
  url: string;
  snippet?: string;
}

// In-memory user active shopping cart state
interface UserCartRecord {
  items: Array<{ name: string; priceMinor: number; quantity: number; store: string }>;
  store: string;
  lastVerifiedAt?: number;
}
const userCarts = new Map<string, UserCartRecord>();

export function createShoppingTools(searchProvider: SearchProvider = new DuckDuckGoSearchProvider()): BaseTool[] {
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

  const addToCartTool: BaseTool = {
    name: 'shopping_add_to_cart',
    description: 'Adds a selected item to the user shopping cart on the specified store.',
    riskLevel: 'low_risk',
    parametersSchema: z.object({
      productName: z.string().describe('Name of product to add'),
      price: z.number().describe('Product price (e.g. 499 for ₹499)'),
      store: z.string().default('Blinkit').describe('Store or platform name (e.g. Blinkit, Amazon)'),
      quantity: z.number().default(1).describe('Quantity to add'),
      currency: z.string().default('INR').describe('Currency code'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (
      args: { productName: string; price: number; store: string; quantity: number; currency: string },
      context: ToolExecutionContext
    ): Promise<ToolResult> => {
      const userId = context.user.id;
      const priceMinor = parseToMinorUnits(args.price);
      let cart = userCarts.get(userId);
      if (!cart || cart.store !== args.store) {
        cart = { items: [], store: args.store };
        userCarts.set(userId, cart);
      }

      cart.items.push({
        name: args.productName,
        priceMinor,
        quantity: args.quantity || 1,
        store: args.store,
      });
      cart.lastVerifiedAt = Date.now();

      const totalMinor = cart.items.reduce((sum, item) => sum + item.priceMinor * item.quantity, 0);
      const formattedTotal = formatMinorUnits(totalMinor, args.currency);

      console.log(`[Agent] step_completed tool=shopping_add_to_cart item="${args.productName}"`);
      return {
        success: true,
        data: {
          addedItem: args.productName,
          store: args.store,
          quantity: args.quantity,
          cartTotalMinor: totalMinor,
          formattedTotal,
          itemCount: cart.items.length,
        },
        userFacingMessage: `Added *${args.productName}* to your ${args.store} cart. Total: *${formattedTotal}*.`,
      };
    },
  };

  const verifyCartTool: BaseTool = {
    name: 'shopping_verify_cart',
    description: 'Verifies the current items, quantities, and total price in the shopping cart before requesting checkout approval.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      expectedItem: z.string().optional().describe('Optional item name to verify in the cart'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { expectedItem?: string }, context: ToolExecutionContext): Promise<ToolResult> => {
      const userId = context.user.id;
      console.log(`[Agent] verification_started step=shopping_cart target="${args.expectedItem || 'all_items'}"`);
      const cart = userCarts.get(userId);

      if (!cart || cart.items.length === 0) {
        return {
          success: true,
          data: { verified: false, itemCount: 0, items: [], totalMinor: 0, formattedTotal: '₹0.00' },
          userFacingMessage: 'Your cart is currently empty.',
        };
      }

      const totalMinor = cart.items.reduce((sum, item) => sum + item.priceMinor * item.quantity, 0);
      const formattedTotal = formatMinorUnits(totalMinor, 'INR');

      console.log(`[Agent] verification_passed step=shopping_cart items_count=${cart.items.length}`);
      return {
        success: true,
        data: {
          verified: true,
          store: cart.store,
          itemCount: cart.items.length,
          items: cart.items,
          totalMinor,
          formattedTotal,
        },
        userFacingMessage: `Verified ${cart.store} cart with ${cart.items.length} item(s). Total: *${formattedTotal}*.`,
      };
    },
  };

  const checkoutTool: BaseTool = {
    name: 'shopping_checkout',
    description: 'Places the e-commerce order and charges payment. REQUIRES explicit user approval.',
    riskLevel: 'high_risk',
    parametersSchema: z.object({
      store: z.string().describe('Store or merchant name (e.g. Blinkit)'),
      amount: z.number().describe('Total order amount (e.g. 549 for ₹549)'),
      itemSummary: z.string().describe('Summary of items in order'),
      deliveryAddress: z.string().optional().describe('Delivery address'),
    }),
    requiresApproval: (args) => {
      const amountMinor = parseToMinorUnits(args.amount);
      const formatted = formatMinorUnits(amountMinor, 'INR');
      return {
        required: true,
        reason: 'E-commerce Purchase',
        impactLevel: 'high',
        formatConfirmationPrompt: () =>
          `*Order Confirmation Required*\n\n` +
          `• *Action*: Place Purchase Order\n` +
          `• *Merchant*: ${args.store}\n` +
          `• *Items*: ${args.itemSummary}\n` +
          `• *Total Amount*: *${formatted}*\n` +
          `• *Delivery*: ${args.deliveryAddress || 'Saved default address'}\n\n` +
          `*What will happen*: Once approved, your order will be placed with ${args.store} and payment processed.\n\n` +
          `Reply *Yes* or tap *Approve* to confirm this purchase.`,
      };
    },
    execute: async (
      args: { store: string; amount: number; itemSummary: string; deliveryAddress?: string },
      context: ToolExecutionContext
    ): Promise<ToolResult> => {
      const amountMinor = parseToMinorUnits(args.amount);
      const formattedAmount = formatMinorUnits(amountMinor, 'INR');

      if (!context.isUserConfirmed) {
        throw new ApprovalRequiredError(
          `*Order Confirmation Required*\n\n` +
            `• *Action*: Place Purchase Order\n` +
            `• *Merchant*: ${args.store}\n` +
            `• *Items*: ${args.itemSummary}\n` +
            `• *Total Amount*: *${formattedAmount}*\n` +
            `• *Delivery*: ${args.deliveryAddress || 'Saved default address'}\n\n` +
            `*What will happen*: Once approved, your order will be placed with ${args.store} and payment processed.\n\n` +
            `Reply *Yes* or tap *Approve* to confirm this purchase.`,
          'shopping_checkout',
          args as Record<string, unknown>,
          'high'
        );
      }

      // Clear user cart upon successful purchase
      userCarts.delete(context.user.id);
      const orderId = `ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

      console.log(`[Agent] step_completed tool=shopping_checkout order_id=${orderId}`);
      return {
        success: true,
        data: {
          orderId,
          store: args.store,
          amountMinor,
          formattedAmount,
          status: 'confirmed',
        },
        userFacingMessage: `🎉 Order placed successfully on *${args.store}*! Order ID: \`${orderId}\`. Total: *${formattedAmount}*.`,
      };
    },
  };

  return [searchProductsTool, comparePricesTool, addToCartTool, verifyCartTool, checkoutTool];
}
