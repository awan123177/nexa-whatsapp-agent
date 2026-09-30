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
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.users.set(newUser.id, newUser);
    return newUser;
  }

  async getUserById(id: string): Promise<User | null> {
    return this.users.get(id) || null;
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
      existing.updated_at = now;
      return existing;
    }

    const memory: Memory = {
      ...data,
      id: crypto.randomUUID(),
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
}
