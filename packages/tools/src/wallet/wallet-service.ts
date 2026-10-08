import crypto from 'node:crypto';
import {
  Wallet,
  WalletTransaction,
  WalletTopup,
  WalletLimit,
  formatMinorUnits,
  parseToMinorUnits,
  ApprovalRequiredError,
  NexaError,
} from '@nexa/shared';
import { IDatabaseRepository } from '@nexa/database';

export interface TopupIntentResult {
  topupId: string;
  idempotencyKey: string;
  qrCodeData: string;
  paymentUrl: string;
  amountMinor: number;
  formattedAmount: string;
  currency: string;
}

export interface PaymentExecutionResult {
  success: boolean;
  transactionId: string;
  balanceAfterMinor: number;
  amountMinor: number;
  formattedAmount: string;
  recipient: string;
  userFacingMessage: string;
}

export interface PaymentProviderAdapter {
  readonly name: string;
  createTopupQR(params: {
    amountMinor: number;
    currency: string;
    description: string;
    idempotencyKey: string;
  }): Promise<{ qrCodeData: string; paymentUrl: string; providerIntentId: string }>;
  verifyWebhookSignature(rawPayload: string | Buffer, signatureHeader?: string): boolean;
}

/**
 * Standard UPI / QR Payment Provider Adapter
 * Generates verified Indian UPI deep-links / QR standards
 */
export class UPIQRProviderAdapter implements PaymentProviderAdapter {
  public readonly name = 'upi_qr';

  constructor(
    private vpa: string = 'nexa.wallet@upi',
    private merchantName: string = 'NEXA Wallet',
    private webhookSecret?: string
  ) {}

  async createTopupQR(params: {
    amountMinor: number;
    currency: string;
    description: string;
    idempotencyKey: string;
  }): Promise<{ qrCodeData: string; paymentUrl: string; providerIntentId: string }> {
    const amountMajor = (params.amountMinor / 100).toFixed(2);
    const intentId = `upi_${Date.now()}_${params.idempotencyKey.slice(0, 8)}`;

    // Standard NPCI UPI URI Specification
    const upiUri = `upi://pay?pa=${encodeURIComponent(this.vpa)}&pn=${encodeURIComponent(
      this.merchantName
    )}&am=${amountMajor}&cu=${params.currency}&tn=${encodeURIComponent(
      params.description
    )}&tr=${params.idempotencyKey}`;

    return {
      qrCodeData: upiUri,
      paymentUrl: upiUri,
      providerIntentId: intentId,
    };
  }

  verifyWebhookSignature(rawPayload: string | Buffer, signatureHeader?: string): boolean {
    if (!this.webhookSecret) {
      return true; // Scaffolded dev mode when webhook secret is not set
    }
    if (!signatureHeader) return false;

    const hmac = crypto.createHmac('sha256', this.webhookSecret);
    const expected = hmac.update(rawPayload).digest('hex');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const providedBuffer = Buffer.from(signatureHeader.replace(/^sha256=/, ''), 'utf8');

    if (expectedBuffer.length !== providedBuffer.length) return false;
    return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  }
}

export class WalletService {
  constructor(
    private db: IDatabaseRepository,
    private providerAdapter: PaymentProviderAdapter = new UPIQRProviderAdapter()
  ) {}

  /**
   * Retrieves active wallet and human-readable balance.
   */
  async getBalance(userId: string): Promise<{
    wallet: Wallet;
    balanceMinor: number;
    formattedBalance: string;
    currency: string;
  }> {
    const wallet = await this.db.getOrCreateWallet(userId);
    return {
      wallet,
      balanceMinor: wallet.balance_minor,
      formattedBalance: formatMinorUnits(wallet.balance_minor, wallet.currency),
      currency: wallet.currency,
    };
  }

  /**
   * Lists recent wallet transactions.
   */
  async getTransactions(userId: string, limit = 10): Promise<WalletTransaction[]> {
    const wallet = await this.db.getOrCreateWallet(userId);
    return this.db.getWalletTransactions(wallet.id, limit);
  }

