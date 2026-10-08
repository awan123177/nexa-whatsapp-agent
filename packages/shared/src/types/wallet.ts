/**
 * NEXA Wallet Architecture Types & Ledger Entities
 *
 * Money is ALWAYS represented in integer minor units (e.g. paise, cents).
 * ₹499 is stored as 49900 paise. Floating point numbers are strictly forbidden.
 */

export type WalletStatus = 'active' | 'frozen' | 'closed';

export type WalletTransactionType =
  | 'topup'
  | 'payment'
  | 'transfer'
  | 'refund'
  | 'adjustment';

export type WalletTransactionStatus =
  | 'PENDING'
  | 'AUTHORIZED'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED';

export type TopupStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';

export type PaymentRequestStatus =
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'failed';

export interface Wallet {
  id: string;
  user_id: string;
  currency: string;
  balance_minor: number; // Integer minor units (e.g., 50000 = ₹500.00)
  status: WalletStatus;
  created_at: string;
  updated_at: string;
}

export interface WalletTransaction {
  id: string;
  wallet_id: string;
  idempotency_key: string;
  type: WalletTransactionType;
  amount_minor: number; // Positive for credits, negative for debits (or magnitude + direction)
  currency: string;
  balance_after_minor: number;
  status: WalletTransactionStatus;
  recipient?: string;
  description: string;
  reference_id?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WalletTopup {
  id: string;
  wallet_id: string;
  idempotency_key: string;
  amount_minor: number;
  currency: string;
  provider: 'upi_qr' | 'razorpay' | 'stripe' | 'mock';
  provider_intent_id?: string;
  qr_code_data?: string;
  payment_url?: string;
  status: TopupStatus;
  created_at: string;
  completed_at?: string;
}

export interface WalletPaymentRequest {
  id: string;
  wallet_id: string;
  idempotency_key: string;
  recipient: string;
  amount_minor: number;
  currency: string;
  reason: string;
  status: PaymentRequestStatus;
  approval_id?: string;
  created_at: string;
  expires_at: string;
}

export interface WalletLimit {
  id: string;
  wallet_id: string;
  daily_limit_minor: number;
  monthly_limit_minor: number;
  single_tx_limit_minor: number;
  updated_at: string;
}

export interface WalletProviderEvent {
  id: string;
  provider: string;
  event_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  processed_at: string;
}

export interface WalletAuditLog {
  id: string;
  wallet_id: string;
  action: string;
  actor: string;
  details: Record<string, unknown>;
  created_at: string;
}

/**
 * Converts integer minor units into human-readable currency string.
 * Example: 49900 -> "₹499.00"
 */
export function formatMinorUnits(amountMinor: number, currency = 'INR'): string {
  const isNegative = amountMinor < 0;
  const absMinor = Math.abs(amountMinor);
  const major = Math.floor(absMinor / 100);
  const minor = absMinor % 100;
  const paddedMinor = minor.toString().padStart(2, '0');

  const symbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : `${currency} `;
  return `${isNegative ? '-' : ''}${symbol}${major}.${paddedMinor}`;
}

/**
 * Converts standard major currency value into integer minor units without float drift.
 * Example: 499 -> 49900, "499.50" -> 49950
 */
export function parseToMinorUnits(amount: number | string): number {
  if (amount === undefined || amount === null) {
    return 0;
  }
  if (typeof amount === 'number') {
    return Math.round(amount * 100);
  }
  const cleaned = amount.replace(/[^0-9.-]/g, '').trim();
  const parsed = parseFloat(cleaned);
  if (isNaN(parsed) || !isFinite(parsed)) {
    throw new Error(`Invalid amount string: ${amount}`);
  }
  return Math.round(parsed * 100);
}
