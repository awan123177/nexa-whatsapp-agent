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
} from '@nexa/shared';

export interface IDatabaseRepository {
  // Users & Connections
  findOrCreateUserByPhone(phoneNumber: string, name?: string): Promise<User>;
  getUserById(id: string): Promise<User | null>;
  updateUser(userId: string, updates: Partial<User>): Promise<User>;
  
  // Conversations & Messages
  getOrCreateActiveConversation(userId: string, channel?: ChannelType): Promise<Conversation>;
  getConversationById(id: string): Promise<Conversation | null>;
  saveMessage(data: Omit<Message, 'id' | 'created_at'>): Promise<Message>;
  getConversationMessages(conversationId: string, limit?: number): Promise<Message[]>;
  getMessageByWhatsAppId(whatsappMessageId: string): Promise<Message | null>;

  // Tool Calls
  saveToolCall(data: Omit<ToolCallRecord, 'id' | 'created_at'>): Promise<ToolCallRecord>;
  getToolCallsForConversation(conversationId: string): Promise<ToolCallRecord[]>;

  // Approvals
  createApproval(data: Omit<Approval, 'id' | 'requested_at'>): Promise<Approval>;
  getPendingApproval(conversationId: string): Promise<Approval | null>;
  updateApprovalStatus(approvalId: string, status: ApprovalStatus, respondedAt?: string): Promise<Approval>;

  // Memories
  saveMemory(data: Omit<Memory, 'id' | 'created_at' | 'updated_at'>): Promise<Memory>;
  getUserMemories(userId: string, category?: string): Promise<Memory[]>;
  deleteMemory(id: string, userId: string): Promise<boolean>;

  // Tasks
  createTask(data: Omit<Task, 'id' | 'created_at' | 'updated_at'>): Promise<Task>;
  getUserTasks(userId: string): Promise<Task[]>;

  // Connected Accounts (OAuth)
  saveConnectedAccount(data: Omit<ConnectedAccount, 'id' | 'created_at' | 'updated_at'>): Promise<ConnectedAccount>;
  getConnectedAccount(userId: string, provider: string): Promise<ConnectedAccount | null>;
  updateConnectedAccountStatus(userId: string, provider: string, status: 'active' | 'revoked' | 'expired'): Promise<ConnectedAccount | null>;
  deleteConnectedAccount(userId: string, provider: string): Promise<boolean>;

  // Audit Logs
  saveAuditLog(data: Omit<AuditLog, 'id' | 'created_at'>): Promise<void>;

  // NEXA Wallet Operations
  getOrCreateWallet(userId: string, currency?: string): Promise<Wallet>;
  getWalletByUserId(userId: string): Promise<Wallet | null>;
  getWalletById(walletId: string): Promise<Wallet | null>;
  createWalletTransaction(data: Omit<WalletTransaction, 'id' | 'created_at' | 'updated_at'>): Promise<WalletTransaction>;
  getWalletTransactions(walletId: string, limit?: number): Promise<WalletTransaction[]>;
  getTransactionByIdempotencyKey(key: string): Promise<WalletTransaction | null>;
  updateWalletBalance(walletId: string, newBalanceMinor: number): Promise<Wallet>;
  createWalletTopup(data: Omit<WalletTopup, 'id' | 'created_at'>): Promise<WalletTopup>;
  getWalletTopupByIdempotencyKey(key: string): Promise<WalletTopup | null>;
  updateWalletTopupStatus(id: string, status: TopupStatus, completedAt?: string): Promise<WalletTopup>;
  getWalletLimits(walletId: string): Promise<WalletLimit | null>;
  saveWalletLimits(data: WalletLimit): Promise<WalletLimit>;
  saveWalletProviderEvent(data: Omit<WalletProviderEvent, 'id' | 'processed_at'>): Promise<void>;
  getWalletProviderEvent(idempotencyKey: string): Promise<WalletProviderEvent | null>;
}
