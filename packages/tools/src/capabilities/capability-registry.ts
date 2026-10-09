import {
  ServiceCapability,
  IntegrationTier,
  CapabilityDefinition,
  MessageIntent,
} from '@nexa/shared';

export class CapabilityRegistry {
  private services = new Map<string, ServiceCapability>();
  private capabilities = new Map<string, CapabilityDefinition>();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    const defaultServices: ServiceCapability[] = [
      {
        serviceId: 'youtube_intelligence',
        name: 'YouTube Intelligence & Video Analysis',
        description: 'First-class YouTube video search, caption/transcript parsing, product and benchmark identification, and multi-source video comparisons.',
        primaryTier: 'TIER_1_OFFICIAL_API',
        fallbackTier: 'TIER_2_ADAPTER_API',
        supportedActions: [
          'youtube_search',
          'youtube_get_transcript',
          'youtube_analyze_video',
          'youtube_compare_reviews',
          'youtube_research_report',
        ],
        requiresAuth: false,
        requiresPaymentApproval: false,
        status: 'active',
      },
      {
        serviceId: 'multimodal_understanding',
        name: 'Universal Multimodal Media Understanding',
        description: 'Multimodal processing of images, voice notes, video clips, and documents with prompt-injection defense.',
        primaryTier: 'TIER_1_OFFICIAL_API',
        fallbackTier: 'TIER_2_ADAPTER_API',
        supportedActions: ['multimodal_analyze_media', 'document_extract_text'],
        requiresAuth: false,
        requiresPaymentApproval: false,
        status: 'active',
      },
      {
        serviceId: 'web_research',
        name: 'Live Web Research',
        description: 'Live web search for information retrieval, news, documentation, and real-time facts.',
        primaryTier: 'TIER_2_ADAPTER_API',
        supportedActions: ['web_search'],
        requiresAuth: false,
        requiresPaymentApproval: false,
        status: 'active',
      },
      {
        serviceId: 'browser_automation',
        name: 'Universal Computer Use & Browser Automation',
        description: 'Playwright headless browser navigation, page inspection, accessibility trees, and interactions.',
        primaryTier: 'TIER_3_BROWSER_AUTOMATION',
        fallbackTier: 'TIER_4_USER_ASSISTED',
        supportedActions: [
          'browser_open',
          'browser_read',
          'browser_click',
          'browser_type',
          'browser_scroll',
          'browser_wait',
          'browser_screenshot',
        ],
        requiresAuth: false,
        requiresPaymentApproval: false,
        status: 'active',
      },
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

    for (const service of defaultServices) {
      this.services.set(service.serviceId, service);
    }

    // Register detailed capability entries
    const defaultCapabilities: CapabilityDefinition[] = [
      {
        id: 'cap_youtube_search',
        serviceId: 'youtube_intelligence',
        name: 'YouTube Search',
        description: 'Searches YouTube videos by topic, creator, product, or model with relevance explanation.',
        tier: 'TIER_1_OFFICIAL_API',
        fallbackTier: 'TIER_2_ADAPTER_API',
        supportedActions: ['youtube_search'],
        requiresAuth: false,
        requiresPaymentApproval: false,
        sideEffect: 'read_only',
        verificationMethods: ['response_schema', 'source_cross_check'],
        limits: { timeoutMs: 10000, maxCallsPerTurn: 3 },
        errorStates: ['QUOTA_EXCEEDED', 'NETWORK_TIMEOUT', 'ZERO_RESULTS'],
        recoveryStates: ['FALLBACK_WEB_SEARCH', 'RETRY_WITH_SYNONYMS'],
        status: 'active',
      },
      {
        id: 'cap_youtube_analysis',
        serviceId: 'youtube_intelligence',
        name: 'YouTube Video & Transcript Analysis',
        description: 'Parses accessible captions/transcripts, identifying products, models, sponsors, and benchmark measurements.',
        tier: 'TIER_1_OFFICIAL_API',
        fallbackTier: 'TIER_2_ADAPTER_API',
        supportedActions: ['youtube_get_transcript', 'youtube_analyze_video', 'youtube_compare_reviews', 'youtube_research_report'],
        requiresAuth: false,
        requiresPaymentApproval: false,
        sideEffect: 'read_only',
        verificationMethods: ['response_schema'],
        limits: { timeoutMs: 15000, maxCallsPerTurn: 3 },
        errorStates: ['TRANSCRIPT_UNAVAILABLE', 'VIDEO_RESTRICTED', 'INVALID_ID'],
        recoveryStates: ['FALLBACK_METADATA_ANALYSIS', 'TRY_ALTERNATIVE_SOURCE'],
        status: 'active',
      },
      {
        id: 'cap_multimodal_media',
        serviceId: 'multimodal_understanding',
        name: 'Multimodal Media Analysis',
        description: 'Analyzes images, documents, audio, and video with prompt injection defense.',
        tier: 'TIER_1_OFFICIAL_API',
        supportedActions: ['multimodal_analyze_media', 'document_extract_text'],
        requiresAuth: false,
        requiresPaymentApproval: false,
        sideEffect: 'read_only',
        verificationMethods: ['response_schema'],
        limits: { timeoutMs: 20000, maxCallsPerTurn: 2 },
        errorStates: ['FILE_TOO_LARGE', 'UNSUPPORTED_MIME', 'DECODE_ERROR'],
        recoveryStates: ['REQUEST_SMALLER_FILE', 'CONVERT_FORMAT'],
        status: 'active',
      },
      {
        id: 'cap_web_search',
        serviceId: 'web_research',
        name: 'Live Web Search',
        description: 'Queries the live web via DuckDuckGo search provider.',
        tier: 'TIER_2_ADAPTER_API',
        supportedActions: ['web_search'],
        requiresAuth: false,
        requiresPaymentApproval: false,
        sideEffect: 'read_only',
        verificationMethods: ['response_schema'],
        limits: { timeoutMs: 10000, maxCallsPerTurn: 3 },
        errorStates: ['TIMEOUT', 'NETWORK_ERROR', 'ZERO_RESULTS'],
        recoveryStates: ['TWO_STRIKE_DISABLE', 'RETRY_WITH_REPHRASING'],
        status: 'active',
      },
      {
        id: 'cap_wallet_payment',
        serviceId: 'upi_wallet',
        name: 'Wallet & UPI Payment',
        description: 'Debits user wallet balance or triggers UPI transfer with strict approval requirements.',
        tier: 'TIER_1_OFFICIAL_API',
        supportedActions: ['wallet_transfer', 'wallet_balance'],
        requiresAuth: true,
        requiresPaymentApproval: true,
        sideEffect: 'financial_transaction',
        verificationMethods: ['user_confirmation', 'api_verification'],
        limits: { timeoutMs: 10000, maxCallsPerTurn: 1 },
        errorStates: ['INSUFFICIENT_FUNDS', 'UNCONFIRMED_USER', 'LIMIT_EXCEEDED'],
        recoveryStates: ['PROMPT_APPROVAL', 'REQUEST_TOPUP'],
        status: 'active',
      },
    ];

    for (const cap of defaultCapabilities) {
      this.capabilities.set(cap.id, cap);
    }
  }