  /**
   * Creates a secure UPI/QR top-up intent.
   * Does NOT credit the wallet until verified webhook arrives.
   */
  async createTopupIntent(
    userId: string,
    amountMinor: number,
    currency = 'INR'
  ): Promise<TopupIntentResult> {
    if (amountMinor <= 0) {
      throw new NexaError('Top-up amount must be strictly greater than zero.', {
        code: 'INVALID_AMOUNT',
        statusCode: 400,
      });
    }

    const wallet = await this.db.getOrCreateWallet(userId, currency);
    const idempotencyKey = `topup_${wallet.id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    console.log(`[Wallet] topup_intent_start amount_minor=${amountMinor} currency=${currency}`);

    const providerResult = await this.providerAdapter.createTopupQR({
      amountMinor,
      currency,
      description: `Top-up NEXA Wallet`,
      idempotencyKey,
    });

    const topup = await this.db.createWalletTopup({
      wallet_id: wallet.id,
      idempotency_key: idempotencyKey,
      amount_minor: amountMinor,
      currency,
      provider: 'upi_qr',
      provider_intent_id: providerResult.providerIntentId,
      qr_code_data: providerResult.qrCodeData,
      payment_url: providerResult.paymentUrl,
      status: 'PENDING',
    });

    console.log(`[Wallet] topup_intent_created topup_id=${topup.id}`);

    return {
      topupId: topup.id,
      idempotencyKey,
      qrCodeData: providerResult.qrCodeData,
      paymentUrl: providerResult.paymentUrl,
      amountMinor,
      formattedAmount: formatMinorUnits(amountMinor, currency),
      currency,
    };
  }

  /**
   * Processes verified provider webhook event idempotently.
   * Credits wallet ledger ONLY after verified provider confirmation.
   */
  async processTopupWebhook(
    rawPayload: string | Buffer,
    signatureHeader: string | undefined,
    eventPayload: { idempotencyKey: string; status: 'SUCCEEDED' | 'FAILED'; amountMinor?: number }
  ): Promise<{ success: boolean; alreadyProcessed: boolean; balanceAfterMinor?: number }> {
    const isValid = this.providerAdapter.verifyWebhookSignature(rawPayload, signatureHeader);
    if (!isValid) {
      console.warn('[Wallet Security] Provider webhook signature verification failed');
      throw new NexaError('Unauthorized webhook signature', {
        code: 'INVALID_SIGNATURE',
        statusCode: 401,
      });
    }

    const { idempotencyKey, status } = eventPayload;

    // Idempotency check: Ignore duplicate events
    const existingEvent = await this.db.getWalletProviderEvent(idempotencyKey);
    if (existingEvent) {
      console.log(`[Wallet] Duplicate provider event ${idempotencyKey} ignored.`);
      return { success: true, alreadyProcessed: true };
    }

    const topup = await this.db.getWalletTopupByIdempotencyKey(idempotencyKey);
    if (!topup) {
      throw new NexaError(`Topup record not found for idempotency key ${idempotencyKey}`, {
        code: 'TOPUP_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (topup.status === 'SUCCEEDED') {
      return { success: true, alreadyProcessed: true };
    }

    await this.db.saveWalletProviderEvent({
      provider: this.providerAdapter.name,
      event_type: 'topup_confirmation',
      idempotency_key: idempotencyKey,
      payload: eventPayload as Record<string, unknown>,
    });

    if (status === 'SUCCEEDED') {
      const wallet = await this.db.getWalletById(topup.wallet_id);
      if (!wallet) throw new Error('Wallet not found');

      const newBalanceMinor = wallet.balance_minor + topup.amount_minor;
      await this.db.updateWalletBalance(wallet.id, newBalanceMinor);

      await this.db.createWalletTransaction({
        wallet_id: wallet.id,
        idempotency_key: idempotencyKey,
        type: 'topup',
        amount_minor: topup.amount_minor,
        currency: topup.currency,
        balance_after_minor: newBalanceMinor,
        status: 'SUCCEEDED',
        description: `UPI Top-up confirmed`,
      });

      await this.db.updateWalletTopupStatus(topup.id, 'SUCCEEDED', new Date().toISOString());

      console.log(
        `[Wallet] topup_success amount_minor=${topup.amount_minor} new_balance_minor=${newBalanceMinor}`
      );

      return { success: true, alreadyProcessed: false, balanceAfterMinor: newBalanceMinor };
    } else {
      await this.db.updateWalletTopupStatus(topup.id, 'FAILED');
      return { success: false, alreadyProcessed: false };
    }
  }

  /**
   * Executes a payment or transfer from the wallet.
   * REQUIRES explicit user approval.
   */
  async executePayment(params: {
    userId: string;
    recipient: string;
    amountMinor: number;
    reason: string;
    idempotencyKey?: string;
    isUserConfirmed?: boolean;
  }): Promise<PaymentExecutionResult> {
    const { userId, recipient, amountMinor, reason, isUserConfirmed } = params;

    if (amountMinor <= 0) {
      throw new NexaError('Payment amount must be greater than zero.', {
        code: 'INVALID_AMOUNT',
        statusCode: 400,
      });
    }

    const wallet = await this.db.getOrCreateWallet(userId);
    const formattedAmount = formatMinorUnits(amountMinor, wallet.currency);

    // 1. Explicit Approval Guard: Every financial transaction requires confirmation
    if (!isUserConfirmed) {
      const prompt = `Ready to pay *${formattedAmount}* to *${recipient}* for: "${reason}".\n\nYour current wallet balance is *${formatMinorUnits(
        wallet.balance_minor,
        wallet.currency
      )}*.\n\nPlease reply *Yes* or tap *Approve* to confirm this payment.`;

      console.log(`[Wallet Security] payment_confirmation_required amount_minor=${amountMinor}`);
      throw new ApprovalRequiredError(
        prompt,
        'wallet_transfer_or_pay',
        params as Record<string, unknown>,
        'high'
      );
    }

    // 2. Balance Check
    if (wallet.balance_minor < amountMinor) {
      console.warn(`[Wallet] insufficient_balance current=${wallet.balance_minor} required=${amountMinor}`);
      throw new NexaError(
        `Insufficient wallet balance. You have ${formatMinorUnits(
          wallet.balance_minor,
          wallet.currency
        )}, but ${formattedAmount} is needed.`,
        {
          code: 'INSUFFICIENT_FUNDS',
          statusCode: 400,
          userFacingMessage: `You don't have enough balance for this payment. Your balance is ${formatMinorUnits(
            wallet.balance_minor,
            wallet.currency
          )}. Would you like to add money?`,
        }
      );
    }

    // 3. Spending Limit Check
    const limits = await this.db.getWalletLimits(wallet.id);
    if (limits && limits.single_tx_limit_minor > 0 && amountMinor > limits.single_tx_limit_minor) {
      throw new NexaError(
        `Payment exceeds single transaction limit of ${formatMinorUnits(
          limits.single_tx_limit_minor,
          wallet.currency
        )}.`,
        { code: 'TRANSACTION_LIMIT_EXCEEDED', statusCode: 400 }
      );
    }

    // 4. Idempotency Check
    const idempotencyKey =
      params.idempotencyKey ||
      `pay_${wallet.id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const existingTx = await this.db.getTransactionByIdempotencyKey(idempotencyKey);
    if (existingTx && existingTx.status === 'SUCCEEDED') {
      console.log(`[Wallet] duplicate_payment_prevented idempotency_key=${idempotencyKey}`);
      return {
        success: true,
        transactionId: existingTx.id,
        balanceAfterMinor: existingTx.balance_after_minor,
        amountMinor,
        formattedAmount,
        recipient,
        userFacingMessage: `Payment of ${formattedAmount} to ${recipient} was already completed. Current balance: ${formatMinorUnits(
          existingTx.balance_after_minor,
          wallet.currency
        )}.`,
      };
    }

    // 5. Execute Ledger Debit
    const newBalanceMinor = wallet.balance_minor - amountMinor;
    await this.db.updateWalletBalance(wallet.id, newBalanceMinor);

    const tx = await this.db.createWalletTransaction({
      wallet_id: wallet.id,
      idempotency_key: idempotencyKey,
      type: 'payment',
      amount_minor: -amountMinor,
      currency: wallet.currency,
      balance_after_minor: newBalanceMinor,
      status: 'SUCCEEDED',
      recipient,
      description: reason || `Payment to ${recipient}`,
    });

    console.log(
      `[Wallet] payment_success amount_minor=${amountMinor} new_balance_minor=${newBalanceMinor}`
    );

    return {
      success: true,
      transactionId: tx.id,
      balanceAfterMinor: newBalanceMinor,
      amountMinor,
      formattedAmount,
      recipient,
      userFacingMessage: `Paid ${formattedAmount} to *${recipient}* successfully! Your new balance is *${formatMinorUnits(
        newBalanceMinor,
        wallet.currency
      )}*.`,
    };
  }

  /**
   * Sets or updates spending limits.
   */
  async setLimit(
    userId: string,
    singleTxLimitMinor = 0,
    dailyLimitMinor = 0,
    monthlyLimitMinor = 0
  ): Promise<WalletLimit> {
    const wallet = await this.db.getOrCreateWallet(userId);
    const limitRecord: WalletLimit = {
      id: crypto.randomUUID(),
      wallet_id: wallet.id,
      single_tx_limit_minor: singleTxLimitMinor,
      daily_limit_minor: dailyLimitMinor,
      monthly_limit_minor: monthlyLimitMinor,
      updated_at: new Date().toISOString(),
    };
    return this.db.saveWalletLimits(limitRecord);
  }

  /**
   * Calculates monthly spending total.
   */
  async getSpendingSummary(userId: string): Promise<{
    monthTotalMinor: number;
    formattedMonthTotal: string;
    currency: string;
    transactionCount: number;
  }> {
    const wallet = await this.db.getOrCreateWallet(userId);
    const txs = await this.db.getWalletTransactions(wallet.id, 100);

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const monthlyDebits = txs.filter((t) => {
      const d = new Date(t.created_at);
      return (
        d.getMonth() === currentMonth &&
        d.getFullYear() === currentYear &&
        t.type === 'payment' &&
        t.status === 'SUCCEEDED'
      );
    });

    const totalMinor = monthlyDebits.reduce((acc, t) => acc + Math.abs(t.amount_minor), 0);

    return {
      monthTotalMinor: totalMinor,
      formattedMonthTotal: formatMinorUnits(totalMinor, wallet.currency),
      currency: wallet.currency,
      transactionCount: monthlyDebits.length,
    };
  }
}
