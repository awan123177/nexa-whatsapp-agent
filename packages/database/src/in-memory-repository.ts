import crypto from 'node:crypto';
import {
  User,
  Conversation,
  Message,
  Memory,
  Task,
  ToolCallRecord,
  Approval,
  ApprovalStatus,
  AuditLog,
  ChannelType,
  ConnectedAccount,
  Wallet,
  WalletTransaction,
  WalletTopup,
  WalletLimit,
  WalletProviderEvent,
  TopupStatus,
  MerchantSessionRecord,
  SavedAddress,
} from '@nexa/shared';
import { IDatabaseRepository } from './types.js';

export class InMemoryRepository implements IDatabaseRepository {
  public users = new Map<string, User>();
  public conversations = new Map<string, Conversation>();
  public messages = new Map<string, Message>();
  public toolCalls = new Map<string, ToolCallRecord>();
  public approvals = new Map<string, Approval>();
  public memories = new Map<string, Memory>();
  public tasks = new Map<string, Task>();
  public connectedAccounts = new Map<string, ConnectedAccount>();
  public auditLogs: AuditLog[] = [];
  public wallets = new Map<string, Wallet>();
  public walletTransactions = new Map<string, WalletTransaction>();
  public walletTopups = new Map<string, WalletTopup>();
  public walletLimits = new Map<string, WalletLimit>();
  public walletProviderEvents = new Map<string, WalletProviderEvent>();
  public merchantSessions = new Map<string, MerchantSessionRecord>();
  public userAddresses = new Map<string, SavedAddress>();

