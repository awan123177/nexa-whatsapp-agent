import { createClient, SupabaseClient } from '@supabase/supabase-js';
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

export class SupabaseRepository implements IDatabaseRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.client = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  async findOrCreateUserByPhone(phoneNumber: string, name?: string): Promise<User> {
    const { data: existing, error: findError } = await this.client
      .from('users')
      .select('*')
      .eq('phone_number', phoneNumber)
      .maybeSingle();

    if (findError) {
      throw new Error(`Failed to find user: ${findError.message}`);
    }

    if (existing) {
      if (name && !existing.name) {
        const { data: updated, error: updateError } = await this.client
          .from('users')
          .update({ name, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
          .select()
          .single();
        if (!updateError && updated) return updated as User;
      }
      return existing as User;
    }

    const { data: created, error: createError } = await this.client
      .from('users')
      .insert({
        phone_number: phoneNumber,
        name: name || null,
        role: 'user',
        status: 'active',
        preferences: {},
      })
      .select()
      .single();

    if (createError || !created) {
      throw new Error(`Failed to create user: ${createError?.message}`);
    }

    return created as User;
  }

  async getUserById(id: string): Promise<User | null> {
    const { data, error } = await this.client
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get user: ${error.message}`);
    }

    if (!data) return null;
    const user = data as User;
    if (user.preferences) {
      user.preferred_name = (user.preferences.preferred_name as string) || user.preferred_name || null;
      user.name_confirmed = Boolean(user.preferences.name_confirmed ?? user.name_confirmed);
      user.name_source = (user.preferences.name_source as any) || user.name_source || null;
      user.preferred_title = (user.preferences.preferred_title as string) || user.preferred_title || null;
      user.title_confirmed = Boolean(user.preferences.title_confirmed ?? user.title_confirmed);
      user.title_source = (user.preferences.title_source as any) || user.title_source || null;
      user.memory_version = (user.preferences.memory_version as number) || user.memory_version || 1;
    }
    return user;
  }

  async updateUser(userId: string, updates: Partial<User>): Promise<User> {
    const existing = await this.getUserById(userId);
    const updatedPreferences = {
      ...(existing?.preferences || {}),
      ...(updates.preferences || {}),
    };
    if (updates.preferred_name !== undefined) updatedPreferences.preferred_name = updates.preferred_name;
    if (updates.name_confirmed !== undefined) updatedPreferences.name_confirmed = updates.name_confirmed;
    if (updates.name_source !== undefined) updatedPreferences.name_source = updates.name_source;
    if (updates.preferred_title !== undefined) updatedPreferences.preferred_title = updates.preferred_title;
    if (updates.title_confirmed !== undefined) updatedPreferences.title_confirmed = updates.title_confirmed;
    if (updates.title_source !== undefined) updatedPreferences.title_source = updates.title_source;
    if (updates.memory_version !== undefined) updatedPreferences.memory_version = updates.memory_version;

    const dbPayload: any = {
      ...updates,
      preferences: updatedPreferences,
      updated_at: new Date().toISOString(),
    };
    delete dbPayload.preferred_name;
    delete dbPayload.name_confirmed;
    delete dbPayload.name_source;
    delete dbPayload.preferred_title;
    delete dbPayload.title_confirmed;
    delete dbPayload.title_source;
    delete dbPayload.memory_version;

    const { data, error } = await this.client
      .from('users')
      .update(dbPayload)
      .eq('id', userId)
      .select()
      .single();

    if (error || !data) {
      throw new Error(`Failed to update user: ${error?.message}`);
    }

    const res = data as User;
    res.preferred_name = (updatedPreferences.preferred_name as string) || null;
    res.name_confirmed = Boolean(updatedPreferences.name_confirmed);
    res.name_source = (updatedPreferences.name_source as any) || null;
    res.preferred_title = (updatedPreferences.preferred_title as string) || null;
    res.title_confirmed = Boolean(updatedPreferences.title_confirmed);
    res.title_source = (updatedPreferences.title_source as any) || null;
    res.memory_version = (updatedPreferences.memory_version as number) || 1;
    return res;
  }

  async getOrCreateActiveConversation(userId: string, channel: ChannelType = 'whatsapp'): Promise<Conversation> {
    const { data: existing, error: findError } = await this.client
      .from('conversations')
      .select('*')
      .eq('user_id', userId)
      .eq('channel', channel)
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (findError) {
      throw new Error(`Failed to find active conversation: ${findError.message}`);
    }

    if (existing) {
      return existing as Conversation;
    }

    const { data: created, error: createError } = await this.client
      .from('conversations')
      .insert({
        user_id: userId,
        channel,
        status: 'active',
        title: 'WhatsApp Conversation',
        metadata: {},
      })
      .select()
      .single();

    if (createError || !created) {
      throw new Error(`Failed to create conversation: ${createError?.message}`);
    }

    return created as Conversation;
  }

  async getConversationById(id: string): Promise<Conversation | null> {
    const { data, error } = await this.client
      .from('conversations')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get conversation: ${error.message}`);
    }

