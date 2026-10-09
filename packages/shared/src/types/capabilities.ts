export type IntegrationTier =
  | 'TIER_1_OFFICIAL_API'
  | 'TIER_2_ADAPTER_API'
  | 'TIER_3_BROWSER_AUTOMATION'
  | 'TIER_4_USER_ASSISTED';

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
}
