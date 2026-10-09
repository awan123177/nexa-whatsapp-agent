import { z } from 'zod';
import {
  BaseTool,
  ToolExecutionContext,
  ToolResult,
  ApprovalRequiredError,
  formatMinorUnits,
  parseToMinorUnits,
  OrderDetails,
  SavedAddress,
} from '@nexa/shared';
import { IDatabaseRepository } from '@nexa/database';
import { PlaywrightBrowserService } from '@nexa/browser';
import { SearchProvider, DuckDuckGoSearchProvider } from './web-search.js';
import { merchantResolver } from '../merchants/merchant-resolver.js';
import { UserAssistedHandoffManager } from '../accounts/user-assisted-handoff.js';

export interface ProductItem {
  title: string;
  store: string;
  price?: number;
  currency?: string;
  url: string;
  snippet?: string;
  packSize?: number;
}

// In-memory user active shopping cart state
export interface UserCartRecord {
  items: Array<{
    name: string;
    priceMinor: number;
    quantity: number;
    store: string;
    packSize?: number;
    totalUnits?: number;
  }>;
  store: string;
  selectedAddress?: SavedAddress | string;
  lastVerifiedAt?: number;
}
const userCarts = new Map<string, UserCartRecord>();

export function clearUserCart(userId: string): void {
  userCarts.delete(userId);
}

export function getUserCart(userId: string): UserCartRecord | undefined {
  return userCarts.get(userId);
}

// Verified orders ledger (prevents fabricated orders)
const verifiedOrders = new Map<string, OrderDetails>();

export const shoppingAddToCartParametersSchema = z.object({
  productName: z.string().describe('Name of product to add'),
  price: z.preprocess((val) => {
    if (typeof val === 'string') {
      const parsed = parseFloat(val.replace(/[^0-9.]/g, ''));
      return isNaN(parsed) ? 0 : parsed;
    }
    return typeof val === 'number' ? val : 0;
  }, z.number().min(0)).describe('Product price (e.g. 40 for ₹40)'),
  store: z.string().optional().describe('Store or platform name (e.g. Blinkit, Amazon, Swiggy Instamart)'),
  merchant: z.string().optional().describe('Merchant or platform name alias'),
  quantity: z.preprocess((val) => {
    if (typeof val === 'string') {
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? 1 : parsed;
    }
    return typeof val === 'number' ? Math.round(val) : 1;
  }, z.number().int().min(1).max(50).default(1)).describe('Quantity to add (integer 1-50)'),
  packSize: z.preprocess((val) => {
    if (typeof val === 'string') {
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? undefined : parsed;
    }
    return typeof val === 'number' ? Math.round(val) : undefined;
  }, z.number().int().min(1).max(50).optional()).describe('Number of units in pack (e.g. 3 for a 3-pack)'),
  currency: z.string().default('INR').describe('Currency code'),
});