  async findOrCreateUserByPhone(phoneNumber: string, name?: string): Promise<User> {
    const existing = Array.from(this.users.values()).find(
      (u) => u.phone_number === phoneNumber
    );
    if (existing) {
      if (name && !existing.name) {
        existing.name = name;
        existing.updated_at = new Date().toISOString();
      }
      return existing;
    }

    const newUser: User = {
      id: crypto.randomUUID(),
      phone_number: phoneNumber,
      name: name || null,
      role: 'user',
      status: 'active',
      preferences: {},
      preferred_name: null,
      name_confirmed: false,
      name_source: null,
      preferred_title: null,
      title_confirmed: false,
      title_source: null,
      memory_version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.users.set(newUser.id, newUser);
    return newUser;
  }

  async getUserById(id: string): Promise<User | null> {
    const user = this.users.get(id);
    if (!user) return null;

    // Backward compatibility: Populate top-level fields from preferences if missing
    if (user.preferences) {
      if (user.preferred_name === undefined) {
        user.preferred_name = (user.preferences.preferred_name as string) || null;
      }
      if (user.name_confirmed === undefined) {
        user.name_confirmed = Boolean(user.preferences.name_confirmed);
      }
      if (user.name_source === undefined) {
        user.name_source = (user.preferences.name_source as any) || null;
      }
      if (user.preferred_title === undefined) {
        user.preferred_title = (user.preferences.preferred_title as string) || null;
      }
      if (user.title_confirmed === undefined) {
        user.title_confirmed = Boolean(user.preferences.title_confirmed);
      }
      if (user.title_source === undefined) {
        user.title_source = (user.preferences.title_source as any) || null;
      }
      if (user.memory_version === undefined) {
        user.memory_version = (user.preferences.memory_version as number) || 1;
      }
    }
    return user;
  }

  async updateUser(userId: string, updates: Partial<User>): Promise<User> {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    const updatedPreferences: Record<string, unknown> = {
      ...user.preferences,
      ...(updates.preferences || {}),
    };

    if (updates.preferred_name !== undefined) {
      updatedPreferences.preferred_name = updates.preferred_name;
    }
    if (updates.name_confirmed !== undefined) {
      updatedPreferences.name_confirmed = updates.name_confirmed;
    }
    if (updates.name_source !== undefined) {
      updatedPreferences.name_source = updates.name_source;
    }
    if (updates.preferred_title !== undefined) {
      updatedPreferences.preferred_title = updates.preferred_title;
    }
    if (updates.title_confirmed !== undefined) {
      updatedPreferences.title_confirmed = updates.title_confirmed;
    }
    if (updates.title_source !== undefined) {
      updatedPreferences.title_source = updates.title_source;
    }
    if (updates.memory_version !== undefined) {
      updatedPreferences.memory_version = updates.memory_version;
    }

    Object.assign(user, updates, {
      preferences: updatedPreferences,
      preferred_name:
        updatedPreferences.preferred_name !== undefined
          ? (updatedPreferences.preferred_name as string)
          : (user.preferred_name ?? null),
      name_confirmed:
        updatedPreferences.name_confirmed !== undefined
          ? Boolean(updatedPreferences.name_confirmed)
          : Boolean(user.name_confirmed),
      name_source:
        updatedPreferences.name_source !== undefined
          ? (updatedPreferences.name_source as any)
          : (user.name_source ?? null),
      preferred_title:
        updatedPreferences.preferred_title !== undefined
          ? (updatedPreferences.preferred_title as string)
          : (user.preferred_title ?? null),
      title_confirmed:
        updatedPreferences.title_confirmed !== undefined
          ? Boolean(updatedPreferences.title_confirmed)
          : Boolean(user.title_confirmed),
      title_source:
        updatedPreferences.title_source !== undefined
          ? (updatedPreferences.title_source as any)
          : (user.title_source ?? null),
      memory_version:
        (updatedPreferences.memory_version as number) ?? user.memory_version ?? 1,
      updated_at: new Date().toISOString(),
    });
    return user;
  }

  async getOrCreateActiveConversation(userId: string, channel: ChannelType = 'whatsapp'): Promise<Conversation> {
    const existing = Array.from(this.conversations.values()).find(
      (c) => c.user_id === userId && c.channel === channel && c.status === 'active'
    );
    if (existing) {
      return existing;
    }

    const newConv: Conversation = {
      id: crypto.randomUUID(),
      user_id: userId,
      channel,
      status: 'active',
      title: 'WhatsApp Conversation',
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.conversations.set(newConv.id, newConv);
    return newConv;
  }

  async getConversationById(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) || null;
  }

  async saveMessage(data: Omit<Message, 'id' | 'created_at'>): Promise<Message> {
    const msg: Message = {
      ...data,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.messages.set(msg.id, msg);

    // Update conversation updated_at
    const conv = this.conversations.get(data.conversation_id);
    if (conv) {
      conv.updated_at = msg.created_at;
    }

    return msg;
  }

  async getConversationMessages(conversationId: string, limit = 20): Promise<Message[]> {
    return Array.from(this.messages.values())
      .filter((m) => m.conversation_id === conversationId)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .slice(-limit);
  }

  async getMessageByWhatsAppId(whatsappMessageId: string): Promise<Message | null> {
    return (
      Array.from(this.messages.values()).find(
        (m) => m.whatsapp_message_id === whatsappMessageId
      ) || null
    );
  }

  async saveToolCall(data: Omit<ToolCallRecord, 'id' | 'created_at'>): Promise<ToolCallRecord> {
    const record: ToolCallRecord = {
      ...data,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.toolCalls.set(record.id, record);
    return record;
  }

  async getToolCallsForConversation(conversationId: string): Promise<ToolCallRecord[]> {
    return Array.from(this.toolCalls.values())
      .filter((tc) => tc.conversation_id === conversationId)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }

  async createApproval(data: Omit<Approval, 'id' | 'requested_at'>): Promise<Approval> {
    const approval: Approval = {
      ...data,
      id: crypto.randomUUID(),
      requested_at: new Date().toISOString(),
    };
    this.approvals.set(approval.id, approval);
    return approval;
  }

  async getPendingApproval(conversationId: string): Promise<Approval | null> {
    const now = Date.now();
    return (
      Array.from(this.approvals.values()).find(
        (a) =>
          a.conversation_id === conversationId &&
          a.status === 'pending' &&
          new Date(a.expires_at).getTime() > now
      ) || null
    );
  }

  async getLatestApproval(conversationId: string): Promise<Approval | null> {
    const list = Array.from(this.approvals.values())
      .filter((a) => a.conversation_id === conversationId)
      .sort((a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime());
    return list[0] || null;
  }

  async updateApprovalStatus(
    approvalId: string,
    status: ApprovalStatus,
    respondedAt?: string
  ): Promise<Approval> {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      throw new Error(`Approval ${approvalId} not found.`);
    }
    approval.status = status;
    approval.responded_at = respondedAt || new Date().toISOString();
    return approval;
  }

  async saveMemory(data: Omit<Memory, 'id' | 'created_at' | 'updated_at'>): Promise<Memory> {
    const existing = Array.from(this.memories.values()).find(
      (m) =>
        m.user_id === data.user_id &&
        m.category === data.category &&
        m.key.toLowerCase() === data.key.toLowerCase()
    );

    const now = new Date().toISOString();
    if (existing) {
      existing.value = data.value;
      existing.confidence = data.confidence;
      existing.metadata = data.metadata;
      if (data.source !== undefined) existing.source = data.source;
      if (data.confirmed !== undefined) existing.confirmed = data.confirmed;
      if (data.version !== undefined) existing.version = data.version;
      existing.updated_at = now;
      return existing;
    }

    const memory: Memory = {
      ...data,
      id: crypto.randomUUID(),
      source: data.source || 'USER_PROVIDED',
      confirmed: data.confirmed !== false,
      version: data.version || 1,
      created_at: now,
      updated_at: now,
    };
    this.memories.set(memory.id, memory);
    return memory;
  }

  async getUserMemories(userId: string, category?: string): Promise<Memory[]> {
    return Array.from(this.memories.values()).filter((m) => {
      if (m.user_id !== userId) return false;
      if (category && m.category !== category) return false;
      return true;
    });
  }

  async deleteMemory(id: string, userId: string): Promise<boolean> {
    const memory = this.memories.get(id);
    if (memory && memory.user_id === userId) {
      return this.memories.delete(id);
    }
    return false;
  }

  async createTask(data: Omit<Task, 'id' | 'created_at' | 'updated_at'>): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      ...data,
      id: crypto.randomUUID(),
      created_at: now,
      updated_at: now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  async getUserTasks(userId: string): Promise<Task[]> {
    return Array.from(this.tasks.values()).filter((t) => t.user_id === userId);
  }

  async saveAuditLog(data: Omit<AuditLog, 'id' | 'created_at'>): Promise<void> {
    const log: AuditLog = {
      ...data,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.auditLogs.push(log);
  }

  async saveConnectedAccount(
    data: Omit<ConnectedAccount, 'id' | 'created_at' | 'updated_at'>
  ): Promise<ConnectedAccount> {
    const existing = Array.from(this.connectedAccounts.values()).find(
      (a) => a.user_id === data.user_id && a.provider === data.provider
    );

    const now = new Date().toISOString();
    if (existing) {
      existing.account_id = data.account_id;
      existing.scopes = data.scopes;
      existing.token_data = data.token_data;
      existing.status = data.status;
      existing.metadata = data.metadata;
      existing.updated_at = now;
      return existing;
    }

    const account: ConnectedAccount = {
      ...data,
      id: crypto.randomUUID(),
      created_at: now,
      updated_at: now,
    };
    this.connectedAccounts.set(account.id, account);
    return account;
  }

  async getConnectedAccount(userId: string, provider: string): Promise<ConnectedAccount | null> {
    return (
      Array.from(this.connectedAccounts.values()).find(
        (a) => a.user_id === userId && a.provider === provider
      ) || null
    );
  }

  async updateConnectedAccountStatus(
    userId: string,
    provider: string,
    status: 'active' | 'revoked' | 'expired'
  ): Promise<ConnectedAccount | null> {
    const account = await this.getConnectedAccount(userId, provider);
    if (!account) return null;
    account.status = status;
    account.updated_at = new Date().toISOString();
    return account;
  }

  async deleteConnectedAccount(userId: string, provider: string): Promise<boolean> {
    const account = await this.getConnectedAccount(userId, provider);
    if (account) {
      return this.connectedAccounts.delete(account.id);
    }
    return false;
  }

  // NEXA Wallet Operations
  async getOrCreateWallet(userId: string, currency = 'INR'): Promise<Wallet> {
    const existing = Array.from(this.wallets.values()).find((w) => w.user_id === userId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const wallet: Wallet = {
      id: crypto.randomUUID(),
      user_id: userId,
      currency,
      balance_minor: 0,
      status: 'active',
      created_at: now,
      updated_at: now,
    };
    this.wallets.set(wallet.id, wallet);
    return wallet;
  }

  async getWalletByUserId(userId: string): Promise<Wallet | null> {
    return Array.from(this.wallets.values()).find((w) => w.user_id === userId) || null;
  }

  async getWalletById(walletId: string): Promise<Wallet | null> {
    return this.wallets.get(walletId) || null;
  }

  async createWalletTransaction(
    data: Omit<WalletTransaction, 'id' | 'created_at' | 'updated_at'>
  ): Promise<WalletTransaction> {
    const now = new Date().toISOString();
    const tx: WalletTransaction = {
      ...data,
      id: crypto.randomUUID(),
      created_at: now,
      updated_at: now,
    };
    this.walletTransactions.set(tx.id, tx);
    return tx;
  }

  async getWalletTransactions(walletId: string, limit = 20): Promise<WalletTransaction[]> {
    return Array.from(this.walletTransactions.values())
      .filter((t) => t.wallet_id === walletId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);
  }

  async getTransactionByIdempotencyKey(key: string): Promise<WalletTransaction | null> {
    return (
      Array.from(this.walletTransactions.values()).find((t) => t.idempotency_key === key) || null
    );
  }

  async updateWalletBalance(walletId: string, newBalanceMinor: number): Promise<Wallet> {
    const wallet = this.wallets.get(walletId);
    if (!wallet) throw new Error(`Wallet ${walletId} not found`);
    wallet.balance_minor = newBalanceMinor;
    wallet.updated_at = new Date().toISOString();
    return wallet;
  }

  async createWalletTopup(data: Omit<WalletTopup, 'id' | 'created_at'>): Promise<WalletTopup> {
    const topup: WalletTopup = {
      ...data,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.walletTopups.set(topup.id, topup);
    return topup;
  }

  async getWalletTopupByIdempotencyKey(key: string): Promise<WalletTopup | null> {
    return (
      Array.from(this.walletTopups.values()).find(
        (t) => t.idempotency_key === key || t.id === key
      ) || null
    );
  }

  async updateWalletTopupStatus(
    id: string,
    status: TopupStatus,
    completedAt?: string
  ): Promise<WalletTopup> {
    const topup = this.walletTopups.get(id);
    if (!topup) throw new Error(`Topup ${id} not found`);
    topup.status = status;
    if (completedAt) topup.completed_at = completedAt;
    return topup;
  }

  async getWalletLimits(walletId: string): Promise<WalletLimit | null> {
    return this.walletLimits.get(walletId) || null;
  }

  async saveWalletLimits(data: WalletLimit): Promise<WalletLimit> {
    this.walletLimits.set(data.wallet_id, data);
    return data;
  }

  async saveWalletProviderEvent(
    data: Omit<WalletProviderEvent, 'id' | 'processed_at'>
  ): Promise<void> {
    const event: WalletProviderEvent = {
      ...data,
      id: crypto.randomUUID(),
      processed_at: new Date().toISOString(),
    };
    this.walletProviderEvents.set(event.idempotency_key, event);
  }

  async getWalletProviderEvent(idempotencyKey: string): Promise<WalletProviderEvent | null> {
    return this.walletProviderEvents.get(idempotencyKey) || null;
  }

  // Merchant Sessions
  async getMerchantSession(userId: string, merchant: string): Promise<MerchantSessionRecord | null> {
    const key = `${userId}:${merchant.toLowerCase()}`;
    return this.merchantSessions.get(key) || null;
  }

  async saveMerchantSession(
    data: Omit<MerchantSessionRecord, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MerchantSessionRecord> {
    const key = `${data.userId}:${data.merchant.toLowerCase()}`;
    const existing = this.merchantSessions.get(key);
    const now = new Date().toISOString();
    if (existing) {
      existing.authState = data.authState;
      existing.sessionState = data.sessionState;
      if (data.browserProfileReference) existing.browserProfileReference = data.browserProfileReference;
      existing.lastVerifiedAt = data.lastVerifiedAt;
      existing.lastUsedAt = data.lastUsedAt;
      existing.updatedAt = now;
      return existing;
    }

    const session: MerchantSessionRecord = {
      ...data,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.merchantSessions.set(key, session);
    return session;
  }

  // User Addresses
  async getUserAddresses(userId: string, merchant?: string): Promise<SavedAddress[]> {
    return Array.from(this.userAddresses.values()).filter((addr) => {
      if (addr.userId !== userId) return false;
      if (merchant && addr.merchant && addr.merchant.toLowerCase() !== merchant.toLowerCase()) {
        return false;
      }
      return true;
    });
  }

  async saveUserAddress(data: Omit<SavedAddress, 'id'>): Promise<SavedAddress> {
    const id = crypto.randomUUID();
    const address: SavedAddress = {
      ...data,
      id,
    };
    this.userAddresses.set(id, address);
    return address;
  }

  async getDefaultUserAddress(userId: string, merchant?: string): Promise<SavedAddress | null> {
    const addresses = await this.getUserAddresses(userId, merchant);
    const def = addresses.find((a) => a.isDefault);
    return def || addresses[0] || null;
  }
}

