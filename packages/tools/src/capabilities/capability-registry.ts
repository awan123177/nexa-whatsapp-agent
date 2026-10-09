import { ServiceCapability, IntegrationTier } from '@nexa/shared';

export class CapabilityRegistry {
  private services = new Map<string, ServiceCapability>();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    const defaults: ServiceCapability[] = [
      {
        serviceId: 'google_workspace',
        name: 'Google Workspace (Gmail & Calendar)',
        description: 'Official Google OAuth integration for emails, meetings, and calendar scheduling.',
        primaryTier: 'TIER_1_OFFICIAL_API',
        fallbackTier: 'TIER_4_USER_ASSISTED',
        supportedActions: ['send_email', 'read_emails', 'create_calendar_event', 'list_calendar_events'],
        requiresAuth: true,
        requiresPaymentApproval: false,
        status: 'active',
      },
      {
        serviceId: 'upi_wallet',
        name: 'NEXA UPI & Wallet Payments',
        description: 'Official payment provider integration for UPI QR, peer-to-peer transfers, and wallet balance.',
        primaryTier: 'TIER_1_OFFICIAL_API',
        fallbackTier: 'TIER_4_USER_ASSISTED',
        supportedActions: ['wallet_balance', 'wallet_transfer', 'wallet_topup', 'approval_action'],
        requiresAuth: true,
        requiresPaymentApproval: true,
        status: 'active',
      },
      {
        serviceId: 'swiggy_instamart',
        name: 'Swiggy Instamart',
        description: 'Instant grocery delivery via adaptive browser automation with strict merchant locking.',
        primaryTier: 'TIER_3_BROWSER_AUTOMATION',
        fallbackTier: 'TIER_4_USER_ASSISTED',
        supportedActions: ['shopping_search', 'shopping_add_to_cart', 'shopping_verify_cart', 'shopping_checkout'],
        requiresAuth: true,
        requiresPaymentApproval: true,
        status: 'active',
      },
      {
        serviceId: 'blinkit',
        name: 'Blinkit',
        description: 'Quick-commerce grocery ordering via adaptive browser automation.',
        primaryTier: 'TIER_3_BROWSER_AUTOMATION',
        fallbackTier: 'TIER_4_USER_ASSISTED',
        supportedActions: ['shopping_search', 'shopping_add_to_cart', 'shopping_verify_cart', 'shopping_checkout'],
        requiresAuth: true,
        requiresPaymentApproval: true,
        status: 'active',
      },
      {
        serviceId: 'zepto',
        name: 'Zepto',
        description: '10-minute grocery delivery via adaptive browser automation.',
        primaryTier: 'TIER_3_BROWSER_AUTOMATION',
        fallbackTier: 'TIER_4_USER_ASSISTED',
        supportedActions: ['shopping_search', 'shopping_add_to_cart', 'shopping_verify_cart', 'shopping_checkout'],
        requiresAuth: true,
        requiresPaymentApproval: true,
        status: 'active',
      },
      {
        serviceId: 'amazon',
        name: 'Amazon India',
        description: 'E-commerce shopping and price tracking via browser automation.',
        primaryTier: 'TIER_3_BROWSER_AUTOMATION',
        fallbackTier: 'TIER_4_USER_ASSISTED',
        supportedActions: ['shopping_search', 'shopping_add_to_cart', 'shopping_verify_cart'],
        requiresAuth: true,
        requiresPaymentApproval: true,
        status: 'active',
      },
      {
        serviceId: 'travel_search',
        name: 'Flight & Hotel Search',
        description: 'Travel research and live pricing using partner adapters and search APIs.',
        primaryTier: 'TIER_2_ADAPTER_API',
        fallbackTier: 'TIER_3_BROWSER_AUTOMATION',
        supportedActions: ['search_flights', 'search_hotels'],
        requiresAuth: false,
        requiresPaymentApproval: false,
        status: 'active',
      },
    ];

    for (const service of defaults) {
      this.services.set(service.serviceId, service);
    }
  }

  public register(service: ServiceCapability): void {
    this.services.set(service.serviceId, service);
  }

  public getService(serviceId: string): ServiceCapability | undefined {
    return this.services.get(serviceId);
  }

  public listServices(): ServiceCapability[] {
    return Array.from(this.services.values());
  }

  public getExecutionPath(serviceId: string): IntegrationTier[] {
    const service = this.services.get(serviceId);
    if (!service) {
      return ['TIER_3_BROWSER_AUTOMATION', 'TIER_4_USER_ASSISTED'];
    }
    const path: IntegrationTier[] = [service.primaryTier];
    if (service.fallbackTier && service.fallbackTier !== service.primaryTier) {
      path.push(service.fallbackTier);
    }
    return path;
  }
}

export const capabilityRegistry = new CapabilityRegistry();
