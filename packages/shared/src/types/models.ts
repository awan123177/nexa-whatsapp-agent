export type UserRole = 'user' | 'admin' | 'tester';
export type UserStatus = 'active' | 'suspended' | 'pending';
export type NameSource = 'USER_PROVIDED' | 'USER_CONFIRMED' | 'WHATSAPP_PROFILE_UNCONFIRMED';

export interface User {
  id: string;
  phone_number: string;
  name?: string | null;
  role: UserRole;
  status: UserStatus;
  preferences: Record<string, unknown>;
  preferred_name?: string | null;
  name_confirmed?: boolean;
  name_source?: NameSource | null;
  created_at: string;
  updated_at: string;
}

export interface WhatsAppConnection {
  id: string;
  user_id: string;
  phone_number_id: string;
  wa_id: string;
  display_phone_number?: string | null;
  status: 'connected' | 'disconnected';
  verified_at: string;
  created_at: string;
}

export type ChannelType = 'whatsapp' | 'web' | 'api';
export type ConversationStatus = 'active' | 'paused' | 'archived';

export interface Conversation {
  id: string;
  user_id: string;
  channel: ChannelType;
  status: ConversationStatus;
  title?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type SenderType = 'user' | 'assistant' | 'system';
export type MediaType = 'audio' | 'image' | 'document' | 'video';

export interface Message {
  id: string;
  conversation_id: string;
  sender_type: SenderType;
  content: string;
  media_url?: string | null;
  media_type?: MediaType | null;
  whatsapp_message_id?: string | null;
  raw_payload?: Record<string, unknown> | null;
  created_at: string;
}

export type MemoryCategory = 'preference' | 'travel' | 'profile' | 'fact' | 'work';

export interface Memory {
  id: string;
  user_id: string;
  category: MemoryCategory;
  key: string;
  value: string;
  confidence: number;
  source_message_id?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  user_id: string;
  title: string;
  description?: string | null;
  status: TaskStatus;
  cron_expression?: string | null;
  next_run_at?: string | null;
  last_run_at?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type ToolCallStatus = 'success' | 'failed' | 'requires_approval' | 'rejected';

export interface ToolCallRecord {
  id: string;
  conversation_id: string;
  message_id?: string | null;
  tool_name: string;
  arguments: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  status: ToolCallStatus;
  duration_ms?: number | null;
  error?: string | null;
  created_at: string;
}

export type ApprovalImpactLevel = 'low' | 'medium' | 'high' | 'critical';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface Approval {
  id: string;
  conversation_id: string;
  user_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  summary: string;
  impact_level: ApprovalImpactLevel;
  status: ApprovalStatus;
  requested_at: string;
  responded_at?: string | null;
  expires_at: string;
  metadata: Record<string, unknown>;
}

export interface ConnectedAccount {
  id: string;
  user_id: string;
  provider: string;
  account_id: string;
  scopes: string[];
  token_data: Record<string, unknown>;
  status: 'active' | 'revoked' | 'expired';
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: string;
  user_id?: string | null;
  action: string;
  resource: string;
  details: Record<string, unknown>;
  ip_address?: string | null;
  status: 'success' | 'failure';
  created_at: string;
}