  public register(service: ServiceCapability): void {
    this.services.set(service.serviceId, service);
  }

  public registerCapability(cap: CapabilityDefinition): void {
    this.capabilities.set(cap.id, cap);
  }

  public getService(serviceId: string): ServiceCapability | undefined {
    return this.services.get(serviceId);
  }

  public getCapability(id: string): CapabilityDefinition | undefined {
    return this.capabilities.get(id);
  }

  public listServices(): ServiceCapability[] {
    return Array.from(this.services.values());
  }

  public listCapabilities(): CapabilityDefinition[] {
    return Array.from(this.capabilities.values());
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

  /**
   * Intelligently discovers eligible capability definitions matching a detected intent.
   */
  public findCapabilitiesForIntent(intent: MessageIntent): CapabilityDefinition[] {
    switch (intent) {
      case 'YOUTUBE_RESEARCH':
        return Array.from(this.capabilities.values()).filter(
          (c) => c.serviceId === 'youtube_intelligence' || c.serviceId === 'web_research'
        );
      case 'MULTIMODAL_ANALYSIS':
        return Array.from(this.capabilities.values()).filter(
          (c) => c.serviceId === 'multimodal_understanding' || c.serviceId === 'web_research'
        );
      case 'WALLET':
        return Array.from(this.capabilities.values()).filter((c) => c.serviceId === 'upi_wallet');
      case 'RESEARCH':
        return Array.from(this.capabilities.values()).filter((c) => c.serviceId === 'web_research');
      default:
        return Array.from(this.capabilities.values());
    }
  }

  /**
   * Returns list of allowed tool names for a specific intent to prevent blind tool exposure.
   */
  public getEligibleToolNamesForIntent(intent: MessageIntent): string[] {
    switch (intent) {
      case 'CONVERSATION':
      case 'CONTROL_STOP':
      case 'CONTROL_CANCEL':
      case 'CONTROL_WAIT':
      case 'CONTROL_RESUME':
        return []; // Zero tools for pure conversation / control

      case 'YOUTUBE_RESEARCH':
        return [
          'youtube_search',
          'youtube_get_transcript',
          'youtube_analyze_video',
          'youtube_compare_reviews',
          'youtube_research_report',
          'web_search',
        ];

      case 'MULTIMODAL_ANALYSIS':
        return ['multimodal_analyze_media', 'document_extract_text', 'web_search'];

      case 'RESEARCH':
        return ['web_search', 'youtube_search'];

      case 'SHOPPING':
        return [
          'shopping_search',
          'shopping_add_to_cart',
          'shopping_verify_cart',
          'shopping_get_checkout',
          'shopping_checkout',
          'browser_open',
          'browser_read',
          'browser_click',
          'browser_type',
          'browser_screenshot',
          'approval_action',
        ];

      case 'TRAVEL':
        return ['search_flights', 'search_hotels', 'book_flight', 'book_hotel', 'approval_action'];

      case 'WALLET':
        return ['wallet_balance', 'wallet_transfer', 'wallet_topup', 'approval_action'];

      case 'EMAIL':
        return ['send_email', 'read_emails'];

      case 'CALENDAR':
        return ['create_calendar_event', 'list_calendar_events'];

      case 'REMINDER':
        return ['create_reminder', 'list_reminders'];

      case 'BROWSER_AUTOMATION':
        return [
          'browser_open',
          'browser_read',
          'browser_click',
          'browser_type',
          'browser_scroll',
          'browser_wait',
          'browser_screenshot',
        ];

      default:
        // Broad default for OTHER
        return [
          'web_search',
          'youtube_search',
          'youtube_get_transcript',
          'youtube_analyze_video',
          'multimodal_analyze_media',
          'browser_open',
          'browser_read',
          'browser_screenshot',
        ];
    }
  }
}

export const capabilityRegistry = new CapabilityRegistry();
