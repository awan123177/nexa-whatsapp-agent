export type MerchantAuthCapability = 'phone_otp' | 'oauth' | 'password' | 'session_token' | 'none';
export type MerchantPaymentCapability = 'upi' | 'card' | 'wallet' | 'cod' | 'netbanking';
export type MerchantAvailability = 'active' | 'degraded' | 'unavailable';

export interface ResolvedMerchant {
  merchantId: string;
  name: string;
  aliases: string[];
  canonicalUrl: string;
  supportedActions: string[];
  authenticationCapability: MerchantAuthCapability;
  shoppingCapability: boolean;
  paymentCapability: MerchantPaymentCapability[];
  currentAvailability: MerchantAvailability;
}

export interface SavedAddress {
  id: string;
  userId: string;
  merchant?: string;
  label: string; // e.g. "Home", "Office"
  recipientName?: string;
  phone?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  pincode: string;
  state?: string;
  isDefault: boolean;
  metadata?: Record<string, unknown>;
}

export interface OrderDetails {
  orderId: string;
  merchant: string;
  status: 'confirmed' | 'pending' | 'processing' | 'cancelled' | 'failed';
  totalMinor: number;
  formattedTotal: string;
  currency: string;
  items: Array<{
    name: string;
    quantity: number;
    priceMinor?: number;
    formattedPrice?: string;
  }>;
  deliveryAddress?: string;
  estimatedDelivery?: string;
  placedAt: number;
  verifiedAt: number;
}
