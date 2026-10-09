export type IntegrationTier =
  | 'TIER_1_OFFICIAL_API'
  | 'TIER_2_ADAPTER_API'
  | 'TIER_3_BROWSER_AUTOMATION'
  | 'TIER_4_USER_ASSISTED';

export type CapabilitySideEffect =
  | 'none'
  | 'read_only'
  | 'state_mutation'
  | 'financial_transaction'
  | 'external_communication';

export type VerificationMethod =
  | 'response_schema'
  | 'dom_assertion'
  | 'user_confirmation'
  | 'api_verification'
  | 'source_cross_check';

export interface CapabilityLimits {
  timeoutMs?: number;
  maxCallsPerTurn?: number;
  maxConcurrency?: number;
  rateLimitPerMin?: number;
}

export interface CapabilityDefinition {
  id: string;
  serviceId: string;
  name: string;
  description: string;
  tier: IntegrationTier;
  fallbackTier?: IntegrationTier;
  supportedActions: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiresAuth: boolean;
  requiresPaymentApproval: boolean;
  sideEffect: CapabilitySideEffect;
  verificationMethods: VerificationMethod[];
  limits: CapabilityLimits;
  errorStates: string[];
  recoveryStates: string[];
  status: 'active' | 'degraded' | 'maintenance';
}

export interface ServiceCapability {
  serviceId: string;
  name: string;
  description: string;
  primaryTier: IntegrationTier;
  fallbackTier?: IntegrationTier;
  supportedActions: string[];
  requiresAuth: boolean;
  requiresPaymentApproval: boolean;
  status: 'active' | 'degraded' | 'maintenance';
  capabilities?: CapabilityDefinition[];
}

