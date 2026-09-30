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

    return (data as User) || null;
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
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to retrieve messages: ${error.message}`);
    }

    return (data as Message[]) || [];
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

  async updateApprovalStatus(
    approvalId: string,
    status: ApprovalStatus,
    respondedAt?: string
  ): Promise<Approval> {
    const { data, error } = await this.client
      .from('approvals')
      .update({
        status,
        responded_at: respondedAt || new Date().toISOString(),
      })
      .eq('id', approvalId)
      .select()
      .single();

    if (error || !data) {
      throw new Error(`Failed to update approval status: ${error?.message}`);
    }

    return data as Approval;
  }

  async saveMemory(data: Omit<Memory, 'id' | 'created_at' | 'updated_at'>): Promise<Memory> {
    const { data: created, error } = await this.client
      .from('memories')
      .upsert(
        {
          ...data,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id, category, key' }
      )
      .select()
      .single();

    if (error || !created) {
      throw new Error(`Failed to save memory: ${error?.message}`);
    }

    return created as Memory;
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

    return (data as Memory[]) || [];
  }

  async deleteMemory(id: string, userId: string): Promise<boolean> {
    const { error } = await this.client
      .from('memories')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    return !error;
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
}