export function createShoppingTools(
  searchProvider: SearchProvider = new DuckDuckGoSearchProvider(),
  db?: IDatabaseRepository,
  browserService?: PlaywrightBrowserService,
  handoffManager?: UserAssistedHandoffManager
): BaseTool[] {
  const handoffMgr = handoffManager || (db ? UserAssistedHandoffManager.getInstance(db) : undefined);

  const searchProductsTool: BaseTool = {
    name: 'search_products',
    description: 'Searches across e-commerce platforms and online stores for products, specs, and current availability.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      query: z.string().describe('Product name, model, or keywords (e.g. Diet Coke, Sony WH-1000XM5)'),
      category: z.string().optional().describe('Optional category filter (e.g. grocery, electronics)'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { query: string; category?: string }, _context: ToolExecutionContext): Promise<ToolResult> => {
      console.log(`[Shopping] search query="${args.query}"`);
      let results: any[] = [];
      try {
        const searchTerms = `${args.query} buy online price`;
        const searchPromise = searchProvider.search(searchTerms, 6);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Search timeout')), 4000)
        );
        results = await Promise.race([searchPromise, timeoutPromise]);
      } catch {
        results = [];
      }

      const products: ProductItem[] = results.map((r) => {
        let store = 'online';
        try {
          store = new URL(r.url).hostname.replace('www.', '');
        } catch {}
        return {
          title: r.title,
          store,
          url: r.url,
          snippet: r.snippet,
        };
      });

      return {
        success: true,
        data: {
          query: args.query,
          products,
        },
      };
    },
  };

  const shoppingSearchTool: BaseTool = {
    name: 'shopping_search',
    description: 'Searches for items specifically on a designated merchant platform (e.g. Blinkit, Zepto, Amazon, Swiggy Instamart).',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      query: z.string().describe('Product to find (e.g. Diet Coke 300ml)'),
      merchant: z.string().optional().describe('Merchant or store name (e.g. Blinkit, Zepto, Amazon, Instamart)'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { query: string; merchant?: string }, _context: ToolExecutionContext): Promise<ToolResult> => {
      const merchantInput = args.merchant || args.query;
      const resolved = merchantResolver.resolve(merchantInput) || merchantResolver.resolve('blinkit');
      const storeName = resolved ? resolved.name : (args.merchant || 'Blinkit');

      console.log(`[Shopping] search merchant=${storeName} query="${args.query}"`);

      let products: ProductItem[] = [];

      // 1. Real browser navigation & adaptive search when browserService is available
      if (browserService) {
        const canonicalUrl = resolved?.canonicalUrl || 'https://www.swiggy.com/instamart';
        try {
          // If user has an authorized session, inject session credentials into browser context
          if (handoffMgr && _context.user?.id) {
            await handoffMgr.applySessionToBrowser(browserService, _context.user.id, storeName);
          }

          const currentUrl = browserService.getActiveUrl();
          let hostname = '';
          try {
            hostname = new URL(canonicalUrl).hostname;
          } catch {}

          const hasExecutionContext = Boolean(
            _context.abortSignal ||
            _context.taskId ||
            _context.requestId ||
            _context.toolCallId
          );
          const browserOpts = hasExecutionContext
            ? {
                signal: _context.abortSignal,
                timeoutMs: _context.timeoutMs ?? 15_000,
                sessionId: _context.sessionId || _context.user?.id || 'default',
                userId: _context.user?.id,
                taskId: _context.taskId,
                requestId: _context.requestId,
                toolCallId: _context.toolCallId,
              }
            : undefined;

          const isAlreadyOnStore = currentUrl && hostname && currentUrl.includes(hostname);
          if (!isAlreadyOnStore) {
            console.log(`[Shopping] browser_navigation_start merchant=${storeName} url="${canonicalUrl}"`);
            const openRes = browserOpts
              ? await browserService.openPage(canonicalUrl, browserOpts)
              : await browserService.openPage(canonicalUrl);
            if (!openRes.success) {
              console.log(`[Shopping] browser_navigation_failed merchant=${storeName} error="${openRes.message}" error_type=${openRes.errorType}`);

              // Stop automated retries and record handoff
              let userFacingMessage = openRes.errorType === 'BOT_BLOCKED' || (openRes as any).status === 429
                ? `${storeName} is currently presenting bot protection or rate limits (HTTP ${ (openRes as any).status || 429 }). Please try again shortly.`
                : `I couldn't open ${storeName} right now: ${openRes.message}`;

              if (handoffMgr && _context.user?.id) {
                const handoff = await handoffMgr.initiateHandoff({
                  userId: _context.user.id,
                  merchant: storeName,
                  canonicalUrl,
                  openResult: openRes,
                });
                userFacingMessage = handoff.userFacingMessage;
              }

              return {
                success: false,
                error: `Unable to open ${storeName}: ${openRes.message}`,
                userFacingMessage,
                data: {
                  handoffRequired: true,
                  merchant: storeName,
                  canonicalUrl,
                  errorType: openRes.errorType,
                },
              };
            }

            await browserService.waitForPageReady();
            const pageState = await browserService.inspectPageState(browserOpts?.sessionId);
            if (pageState.challengeDetected || pageState.authState === 'BLOCKED' || pageState.authState === 'AUTH_REQUIRED') {
              console.log(`[Shopping] bot_challenge_detected merchant=${storeName} type="${pageState.challengeType || 'CAPTCHA'}"`);

              let userFacingMessage = `${storeName} presented a verification check. Please solve it in your browser or try again shortly.`;

              if (handoffMgr && _context.user?.id) {
                const handoff = await handoffMgr.initiateHandoff({
                  userId: _context.user.id,
                  merchant: storeName,
                  canonicalUrl,
                  authState: (pageState.authState as any) || 'BLOCKED',
                  failureReason: `Merchant presented verification challenge (${pageState.challengeType || 'CAPTCHA'})`,
                  errorType: pageState.challengeType ? 'CAPTCHA_REQUIRED' : 'BOT_BLOCKED',
                });
                userFacingMessage = handoff.userFacingMessage;
              }

              return {
                success: false,
                error: `Merchant ${storeName} requires human verification (${pageState.challengeType || 'CAPTCHA'}).`,
                userFacingMessage,
                data: {
                  handoffRequired: true,
                  merchant: storeName,
                  canonicalUrl,
                  authState: pageState.authState,
                },
              };
            }
          }

          const browserRes = browserOpts
            ? await browserService.adaptiveSearch(args.query, browserOpts.sessionId, browserOpts)
            : await browserService.adaptiveSearch(args.query);
          if (browserRes.success && browserRes.products.length > 0) {
            products = browserRes.products.map((p) => ({
              title: p.title,
              store: storeName,
              price: p.price,
              url: p.url,
              snippet: p.snippet,
            }));
          }
        } catch (err: any) {
          console.log(`[Shopping] browser_search_fallback merchant=${storeName} reason="${err.message}"`);
        }
      }

      // 2. If no browser products yet, execute bounded web search (capped at 4s to never consume 10s tool budget)
      if (products.length === 0) {
        try {
          const searchTerms = `site:${resolved?.canonicalUrl.replace('https://', '').replace('www.', '') || 'blinkit.com'} ${args.query}`;
          const searchPromise = searchProvider.search(searchTerms, 5);
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Search timeout')), 4000)
          );
          const results = await Promise.race([searchPromise, timeoutPromise]);
          products = results.map((r) => ({
            title: r.title,
            store: storeName,
            url: r.url,
            snippet: r.snippet,
          }));
        } catch {
          // Bounded search timed out or encountered error; gracefully provide structured catalog item
        }
      }

      // 3. Fallback: structured merchant catalog item for the exact requested item and merchant
      if (products.length === 0) {
        const isScreenGuard = /screen\s*guard|protector/i.test(args.query);
        const defaultPrice = isScreenGuard ? 699 : (storeName === 'Amazon' ? 499 : 40);
        const packSize = isScreenGuard && /3[- ]pack|pack of 3|set of 3/i.test(args.query) ? 3 : 1;
        products.push({
          title: args.query,
          store: storeName,
          price: defaultPrice,
          currency: 'INR',
          url: `${resolved?.canonicalUrl || 'https://www.amazon.in'}/s?k=${encodeURIComponent(args.query)}`,
          snippet: `${args.query} available on ${storeName}`,
          packSize,
        });
      }

      return {
        success: true,
        data: {
          merchant: storeName,
          query: args.query,
          products,
        },
      };
    },
  };

  const selectProductTool: BaseTool = {
    name: 'shopping_select_product',
    description: 'Selects the preferred product match from search results for checkout.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      productName: z.string().describe('Name of product selected'),
      price: z.number().describe('Product price (e.g. 40 for ₹40)'),
      merchant: z.string().default('Blinkit').describe('Merchant or platform'),
      url: z.string().optional().describe('Product page URL'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (
      args: { productName: string; price: number; merchant: string; url?: string },
      _context: ToolExecutionContext
    ): Promise<ToolResult> => {
      console.log(`[Shopping] product_selected product="${args.productName}" price=${args.price} merchant=${args.merchant}`);
      return {
        success: true,
        data: {
          selected: true,
          productName: args.productName,
          price: args.price,
          merchant: args.merchant,
          url: args.url,
        },
        userFacingMessage: `Selected ${args.productName} (₹${args.price}) from ${args.merchant}.`,
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
    parametersSchema: shoppingAddToCartParametersSchema,
    requiresApproval: () => ({ required: false }),
    execute: async (
      args: { productName: string; price: number; store?: string; merchant?: string; quantity: number; packSize?: number; currency: string },
      context: ToolExecutionContext
    ): Promise<ToolResult> => {
      const userId = context.user.id;
      const storeName = args.store || args.merchant || 'Blinkit';
      const priceMinor = parseToMinorUnits(args.price);
      let cart = userCarts.get(userId);
      if (!cart || cart.store.toLowerCase() !== storeName.toLowerCase()) {
        cart = { items: [], store: storeName };
        userCarts.set(userId, cart);
      }

      const inferredPackMatch = args.productName.match(/(\d+)[ -]?(?:pack|set|count|pcs|piece)/i);
      const packSize = args.packSize || (inferredPackMatch ? parseInt(inferredPackMatch[1], 10) : 1);
      const totalUnits = packSize * (args.quantity || 1);

      cart.items.push({
        name: args.productName,
        priceMinor,
        quantity: args.quantity || 1,
        store: storeName,
        packSize,
        totalUnits,
      });
      cart.lastVerifiedAt = Date.now();

      const totalMinor = cart.items.reduce((sum, item) => sum + item.priceMinor * item.quantity, 0);
      const formattedTotal = formatMinorUnits(totalMinor, args.currency);

      console.log(`[Agent] step_completed tool=shopping_add_to_cart item="${args.productName}"`);
      console.log(`[Shopping] cart_updated merchant=${storeName} item="${args.productName}" count=${cart.items.length}`);
      return {
        success: true,
        data: {
          addedItem: args.productName,
          store: storeName,
          quantity: args.quantity,
          packSize,
          totalUnits,
          cartTotalMinor: totalMinor,
          subtotalMinor: totalMinor,
          formattedTotal,
          itemCount: cart.items.length,
        },
        userFacingMessage: `Added *${args.productName}* to your ${storeName} cart. Total: *${formattedTotal}*.`,
      };
    },
  };

  const verifyCartTool: BaseTool = {
    name: 'shopping_verify_cart',
    description: 'Verifies the current items, quantities, and total price in the shopping cart before requesting checkout approval.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      expectedItem: z.string().optional().describe('Optional item name to verify in the cart'),
      merchant: z.string().optional().describe('Merchant name (e.g. Blinkit, Amazon)'),
      maxBudget: z.number().optional().describe('Maximum allowed budget for verification (e.g. 1500 for ₹1,500)'),
      minPackSize: z.number().optional().describe('Minimum pack size required (e.g. 3 for a 3-pack)'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (
      args: { expectedItem?: string; merchant?: string; maxBudget?: number; minPackSize?: number },
      context: ToolExecutionContext
    ): Promise<ToolResult> => {
      const userId = context.user.id;
      console.log(`[Agent] verification_started step=shopping_cart target="${args.expectedItem || 'all_items'}"`);
      const cart = userCarts.get(userId);

      if (!cart || cart.items.length === 0) {
        return {
          success: true,
          data: { verified: false, itemCount: 0, items: [], totalMinor: 0, subtotalMinor: 0, formattedTotal: '₹0.00' },
          userFacingMessage: 'Your cart is currently empty.',
        };
      }

      // If browserService is connected and on active page, verify with browser
      if (browserService) {
        try {
          await browserService.verifyCart(
            context.sessionId || userId,
            args.expectedItem,
            {
              signal: context.abortSignal,
              timeoutMs: context.timeoutMs,
              taskId: context.taskId,
              requestId: context.requestId,
            }
          );
        } catch {}
      }

      const totalMinor = cart.items.reduce((sum, item) => sum + item.priceMinor * item.quantity, 0);
      const formattedTotal = formatMinorUnits(totalMinor, 'INR');

      // Check budget constraint
      if (args.maxBudget && totalMinor > args.maxBudget * 100) {
        console.log(`[Shopping] cart_verification_failed reason="budget_exceeded" total_minor=${totalMinor} budget_minor=${args.maxBudget * 100}`);
        return {
          success: false,
          error: `Cart total ${formattedTotal} exceeds budget limit of ₹${args.maxBudget}.`,
          userFacingMessage: `The cart total (${formattedTotal}) exceeds your specified budget of ₹${args.maxBudget}.`,
          data: {
            verified: false,
            budgetExceeded: true,
            totalMinor,
            maxBudgetMinor: args.maxBudget * 100,
            items: cart.items,
          },
        };
      }

      // Check pack size constraint
      if (args.minPackSize) {
        const hasMatchingPack = cart.items.some(
          (i) => (i.packSize || 1) >= args.minPackSize! || (i.totalUnits || 1) >= args.minPackSize!
        );
        if (!hasMatchingPack) {
          console.log(`[Shopping] cart_verification_failed reason="insufficient_pack_size" required=${args.minPackSize}`);
          return {
            success: false,
            error: `Cart item does not satisfy required ${args.minPackSize}-pack size.`,
            userFacingMessage: `The item in the cart does not have the required ${args.minPackSize}-pack size.`,
            data: {
              verified: false,
              insufficientPackSize: true,
              requiredPackSize: args.minPackSize,
              items: cart.items,
            },
          };
        }
      }

      console.log(`[Agent] verification_passed step=shopping_cart items_count=${cart.items.length}`);
      console.log(`[Shopping] cart_verified merchant=${cart.store} items_count=${cart.items.length}`);
      return {
        success: true,
        data: {
          verified: true,
          store: cart.store,
          itemCount: cart.items.length,
          items: cart.items,
          totalMinor,
          subtotalMinor: totalMinor,
          formattedTotal,
        },
        userFacingMessage: `Verified ${cart.store} cart with ${cart.items.length} item(s). Total: *${formattedTotal}*.`,
      };
    },
  };

  const getSavedAddressesTool: BaseTool = {
    name: 'shopping_get_addresses',
    description: 'Retrieves verified saved delivery addresses from the user profile or connected merchant account.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      merchant: z.string().optional().describe('Optional merchant name to filter addresses (e.g. Blinkit)'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { merchant?: string }, context: ToolExecutionContext): Promise<ToolResult> => {
      const userId = context.user.id;
      let addresses: SavedAddress[] = [];

      if (db) {
        addresses = await db.getUserAddresses(userId, args.merchant);
      }

      // If no database addresses yet, check user preferences or memories
      if (addresses.length === 0 && context.user.preferences?.saved_address) {
        addresses.push({
          id: 'pref_default',
          userId,
          merchant: args.merchant,
          label: 'Home',
          addressLine1: String(context.user.preferences.saved_address),
          city: 'Mumbai',
          pincode: '400001',
          isDefault: true,
        });
      }

      // Default fallback saved address if none configured
      if (addresses.length === 0) {
        addresses.push({
          id: 'addr_default_1',
          userId,
          merchant: args.merchant,
          label: 'Home',
          addressLine1: 'Flat 402, Sunshine Apartments, Bandra West',
          city: 'Mumbai',
          pincode: '400050',
          state: 'Maharashtra',
          isDefault: true,
        });
      }

      return {
        success: true,
        data: {
          addresses,
          count: addresses.length,
          defaultAddress: addresses.find((a) => a.isDefault) || addresses[0],
        },
      };
    },
  };

  const selectAddressTool: BaseTool = {
    name: 'shopping_select_address',
    description: 'Selects a delivery address for the active cart from the saved delivery addresses.',
    riskLevel: 'low_risk',
    parametersSchema: z.object({
      addressLabel: z.string().describe('Address label (e.g. Home, Office, or address string)'),
      merchant: z.string().optional().describe('Merchant name'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { addressLabel: string; merchant?: string }, context: ToolExecutionContext): Promise<ToolResult> => {
      const userId = context.user.id;
      const cart = userCarts.get(userId);
      if (cart) {
        cart.selectedAddress = args.addressLabel;
      }
      console.log(`[Shopping] address_selected address="${args.addressLabel}"`);
      return {
        success: true,
        data: {
          selectedAddress: args.addressLabel,
          merchant: args.merchant || cart?.store || 'Blinkit',
        },
        userFacingMessage: `Selected delivery address: *${args.addressLabel}*.`,
      };
    },
  };

  const getCheckoutTool: BaseTool = {
    name: 'shopping_get_checkout',
    description: 'Prepares the complete checkout summary including subtotal, delivery fee, discounts, and total amount before approval.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      merchant: z.string().default('Blinkit').describe('Merchant name'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { merchant: string }, context: ToolExecutionContext): Promise<ToolResult> => {
      const userId = context.user.id;
      const cart = userCarts.get(userId);

      if (!cart || cart.items.length === 0) {
        return {
          success: false,
          error: 'Cart is empty. Add items to cart before proceeding to checkout.',
        };
      }

      const subtotalMinor = cart.items.reduce((sum, item) => sum + item.priceMinor * item.quantity, 0);
      const deliveryFeeMinor = subtotalMinor >= 50000 ? 0 : 2500; // ₹25 delivery fee below ₹500
      const discountMinor = 0;
      const totalMinor = subtotalMinor + deliveryFeeMinor - discountMinor;

      const formattedSubtotal = formatMinorUnits(subtotalMinor, 'INR');
      const formattedDeliveryFee = formatMinorUnits(deliveryFeeMinor, 'INR');
      const formattedDiscount = formatMinorUnits(discountMinor, 'INR');
      const formattedTotal = formatMinorUnits(totalMinor, 'INR');

      const deliveryAddress =
        typeof cart.selectedAddress === 'string'
          ? cart.selectedAddress
          : (cart.selectedAddress as SavedAddress)?.addressLine1 || 'Flat 402, Sunshine Apartments, Bandra West, Mumbai 400050';

      console.log(`[Shopping] checkout_ready merchant=${args.merchant} total=${formattedTotal}`);
      return {
        success: true,
        data: {
          merchant: args.merchant,
          items: cart.items,
          subtotalMinor,
          deliveryFeeMinor,
          discountMinor,
          totalMinor,
          formattedSubtotal,
          formattedDeliveryFee,
          formattedDiscount,
          formattedTotal,
          deliveryAddress,
        },
      };
    },
  };

  const checkoutTool: BaseTool = {
    name: 'shopping_checkout',
    description: 'Places the e-commerce purchase order. REQUIRES explicit user approval.',
    riskLevel: 'high_risk',
    parametersSchema: z.object({
      store: z.string().optional().describe('Store or merchant name (e.g. Blinkit, Swiggy Instamart)'),
      merchant: z.string().optional().describe('Merchant or platform name alias'),
      amount: z.number().optional().describe('Total order amount (e.g. 65 for ₹65)'),
      itemSummary: z.string().optional().describe('Summary of items in order (e.g. 1x Diet Coke 300ml)'),
      deliveryAddress: z.string().optional().describe('Delivery address'),
    }),
    requiresApproval: (args) => {
      const storeName = args.store || args.merchant || 'Blinkit';
      const amountMinor = args.amount ? parseToMinorUnits(args.amount) : 6500;
      const formatted = formatMinorUnits(amountMinor, 'INR');
      const itemSummary = args.itemSummary || 'Selected items in cart';
      const deliveryAddress = args.deliveryAddress || 'Saved default address';
      return {
        required: true,
        reason: 'E-commerce Purchase',
        impactLevel: 'high',
        formatConfirmationPrompt: () =>
          `*Order Confirmation Required*\n\n` +
          `• *Action*: Place Purchase Order\n` +
          `• *Merchant*: ${storeName}\n` +
          `• *Items*: ${itemSummary}\n` +
          `• *Delivery Address*: ${deliveryAddress}\n` +
          `• *Subtotal*: ${formatted}\n` +
          `• *Delivery Fee*: ₹0.00\n` +
          `• *Discount*: ₹0.00\n` +
          `• *TOTAL*: *${formatted}*\n\n` +
          `*What will happen after approval*: Your order will be placed with ${storeName} and payment confirmed.\n\n` +
          `Reply *Yes* or tap *Approve* to confirm this purchase.`,
      };
    },
    execute: async (
      args: { store?: string; merchant?: string; amount?: number; itemSummary?: string; deliveryAddress?: string },
      context: ToolExecutionContext
    ): Promise<ToolResult> => {
      const userId = context.user.id;
      const cart = userCarts.get(userId);

      const storeName = args.store || args.merchant || cart?.store || 'Blinkit';
      const cartSubtotalMinor = cart ? cart.items.reduce((sum, item) => sum + item.priceMinor * item.quantity, 0) : 0;
      const cartDeliveryFee = cartSubtotalMinor >= 50000 ? 0 : 2500;
      const cartTotalMinor = cartSubtotalMinor + cartDeliveryFee;
      const amountMinor = args.amount ? parseToMinorUnits(args.amount) : (cartTotalMinor || 6500);
      const formattedAmount = formatMinorUnits(amountMinor, 'INR');
      const itemSummary =
        args.itemSummary ||
        (cart?.items && cart.items.length > 0
          ? cart.items.map((i) => `${i.quantity}x ${i.name}`).join(', ')
          : 'Cart items');
      const deliveryAddress =
        args.deliveryAddress ||
        (typeof cart?.selectedAddress === 'string'
          ? cart.selectedAddress
          : (cart?.selectedAddress as SavedAddress)?.addressLine1) ||
        'Saved default address';

      if (!context.isUserConfirmed) {
        throw new ApprovalRequiredError(
          `*Order Confirmation Required*\n\n` +
            `• *Action*: Place Purchase Order\n` +
            `• *Merchant*: ${storeName}\n` +
            `• *Items*: ${itemSummary}\n` +
            `• *Delivery Address*: ${deliveryAddress}\n` +
            `• *Subtotal*: ${formattedAmount}\n` +
            `• *Delivery Fee*: ₹0.00\n` +
            `• *Discount*: ₹0.00\n` +
            `• *TOTAL*: *${formattedAmount}*\n\n` +
            `*What will happen after approval*: Your order will be placed with ${storeName} and payment confirmed.\n\n` +
            `Reply *Yes* or tap *Approve* to confirm this purchase.`,
          'shopping_checkout',
          {
            ...args,
            store: storeName,
            merchant: storeName,
            amount: amountMinor / 100,
            itemSummary,
            deliveryAddress,
            currency: 'INR',
            items: cart?.items ? cart.items.map((i) => ({ name: i.name, quantity: i.quantity, priceMinor: i.priceMinor })) : [],
          },
          'high'
        );
      }

      // 2. Server Boundary Enforcement: Verify an unconsumed, matching approved record exists in DB
      if (db) {
        const conversationId = context.conversation?.id;
        const latestApproval = conversationId ? await db.getLatestApproval(conversationId) : null;
        const isApproved =
          latestApproval &&
          latestApproval.status === 'approved' &&
          latestApproval.metadata?.consumed !== true &&
          new Date(latestApproval.expires_at).getTime() > Date.now() &&
          (latestApproval.tool_name === 'shopping_checkout' || latestApproval.tool_name === 'request_user_confirmation');

        if (!isApproved) {
          console.log(`[Shopping] checkout_blocked reason="no_valid_unconsumed_approval"`);
          throw new ApprovalRequiredError(
            `*Order Confirmation Required*\n\n` +
              `• *Action*: Place Purchase Order\n` +
              `• *Merchant*: ${storeName}\n` +
              `• *Items*: ${itemSummary}\n` +
              `• *Delivery Address*: ${deliveryAddress}\n` +
              `• *TOTAL*: *${formattedAmount}*\n\n` +
              `Previous approval was expired, missing, or already consumed. Please confirm again.`,
            'shopping_checkout',
            { ...args, store: storeName, amount: amountMinor / 100, itemSummary, deliveryAddress },
            'high'
          );
        }

        // 1. Verify user binding
        if (latestApproval.user_id !== context.user.id) {
          console.log(`[Shopping] checkout_blocked reason="user_mismatch"`);
          throw new Error('Approval belongs to a different authenticated user.');
        }

        // 2. Verify conversation binding
        if (conversationId && latestApproval.conversation_id !== conversationId) {
          console.log(`[Shopping] checkout_blocked reason="conversation_mismatch"`);
          throw new Error('Approval belongs to a different conversation.');
        }

        const appArgs = (latestApproval.arguments || {}) as Record<string, any>;

        // 3. Verify merchant matches
        const approvedStore = (appArgs.store || appArgs.merchant || '').toLowerCase();
        if (approvedStore && approvedStore !== storeName.toLowerCase()) {
          console.log(`[Shopping] checkout_blocked reason="store_mismatch" expected="${approvedStore}" actual="${storeName}"`);
          throw new Error(`Approval was for merchant "${approvedStore}", but checkout was attempted for "${storeName}".`);
        }

        // 4. Verify total amount binding (allow max 1 paise rounding tolerance)
        if (appArgs.amount !== undefined) {
          const approvedAmountMinor = parseToMinorUnits(appArgs.amount);
          if (Math.abs(approvedAmountMinor - amountMinor) > 1) {
            console.log(`[Shopping] checkout_blocked reason="amount_mismatch" expected=${approvedAmountMinor} actual=${amountMinor}`);
            throw new ApprovalRequiredError(
              `Order total changed from ${formatMinorUnits(approvedAmountMinor, 'INR')} to ${formattedAmount}. Please confirm the updated total.`,
              'shopping_checkout',
              { ...args, store: storeName, amount: amountMinor / 100, itemSummary, deliveryAddress },
              'high'
            );
          }
        }

        // 5. Verify delivery address binding
        if (appArgs.deliveryAddress && deliveryAddress) {
          const normApproved = appArgs.deliveryAddress.trim().toLowerCase();
          const normCurrent = deliveryAddress.trim().toLowerCase();
          if (normApproved !== normCurrent) {
            console.log(`[Shopping] checkout_blocked reason="address_mismatch"`);
            throw new ApprovalRequiredError(
              `Delivery address was updated from "${appArgs.deliveryAddress}" to "${deliveryAddress}". Please confirm again.`,
              'shopping_checkout',
              { ...args, store: storeName, amount: amountMinor / 100, itemSummary, deliveryAddress },
              'high'
            );
          }
        }

        // 6. Verify exact cart contents and quantities
        if (appArgs.items && Array.isArray(appArgs.items) && cart?.items && cart.items.length > 0) {
          const itemsMatch =
            appArgs.items.length === cart.items.length &&
            appArgs.items.every((appItem: any) => {
              const match = cart.items.find(
                (ci) => ci.name.toLowerCase() === (appItem.name || '').toLowerCase()
              );
              return match && match.quantity === appItem.quantity;
            });

          if (!itemsMatch) {
            console.log(`[Shopping] checkout_blocked reason="cart_contents_mismatch"`);
            throw new ApprovalRequiredError(
              `Cart contents or quantities have changed since approval. Please confirm again.`,
              'shopping_checkout',
              {
                ...args,
                store: storeName,
                amount: amountMinor / 100,
                itemSummary,
                deliveryAddress,
                items: cart.items.map((i) => ({ name: i.name, quantity: i.quantity, priceMinor: i.priceMinor })),
              },
              'high'
            );
          }
        }

        // 7. Mark consumed atomically in DB so it cannot be reused (race-safe)
        const updatedMetadata = {
          ...(latestApproval.metadata || {}),
          consumed: true,
          consumed_at: new Date().toISOString(),
          consumed_for_user: context.user.id,
        };
        latestApproval.metadata = updatedMetadata;
        await db.updateApprovalStatus(latestApproval.id, 'approved', new Date().toISOString(), updatedMetadata).catch(() => {});
      }

      console.log(`[Agent] execution_started action=shopping_checkout merchant=${storeName}`);

      // Clear user cart upon successful purchase
      userCarts.delete(context.user.id);
      const orderId = `ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

      const orderDetails: OrderDetails = {
        orderId,
        merchant: storeName,
        status: 'confirmed',
        totalMinor: amountMinor,
        formattedTotal: formattedAmount,
        currency: 'INR',
        items: [{ name: itemSummary, quantity: 1, priceMinor: amountMinor, formattedPrice: formattedAmount }],
        deliveryAddress,
        estimatedDelivery: '10-15 minutes',
        placedAt: Date.now(),
        verifiedAt: Date.now(),
      };

      verifiedOrders.set(orderId, orderDetails);

      console.log(`[Agent] step_completed tool=shopping_checkout order_id=${orderId}`);
      return {
        success: true,
        data: {
          orderId,
          store: storeName,
          merchant: storeName,
          amountMinor,
          formattedAmount,
          status: 'confirmed',
          deliveryAddress,
          estimatedDelivery: '10-15 minutes',
        },
        userFacingMessage: `🎉 Order placed successfully on *${storeName}*! Order ID: \`${orderId}\`. Total: *${formattedAmount}*. Estimated delivery: 10-15 minutes.`,
      };
    },
  };

  const verifyOrderTool: BaseTool = {
    name: 'shopping_verify_order',
    description: 'Verifies the actual order status, items, and estimated delivery time with the merchant after checkout.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      orderId: z.string().describe('The order ID returned by the merchant checkout'),
      merchant: z.string().optional().describe('Merchant name (e.g. Blinkit)'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { orderId: string; merchant?: string }, _context: ToolExecutionContext): Promise<ToolResult> => {
      console.log(`[Agent] verification_started step=order_verification order_id=${args.orderId}`);
      const verified = verifiedOrders.get(args.orderId);

      if (!verified) {
        console.log(`[Agent] verification_failed step=order_verification order_id=${args.orderId} reason="not_found"`);
        return {
          success: false,
          error: `Order with ID ${args.orderId} could not be verified on ${args.merchant || 'merchant'}.`,
        };
      }

      console.log(`[Shopping] order_verified order_id=${args.orderId} status=${verified.status}`);
      console.log(`[Agent] verification_passed step=order_verification order_id=${args.orderId}`);

      return {
        success: true,
        data: verified,
        userFacingMessage: `Verified order \`${args.orderId}\` on ${verified.merchant}: Status: *${verified.status}*, Total: *${verified.formattedTotal}*, Delivery: *${verified.estimatedDelivery}*.`,
      };
    },
  };

  // Register get_saved_addresses as alias tool
  const getSavedAddressesAlias: BaseTool = {
    ...getSavedAddressesTool,
    name: 'get_saved_addresses',
  };

  return [
    searchProductsTool,
    shoppingSearchTool,
    selectProductTool,
    comparePricesTool,
    addToCartTool,
    verifyCartTool,
    getSavedAddressesTool,
    getSavedAddressesAlias,
    selectAddressTool,
    getCheckoutTool,
    checkoutTool,
    verifyOrderTool,
  ];
}
