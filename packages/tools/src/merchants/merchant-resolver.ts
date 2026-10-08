import { ResolvedMerchant } from '@nexa/shared';

export const SUPPORTED_MERCHANTS: ResolvedMerchant[] = [
  {
    merchantId: 'blinkit',
    name: 'Blinkit',
    aliases: ['blinkit', 'grofers', 'blink it', 'blink-it'],
    canonicalUrl: 'https://blinkit.com',
    supportedActions: ['search', 'cart', 'address', 'checkout', 'order_status'],
    authenticationCapability: 'phone_otp',
    shoppingCapability: true,
    paymentCapability: ['upi', 'card', 'wallet', 'cod'],
    currentAvailability: 'active',
  },
  {
    merchantId: 'zepto',
    name: 'Zepto',
    aliases: ['zepto', 'zeptonow', 'zepto now'],
    canonicalUrl: 'https://www.zeptonow.com',
    supportedActions: ['search', 'cart', 'address', 'checkout', 'order_status'],
    authenticationCapability: 'phone_otp',
    shoppingCapability: true,
    paymentCapability: ['upi', 'card', 'wallet'],
    currentAvailability: 'active',
  },
  {
    merchantId: 'amazon',
    name: 'Amazon',
    aliases: ['amazon', 'amazon.in', 'amazon in', 'amazon india'],
    canonicalUrl: 'https://www.amazon.in',
    supportedActions: ['search', 'cart', 'address', 'checkout', 'order_status'],
    authenticationCapability: 'password',
    shoppingCapability: true,
    paymentCapability: ['upi', 'card', 'netbanking', 'cod'],
    currentAvailability: 'active',
  },
  {
    merchantId: 'flipkart',
    name: 'Flipkart',
    aliases: ['flipkart', 'flipkart.com', 'flip kart'],
    canonicalUrl: 'https://www.flipkart.com',
    supportedActions: ['search', 'cart', 'address', 'checkout', 'order_status'],
    authenticationCapability: 'phone_otp',
    shoppingCapability: true,
    paymentCapability: ['upi', 'card', 'cod'],
    currentAvailability: 'active',
  },
  {
    merchantId: 'swiggy',
    name: 'Swiggy',
    aliases: ['swiggy', 'instamart', 'swiggy instamart'],
    canonicalUrl: 'https://www.swiggy.com',
    supportedActions: ['search', 'cart', 'address', 'checkout', 'order_status'],
    authenticationCapability: 'phone_otp',
    shoppingCapability: true,
    paymentCapability: ['upi', 'card', 'wallet'],
    currentAvailability: 'active',
  },
  {
    merchantId: 'makemytrip',
    name: 'MakeMyTrip',
    aliases: ['makemytrip', 'mmt', 'make my trip'],
    canonicalUrl: 'https://www.makemytrip.com',
    supportedActions: ['search', 'booking', 'itinerary', 'order_status'],
    authenticationCapability: 'phone_otp',
    shoppingCapability: false,
    paymentCapability: ['upi', 'card', 'netbanking'],
    currentAvailability: 'active',
  },
  {
    merchantId: 'booking_com',
    name: 'Booking.com',
    aliases: ['booking.com', 'booking', 'bookingcom'],
    canonicalUrl: 'https://www.booking.com',
    supportedActions: ['search', 'booking', 'order_status'],
    authenticationCapability: 'oauth',
    shoppingCapability: false,
    paymentCapability: ['card'],
    currentAvailability: 'active',
  },
];

export class MerchantResolver {
  private merchants: ResolvedMerchant[];

  constructor(customMerchants?: ResolvedMerchant[]) {
    this.merchants = customMerchants || SUPPORTED_MERCHANTS;
  }

  /**
   * Resolves a user request, query, or store name into a canonical supported merchant.
   * Logs requested, resolved, and canonical_url telemetry.
   */
  public resolve(input: string): ResolvedMerchant | null {
    if (!input || typeof input !== 'string') return null;
    const cleanInput = input.trim().toLowerCase();

    console.log(`[Merchant] requested merchant="${cleanInput}"`);

    // 1. Direct match on merchantId or name
    for (const m of this.merchants) {
      if (
        cleanInput === m.merchantId.toLowerCase() ||
        cleanInput === m.name.toLowerCase()
      ) {
        console.log(`[Merchant] resolved merchant=${m.name}`);
        console.log(`[Merchant] canonical_url url=${m.canonicalUrl}`);
        return m;
      }
    }

    // 2. Direct match on aliases
    for (const m of this.merchants) {
      if (m.aliases.some((alias) => alias.toLowerCase() === cleanInput)) {
        console.log(`[Merchant] resolved merchant=${m.name}`);
        console.log(`[Merchant] canonical_url url=${m.canonicalUrl}`);
        return m;
      }
    }

    // 3. Substring / sentence detection (e.g. "Order a Diet Coke from Blinkit")
    // Use word boundaries so "amazon" matches "from amazon" but not "amazing"
    for (const m of this.merchants) {
      for (const alias of m.aliases) {
        const regex = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (regex.test(cleanInput)) {
          console.log(`[Merchant] resolved merchant=${m.name}`);
          console.log(`[Merchant] canonical_url url=${m.canonicalUrl}`);
          return m;
        }
      }
    }

    return null;
  }

  public getAllSupportedMerchants(): ResolvedMerchant[] {
    return [...this.merchants];
  }

  public isMerchantSupported(name: string): boolean {
    return this.resolve(name) !== null;
  }
}

export const merchantResolver = new MerchantResolver();
