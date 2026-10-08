import { z } from 'zod';
import { BaseTool, ToolExecutionContext, ToolResult, parseToMinorUnits } from '@nexa/shared';
import { WalletService } from '../wallet/wallet-service.js';

export function createWalletTools(walletService: WalletService): BaseTool[] {
  const getBalanceTool: BaseTool = {
    name: 'wallet_get_balance',
    description: "Retrieves the user's current NEXA Wallet balance and currency.",
    riskLevel: 'read_only',
    parametersSchema: z.object({}),
    requiresApproval: () => ({ required: false }),
    execute: async (_args: any, context: ToolExecutionContext): Promise<ToolResult> => {
      const result = await walletService.getBalance(context.user.id);
      return {
        success: true,
        data: result,
        userFacingMessage: `Your current NEXA Wallet balance is *${result.formattedBalance}*.`,
      };
    },
  };

  const getTransactionsTool: BaseTool = {
    name: 'wallet_get_transactions',
    description: "Lists the user's recent wallet transactions, payments, and top-ups.",
    riskLevel: 'read_only',
    parametersSchema: z.object({
      limit: z.number().default(5).describe('Number of transactions to retrieve'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { limit: number }, context: ToolExecutionContext): Promise<ToolResult> => {
      const txs = await walletService.getTransactions(context.user.id, args.limit || 5);
      return {
        success: true,
        data: { transactions: txs, count: txs.length },
      };
    },
  };

  const createTopupQrTool: BaseTool = {
    name: 'wallet_create_topup_qr',
    description:
      'Creates a secure UPI QR code / payment request to add funds into the NEXA Wallet. Does not credit the wallet until payment is verified.',
    riskLevel: 'low_risk',
    parametersSchema: z.object({
      amount: z.number().describe('Amount to add to wallet (in major units, e.g. 500 for ₹500)'),
      currency: z.string().default('INR').describe('Currency code (defaults to INR)'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (
      args: { amount: number; currency: string },
      context: ToolExecutionContext
    ): Promise<ToolResult> => {
      const amountMinor = parseToMinorUnits(args.amount);
      const topup = await walletService.createTopupIntent(context.user.id, amountMinor, args.currency);

      return {
        success: true,
        data: topup,
        userFacingMessage: `I've created a secure top-up request for *${topup.formattedAmount}*.\n\nUPI Payment Link: ${topup.paymentUrl}\n\nOnce completed, your wallet balance will automatically update.`,
      };
    },
  };

  const transferOrPayTool: BaseTool = {
    name: 'wallet_transfer_or_pay',
    description:
      'Transfers money or pays a merchant from the NEXA Wallet. REQUIRES explicit user confirmation.',
    riskLevel: 'critical',
    parametersSchema: z.object({
      recipient: z.string().describe('Recipient name, UPI ID, or merchant name (e.g. "Coffee Shop", "rahul@upi")'),
      amount: z.number().describe('Amount to pay (e.g. 250 for ₹250)'),
      reason: z.string().describe('Purpose or reason for the payment (e.g. "Lunch bill", "Travel advance")'),
    }),
    requiresApproval: (args) => {
      const amountMinor = parseToMinorUnits(args.amount);
      const majorStr = (amountMinor / 100).toFixed(2);
      return {
        required: true,
        reason: 'Payment from NEXA Wallet',
        impactLevel: 'high',
        formatConfirmationPrompt: () =>
          `You're about to pay *₹${majorStr}* to *${args.recipient}* for "${args.reason}".\n\nConfirm payment? Reply *Yes* or tap *Approve*.`,
      };
    },
    execute: async (
      args: { recipient: string; amount: number; reason: string },
      context: ToolExecutionContext
    ): Promise<ToolResult> => {
      const amountMinor = parseToMinorUnits(args.amount);
      const res = await walletService.executePayment({
        userId: context.user.id,
        recipient: args.recipient,
        amountMinor,
        reason: args.reason,
        isUserConfirmed: context.isUserConfirmed,
      });

      return {
        success: true,
        data: res,
        userFacingMessage: res.userFacingMessage,
      };
    },
  };

  const setLimitTool: BaseTool = {
    name: 'wallet_set_limit',
    description: 'Sets daily, monthly, or per-transaction spending limits on the NEXA Wallet.',
    riskLevel: 'medium_risk',
    parametersSchema: z.object({
      singleTransactionLimit: z
        .number()
        .optional()
        .describe('Maximum amount for a single payment (in major units, e.g. 2000)'),
      dailyLimit: z.number().optional().describe('Daily spending limit'),
      monthlyLimit: z.number().optional().describe('Monthly spending limit'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (
      args: { singleTransactionLimit?: number; dailyLimit?: number; monthlyLimit?: number },
      context: ToolExecutionContext
    ): Promise<ToolResult> => {
      const singleMinor = args.singleTransactionLimit ? parseToMinorUnits(args.singleTransactionLimit) : 0;
      const dailyMinor = args.dailyLimit ? parseToMinorUnits(args.dailyLimit) : 0;
      const monthlyMinor = args.monthlyLimit ? parseToMinorUnits(args.monthlyLimit) : 0;

      const limit = await walletService.setLimit(context.user.id, singleMinor, dailyMinor, monthlyMinor);
      return {
        success: true,
        data: limit,
        userFacingMessage: `Updated your wallet spending limits successfully.`,
      };
    },
  };

  const getSpendingSummaryTool: BaseTool = {
    name: 'wallet_get_spending_summary',
    description: "Calculates the user's total spending from the NEXA Wallet for the current month.",
    riskLevel: 'read_only',
    parametersSchema: z.object({}),
    requiresApproval: () => ({ required: false }),
    execute: async (_args: any, context: ToolExecutionContext): Promise<ToolResult> => {
      const summary = await walletService.getSpendingSummary(context.user.id);
      return {
        success: true,
        data: summary,
        userFacingMessage: `Your total spending this month is *${summary.formattedMonthTotal}* across ${summary.transactionCount} payment(s).`,
      };
    },
  };

  return [
    getBalanceTool,
    getTransactionsTool,
    createTopupQrTool,
    transferOrPayTool,
    setLimitTool,
    getSpendingSummaryTool,
  ];
}
