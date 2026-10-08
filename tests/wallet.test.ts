import { describe, it, expect, vi } from 'vitest';
import { InMemoryRepository } from '../packages/database/src/index.js';
import { WalletService, UPIQRProviderAdapter } from '../packages/tools/src/wallet/wallet-service.js';
import {
  formatMinorUnits,
  parseToMinorUnits,
  ApprovalRequiredError,
  NexaError,
} from '../packages/shared/src/index.js';
import { createWalletTools } from '../packages/tools/src/tools/wallet-tools.js';

describe('NEXA Wallet Subsystem Suite', () => {
  it('Minor unit integer conversion and formatting works accurately without floating point drift', () => {
    expect(parseToMinorUnits(100.5)).toBe(10050);
    expect(parseToMinorUnits(0.01)).toBe(1);
    expect(parseToMinorUnits('250.75')).toBe(25075);
    expect(parseToMinorUnits(500)).toBe(50000);

    expect(formatMinorUnits(10050, 'INR')).toBe('₹100.50');
    expect(formatMinorUnits(50000, 'INR')).toBe('₹500.00');
    expect(formatMinorUnits(2500, 'USD')).toBe('$25.00');
  });

  it('WalletService getBalance initializes wallet with zero balance in minor units', async () => {
    const db = new InMemoryRepository();
    const walletService = new WalletService(db);

    const result = await walletService.getBalance('user-123');
    expect(result.balanceMinor).toBe(0);
    expect(result.formattedBalance).toBe('₹0.00');
    expect(result.currency).toBe('INR');
  });

  it('Top-up intent generates valid UPI QR URI and creates PENDING record without crediting balance', async () => {
    const db = new InMemoryRepository();
    const walletService = new WalletService(db);

    const intent = await walletService.createTopupIntent('user-123', 50000, 'INR'); // ₹500.00
    expect(intent.amountMinor).toBe(50000);
    expect(intent.formattedAmount).toBe('₹500.00');
    expect(intent.qrCodeData).toContain('upi://pay?pa=');
    expect(intent.paymentUrl).toContain('am=500.00');

    // Wallet balance must still be zero!
    const balance = await walletService.getBalance('user-123');
    expect(balance.balanceMinor).toBe(0);
  });

  it('Provider webhook credits ledger idempotently only once upon verified confirmation', async () => {
    const db = new InMemoryRepository();
    const walletService = new WalletService(db);

    const intent = await walletService.createTopupIntent('user-123', 50000, 'INR');

    // 1st webhook notification
    const res1 = await walletService.processTopupWebhook(
      JSON.stringify({ idempotencyKey: intent.idempotencyKey, status: 'SUCCEEDED' }),
      undefined,
      { idempotencyKey: intent.idempotencyKey, status: 'SUCCEEDED' }
    );

    expect(res1.success).toBe(true);
    expect(res1.alreadyProcessed).toBe(false);
    expect(res1.balanceAfterMinor).toBe(50000);

    const balAfter1 = await walletService.getBalance('user-123');
    expect(balAfter1.balanceMinor).toBe(50000);
    expect(balAfter1.formattedBalance).toBe('₹500.00');

    // 2nd duplicate webhook notification (idempotency guard)
    const res2 = await walletService.processTopupWebhook(
      JSON.stringify({ idempotencyKey: intent.idempotencyKey, status: 'SUCCEEDED' }),
      undefined,
      { idempotencyKey: intent.idempotencyKey, status: 'SUCCEEDED' }
    );

    expect(res2.success).toBe(true);
    expect(res2.alreadyProcessed).toBe(true);

    // Balance must not double!
    const balAfter2 = await walletService.getBalance('user-123');
    expect(balAfter2.balanceMinor).toBe(50000);
  });

  it('Payment tool requires explicit user approval before debiting funds', async () => {
    const db = new InMemoryRepository();
    const walletService = new WalletService(db);
    const user = await db.findOrCreateUserByPhone('+919876543210', 'Awan');
    const conversation = await db.getOrCreateActiveConversation(user.id);

    // Credit ₹1000
    const intent = await walletService.createTopupIntent(user.id, 100000, 'INR');
    await walletService.processTopupWebhook('mock-payload', undefined, {
      idempotencyKey: intent.idempotencyKey,
      status: 'SUCCEEDED',
    });

    const tools = createWalletTools(walletService);
    const payTool = tools.find((t) => t.name === 'wallet_transfer_or_pay')!;

    // Initial unconfirmed execution MUST throw ApprovalRequiredError
    await expect(
      payTool.execute(
        {
          amount: 250,
          recipient: 'rahul@upi',
          description: 'Dinner split',
        },
        {
          user,
          conversation,
          messageId: 'msg-1',
          sourceChannel: 'whatsapp',
          isUserConfirmed: false,
        }
      )
    ).rejects.toThrow(ApprovalRequiredError);
  });

  it('Executing payment with isUserConfirmed=true debits balance and records transaction', async () => {
    const db = new InMemoryRepository();
    const walletService = new WalletService(db);
    const user = await db.findOrCreateUserByPhone('+919876543210', 'Awan');
    const conversation = await db.getOrCreateActiveConversation(user.id);

    // Credit ₹1000
    const intent = await walletService.createTopupIntent(user.id, 100000, 'INR');
    await walletService.processTopupWebhook('mock-payload', undefined, {
      idempotencyKey: intent.idempotencyKey,
      status: 'SUCCEEDED',
    });

    const tools = createWalletTools(walletService);
    const payTool = tools.find((t) => t.name === 'wallet_transfer_or_pay')!;

    const result = await payTool.execute(
      {
        amount: 250,
        recipient: 'rahul@upi',
        description: 'Dinner split',
      },
      {
        user,
        conversation,
        messageId: 'msg-1',
        sourceChannel: 'whatsapp',
        isUserConfirmed: true,
      }
    );

    expect(result.success).toBe(true);
    expect(result.userFacingMessage).toContain('₹250.00');
    expect(result.userFacingMessage).toContain('rahul@upi');

    const bal = await walletService.getBalance(user.id);
    expect(bal.balanceMinor).toBe(75000); // ₹750.00 remaining
    expect(bal.formattedBalance).toBe('₹750.00');
  });

  it('Payment fails gracefully with clear error when balance is insufficient', async () => {
    const db = new InMemoryRepository();
    const walletService = new WalletService(db);
    const user = await db.findOrCreateUserByPhone('+919876543210', 'Awan');
    const conversation = await db.getOrCreateActiveConversation(user.id);

    // Balance is 0
    const tools = createWalletTools(walletService);
    const payTool = tools.find((t) => t.name === 'wallet_transfer_or_pay')!;

    await expect(
      payTool.execute(
        {
          amount: 500,
          recipient: 'merchant@upi',
        },
        {
          user,
          conversation,
          messageId: 'msg-1',
          sourceChannel: 'whatsapp',
          isUserConfirmed: true,
        }
      )
    ).rejects.toThrow('Insufficient wallet balance');
  });

  it('Spending limit prevents transactions exceeding threshold', async () => {
    const db = new InMemoryRepository();
    const walletService = new WalletService(db);
    const user = await db.findOrCreateUserByPhone('+919876543210', 'Awan');
    const conversation = await db.getOrCreateActiveConversation(user.id);

    // Top up ₹5000
    const intent = await walletService.createTopupIntent(user.id, 500000, 'INR');
    await walletService.processTopupWebhook('mock-payload', undefined, {
      idempotencyKey: intent.idempotencyKey,
      status: 'SUCCEEDED',
    });

    const tools = createWalletTools(walletService);
    const setLimitTool = tools.find((t) => t.name === 'wallet_set_limit')!;
    const payTool = tools.find((t) => t.name === 'wallet_transfer_or_pay')!;

    // Set per-transaction limit to ₹1000
    await setLimitTool.execute(
      {
        singleTransactionLimit: 1000,
      },
      {
        user,
        conversation,
        messageId: 'msg-1',
        sourceChannel: 'whatsapp',
      }
    );

    // Attempting ₹2000 should be rejected by spending limit
    await expect(
      payTool.execute(
        {
          amount: 2000,
          recipient: 'shop@upi',
        },
        {
          user,
          conversation,
          messageId: 'msg-2',
          sourceChannel: 'whatsapp',
          isUserConfirmed: true,
        }
      )
    ).rejects.toThrow('Payment exceeds single transaction limit');
  });
});