    return (data as Conversation) || null;
  }

  async saveMessage(data: Omit<Message, 'id' | 'created_at'>): Promise<Message> {
    const { data: created, error } = await this.client
      .from('messages')
      .insert(data)
      .select()
      .single();

    if (error || !created) {
      throw new Error(`Failed to save message: ${error?.message}`);
    }

    // Update conversation timestamp
    await this.client
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', data.conversation_id);

    return created as Message;
  }

  async getConversationMessages(conversationId: string, limit = 20): Promise<Message[]> {
    const { data, error } = await this.client
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to retrieve messages: ${error.message}`);
    }

    const messages = (data as Message[]) || [];
    return messages.reverse();
  }

  async getMessageByWhatsAppId(whatsappMessageId: string): Promise<Message | null> {
    const { data, error } = await this.client
      .from('messages')
      .select('*')
      .eq('whatsapp_message_id', whatsappMessageId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to check WhatsApp message ID: ${error.message}`);
    }

    return (data as Message) || null;
  }

  async saveToolCall(data: Omit<ToolCallRecord, 'id' | 'created_at'>): Promise<ToolCallRecord> {
    const { data: created, error } = await this.client
      .from('tool_calls')
      .insert(data)
      .select()
      .single();

    if (error || !created) {
      throw new Error(`Failed to save tool call: ${error?.message}`);
    }

    return created as ToolCallRecord;
  }

  async getToolCallsForConversation(conversationId: string): Promise<ToolCallRecord[]> {
    const { data, error } = await this.client
      .from('tool_calls')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to retrieve tool calls: ${error.message}`);
    }

    return (data as ToolCallRecord[]) || [];
  }

  async createApproval(data: Omit<Approval, 'id' | 'requested_at'>): Promise<Approval> {
    const { data: created, error } = await this.client
      .from('approvals')
      .insert(data)
      .select()
      .single();

    if (error || !created) {
      throw new Error(`Failed to create approval: ${error?.message}`);
    }

    return created as Approval;
  }

  async getPendingApproval(conversationId: string): Promise<Approval | null> {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.client
      .from('approvals')
      .select('*')
      .eq('conversation_id', conversationId)
      .eq('status', 'pending')
      .gt('expires_at', nowIso)
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get pending approval: ${error.message}`);
    }

    return (data as Approval) || null;
  }

  async getLatestApproval(conversationId: string): Promise<Approval | null> {
    const { data, error } = await this.client
      .from('approvals')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get latest approval: ${error.message}`);
    }

    return (data as Approval) || null;
  }

  async updateApprovalStatus(
    approvalId: string,
    status: ApprovalStatus,
    respondedAt?: string,
    metadata?: Record<string, unknown>
  ): Promise<Approval> {
    const updatePayload: Record<string, unknown> = {
      status,
      responded_at: respondedAt || new Date().toISOString(),
    };
    if (metadata) {
      updatePayload.metadata = metadata;
    }
    const { data, error } = await this.client
      .from('approvals')
      .update(updatePayload)
      .eq('id', approvalId)
      .select()
      .single();

    if (error || !data) {
      throw new Error(`Failed to update approval status: ${error?.message}`);
    }

    return data as Approval;
  }

  async saveMemory(data: Omit<Memory, 'id' | 'created_at' | 'updated_at'>): Promise<Memory> {
    const memoryMetadata = {
      ...(typeof data.metadata === 'object' && data.metadata !== null ? data.metadata : {}),
      confirmed: data.confirmed ?? true,
    };

    const payload: Record<string, unknown> = {
      ...data,
      metadata: memoryMetadata,
      updated_at: new Date().toISOString(),
    };

    let { data: created, error } = await this.client
      .from('memories')
      .upsert(payload, { onConflict: 'user_id, category, key' })
      .select()
      .single();

    // Resilient fallback if PostgREST schema cache is missing 'confirmed' column (PGRST204)
    if (
      error &&
      (error.code === 'PGRST204' || error.message?.includes('confirmed')) &&
      (error.message?.includes('schema cache') || error.message?.includes('column'))
    ) {
      console.warn(
        `[SupabaseRepository] 'confirmed' column missing from memories schema cache. Retrying upsert with metadata fallback.`
      );
      const fallbackPayload = { ...payload };
      delete fallbackPayload.confirmed;
      fallbackPayload.metadata = {
        ...(typeof data.metadata === 'object' && data.metadata !== null ? data.metadata : {}),
        confirmed: data.confirmed ?? true,
      };

      const fallbackResult = await this.client
        .from('memories')
        .upsert(fallbackPayload, { onConflict: 'user_id, category, key' })
        .select()
        .single();

      created = fallbackResult.data;
      error = fallbackResult.error;
    }

    if (error || !created) {
      throw new Error(`Failed to save memory: ${error?.message}`);
    }

    const row = created as any;
    return {
      ...row,
      confirmed:
        row.confirmed ??
        row.metadata?.confirmed ??
        (row.status === 'active' || Boolean(row.last_confirmed_at)) ??
        true,
    } as Memory;
  }

  async getUserMemories(userId: string, category?: string): Promise<Memory[]> {
    let query = this.client.from('memories').select('*').eq('user_id', userId);
    if (category) {
      query = query.eq('category', category);
    }
    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to retrieve memories: ${error.message}`);
    }

    return ((data as any[]) || []).map((row) => ({
      ...row,
      confirmed:
        row.confirmed ??
        row.metadata?.confirmed ??
        (row.status === 'active' || Boolean(row.last_confirmed_at)) ??
        true,
    })) as Memory[];
  }

  async deleteMemory(id: string, userId: string): Promise<boolean> {
    const { error } = await this.client
      .from('memories')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    return !error;
  }

  async deleteUserMemoriesByCategory(userId: string, category: string): Promise<number> {
    const { data, error } = await this.client
      .from('memories')
      .delete()
      .eq('user_id', userId)
      .eq('category', category)
      .select('id');

    if (error) {
      throw new Error(`Failed to delete memories by category: ${error.message}`);
    }
    return data ? data.length : 0;
  }

  async deleteAllUserMemories(userId: string): Promise<number> {
    const { data, error } = await this.client
      .from('memories')
      .delete()
      .eq('user_id', userId)
      .select('id');

    if (error) {
      throw new Error(`Failed to delete all user memories: ${error.message}`);
    }
    return data ? data.length : 0;
  }

  async createTask(data: Omit<Task, 'id' | 'created_at' | 'updated_at'>): Promise<Task> {
    const { data: created, error } = await this.client
      .from('tasks')
      .insert(data)
      .select()
      .single();

    if (error || !created) {
      throw new Error(`Failed to create task: ${error?.message}`);
    }

    return created as Task;
  }

  async getUserTasks(userId: string): Promise<Task[]> {
    const { data, error } = await this.client
      .from('tasks')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to retrieve tasks: ${error.message}`);
    }

    return (data as Task[]) || [];
  }

  async saveAuditLog(data: Omit<AuditLog, 'id' | 'created_at'>): Promise<void> {
    const { error } = await this.client.from('audit_logs').insert(data);
    if (error) {
      console.error(`Failed to write audit log: ${error.message}`);
    }
  }

  async saveConnectedAccount(
    data: Omit<ConnectedAccount, 'id' | 'created_at' | 'updated_at'>
  ): Promise<ConnectedAccount> {
    const { data: saved, error } = await this.client
      .from('connected_accounts')
      .upsert(
        {
          user_id: data.user_id,
          provider: data.provider,
          account_id: data.account_id,
          scopes: data.scopes,
          token_data: data.token_data,
          status: data.status,
          metadata: data.metadata,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,provider' }
      )
      .select()
      .single();

    if (error || !saved) {
      throw new Error(`Failed to save connected account: ${error?.message}`);
    }

    return saved as ConnectedAccount;
  }

  async getConnectedAccount(userId: string, provider: string): Promise<ConnectedAccount | null> {
    const { data, error } = await this.client
      .from('connected_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', provider)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get connected account: ${error.message}`);
    }

    return (data as ConnectedAccount) || null;
  }

  async updateConnectedAccountStatus(
    userId: string,
    provider: string,
    status: 'active' | 'revoked' | 'expired'
  ): Promise<ConnectedAccount | null> {
    const { data, error } = await this.client
      .from('connected_accounts')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('provider', provider)
      .select()
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to update connected account status: ${error.message}`);
    }

    return (data as ConnectedAccount) || null;
  }

  async deleteConnectedAccount(userId: string, provider: string): Promise<boolean> {
    const { error } = await this.client
      .from('connected_accounts')
      .delete()
      .eq('user_id', userId)
      .eq('provider', provider);

    return !error;
  }

  // NEXA Wallet Operations
  async getOrCreateWallet(userId: string, currency = 'INR'): Promise<Wallet> {
    const existing = await this.getWalletByUserId(userId);
    if (existing) return existing;

    const { data, error } = await this.client
      .from('wallets')
      .insert({
        user_id: userId,
        currency,
        balance_minor: 0,
        status: 'active',
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create wallet: ${error.message}`);
    }

    return data as Wallet;
  }

  async getWalletByUserId(userId: string): Promise<Wallet | null> {
    const { data, error } = await this.client
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get wallet for user: ${error.message}`);
    }

    return (data as Wallet) || null;
  }

  async getWalletById(walletId: string): Promise<Wallet | null> {
    const { data, error } = await this.client
      .from('wallets')
      .select('*')
      .eq('id', walletId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get wallet: ${error.message}`);
    }

    return (data as Wallet) || null;
  }

  async createWalletTransaction(
    data: Omit<WalletTransaction, 'id' | 'created_at' | 'updated_at'>
  ): Promise<WalletTransaction> {
    const { data: created, error } = await this.client
      .from('wallet_transactions')
      .insert(data)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create wallet transaction: ${error.message}`);
    }

    return created as WalletTransaction;
  }

  async getWalletTransactions(walletId: string, limit = 20): Promise<WalletTransaction[]> {
    const { data, error } = await this.client
      .from('wallet_transactions')
      .select('*')
      .eq('wallet_id', walletId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to list wallet transactions: ${error.message}`);
    }

    return (data as WalletTransaction[]) || [];
  }

  async getTransactionByIdempotencyKey(key: string): Promise<WalletTransaction | null> {
    const { data, error } = await this.client
      .from('wallet_transactions')
      .select('*')
      .eq('idempotency_key', key)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get transaction by key: ${error.message}`);
    }

    return (data as WalletTransaction) || null;
  }

  async updateWalletBalance(walletId: string, newBalanceMinor: number): Promise<Wallet> {
    const { data, error } = await this.client
      .from('wallets')
      .update({
        balance_minor: newBalanceMinor,
        updated_at: new Date().toISOString(),
      })
      .eq('id', walletId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update wallet balance: ${error.message}`);
    }

    return data as Wallet;
  }

  async createWalletTopup(data: Omit<WalletTopup, 'id' | 'created_at'>): Promise<WalletTopup> {
    const { data: created, error } = await this.client
      .from('wallet_topups')
      .insert(data)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create wallet topup: ${error.message}`);
    }

    return created as WalletTopup;
  }

  async getWalletTopupByIdempotencyKey(key: string): Promise<WalletTopup | null> {
    const { data, error } = await this.client
      .from('wallet_topups')
      .select('*')
      .or(`idempotency_key.eq.${key},id.eq.${key}`)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get topup by key: ${error.message}`);
    }

    return (data as WalletTopup) || null;
  }

  async updateWalletTopupStatus(
    id: string,
    status: TopupStatus,
    completedAt?: string
  ): Promise<WalletTopup> {
    const updateData: any = { status };
    if (completedAt) updateData.completed_at = completedAt;

    const { data, error } = await this.client
      .from('wallet_topups')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update topup status: ${error.message}`);
    }

    return data as WalletTopup;
  }

  async getWalletLimits(walletId: string): Promise<WalletLimit | null> {
    const { data, error } = await this.client
      .from('wallet_limits')
      .select('*')
      .eq('wallet_id', walletId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get wallet limits: ${error.message}`);
    }

    return (data as WalletLimit) || null;
  }

  async saveWalletLimits(data: WalletLimit): Promise<WalletLimit> {
    const { data: saved, error } = await this.client
      .from('wallet_limits')
      .upsert(data, { onConflict: 'wallet_id' })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to save wallet limits: ${error.message}`);
    }

    return saved as WalletLimit;
  }

  async saveWalletProviderEvent(
    data: Omit<WalletProviderEvent, 'id' | 'processed_at'>
  ): Promise<void> {
    const { error } = await this.client.from('wallet_provider_events').insert(data);
    if (error) {
      throw new Error(`Failed to save wallet provider event: ${error.message}`);
    }
  }

  async getWalletProviderEvent(idempotencyKey: string): Promise<WalletProviderEvent | null> {
    const { data, error } = await this.client
      .from('wallet_provider_events')
      .select('*')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get wallet provider event: ${error.message}`);
    }

    return (data as WalletProviderEvent) || null;
  }

  // Merchant Sessions
  async getMerchantSession(userId: string, merchant: string): Promise<MerchantSessionRecord | null> {
    const { data, error } = await this.client
      .from('merchant_sessions')
      .select('*')
      .eq('user_id', userId)
      .ilike('merchant', merchant)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get merchant session: ${error.message}`);
    }

    if (!data) return null;
    return {
      id: data.id,
      userId: data.user_id,
      merchant: data.merchant,
      authState: data.auth_state,
      sessionState: data.session_state || {},
      browserProfileReference: data.browser_profile_reference,
      lastVerifiedAt: data.last_verified_at,
      lastUsedAt: data.last_used_at,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async saveMerchantSession(
    data: Omit<MerchantSessionRecord, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MerchantSessionRecord> {
    const { data: saved, error } = await this.client
      .from('merchant_sessions')
      .upsert(
        {
          user_id: data.userId,
          merchant: data.merchant,
          auth_state: data.authState,
          session_state: data.sessionState,
          browser_profile_reference: data.browserProfileReference,
          last_verified_at: data.lastVerifiedAt,
          last_used_at: data.lastUsedAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,merchant' }
      )
      .select()
      .single();

    if (error || !saved) {
      throw new Error(`Failed to save merchant session: ${error?.message}`);
    }

    return {
      id: saved.id,
      userId: saved.user_id,
      merchant: saved.merchant,
      authState: saved.auth_state,
      sessionState: saved.session_state || {},
      browserProfileReference: saved.browser_profile_reference,
      lastVerifiedAt: saved.last_verified_at,
      lastUsedAt: saved.last_used_at,
      createdAt: saved.created_at,
      updatedAt: saved.updated_at,
    };
  }

  // User Addresses
  async getUserAddresses(userId: string, merchant?: string): Promise<SavedAddress[]> {
    let query = this.client
      .from('user_addresses')
      .select('*')
      .eq('user_id', userId);

    if (merchant) {
      query = query.or(`merchant.is.null,merchant.ilike.${merchant}`);
    }

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) {
      throw new Error(`Failed to get user addresses: ${error.message}`);
    }

    return (data || []).map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      merchant: row.merchant,
      label: row.label,
      recipientName: row.recipient_name,
      phone: row.phone,
      addressLine1: row.address_line1,
      addressLine2: row.address_line2,
      city: row.city,
      pincode: row.pincode,
      state: row.state,
      isDefault: Boolean(row.is_default),
      metadata: row.metadata || {},
    }));
  }

  async saveUserAddress(data: Omit<SavedAddress, 'id'>): Promise<SavedAddress> {
    const { data: saved, error } = await this.client
      .from('user_addresses')
      .insert({
        user_id: data.userId,
        merchant: data.merchant || null,
        label: data.label,
        recipient_name: data.recipientName || null,
        phone: data.phone || null,
        address_line1: data.addressLine1,
        address_line2: data.addressLine2 || null,
        city: data.city,
        pincode: data.pincode,
        state: data.state || null,
        is_default: Boolean(data.isDefault),
        metadata: data.metadata || {},
      })
      .select()
      .single();

    if (error || !saved) {
      throw new Error(`Failed to save user address: ${error?.message}`);
    }

    return {
      id: saved.id,
      userId: saved.user_id,
      merchant: saved.merchant,
      label: saved.label,
      recipientName: saved.recipient_name,
      phone: saved.phone,
      addressLine1: saved.address_line1,
      addressLine2: saved.address_line2,
      city: saved.city,
      pincode: saved.pincode,
      state: saved.state,
      isDefault: Boolean(saved.is_default),
      metadata: saved.metadata || {},
    };
  }

  async getDefaultUserAddress(userId: string, merchant?: string): Promise<SavedAddress | null> {
    const addresses = await this.getUserAddresses(userId, merchant);
    const def = addresses.find((a) => a.isDefault);
    return def || addresses[0] || null;
  }
}
