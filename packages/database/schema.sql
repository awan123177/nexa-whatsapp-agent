-- ====================================================================
-- NEXA Agent - PostgreSQL / Supabase Database Schema
-- Production-ready schema with Foreign Keys, Indexes, Constraints, and RLS
-- ====================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. USERS
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number VARCHAR(32) UNIQUE NOT NULL,
    name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'user' NOT NULL,
    status VARCHAR(50) DEFAULT 'active' NOT NULL,
    preferences JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_phone_number ON users(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- 2. WHATSAPP CONNECTIONS
CREATE TABLE IF NOT EXISTS whatsapp_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone_number_id VARCHAR(100) NOT NULL,
    wa_id VARCHAR(100) NOT NULL,
    display_phone_number VARCHAR(50),
    status VARCHAR(50) DEFAULT 'connected' NOT NULL,
    verified_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    CONSTRAINT uq_whatsapp_connections_wa_id UNIQUE (wa_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_user_id ON whatsapp_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_wa_id ON whatsapp_connections(wa_id);

-- 3. ACTIVATION TOKENS
CREATE TABLE IF NOT EXISTS activation_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    purpose VARCHAR(100) DEFAULT 'activation' NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activation_tokens_user_id ON activation_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_activation_tokens_token_hash ON activation_tokens(token_hash);

-- 4. CONVERSATIONS
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel VARCHAR(50) DEFAULT 'whatsapp' NOT NULL,
    status VARCHAR(50) DEFAULT 'active' NOT NULL,
    title VARCHAR(255),
    metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);

-- 5. MESSAGES
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_type VARCHAR(50) NOT NULL CHECK (sender_type IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    media_url TEXT,
    media_type VARCHAR(100),
    whatsapp_message_id VARCHAR(255) UNIQUE,
    raw_payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_whatsapp_message_id ON messages(whatsapp_message_id);

-- 6. MEMORIES (User-Approved Long Term Memory)
CREATE TABLE IF NOT EXISTS memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category VARCHAR(100) NOT NULL,
    key VARCHAR(255) NOT NULL,
    value TEXT NOT NULL,
    confidence FLOAT DEFAULT 1.0 NOT NULL,
    source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    CONSTRAINT uq_user_category_key UNIQUE (user_id, category, key)
);

CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);

-- 7. TASKS (Background Jobs & Reminders)
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'pending' NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
    cron_expression VARCHAR(100),
    next_run_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_next_run_at ON tasks(next_run_at);

-- 8. TOOL CALLS (Audit & Execution Trace)
CREATE TABLE IF NOT EXISTS tool_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    tool_name VARCHAR(100) NOT NULL,
    arguments JSONB NOT NULL,
    result JSONB,
    status VARCHAR(50) NOT NULL CHECK (status IN ('success', 'failed', 'requires_approval', 'rejected')),
    duration_ms INTEGER,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_conversation_id ON tool_calls(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_status ON tool_calls(status);

-- 9. APPROVALS (Confirmation Engine)
CREATE TABLE IF NOT EXISTS approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tool_name VARCHAR(100) NOT NULL,
    arguments JSONB NOT NULL,
    summary TEXT NOT NULL,
    impact_level VARCHAR(50) DEFAULT 'high' NOT NULL CHECK (impact_level IN ('low', 'medium', 'high', 'critical')),
    status VARCHAR(50) DEFAULT 'pending' NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    requested_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    responded_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '1 hour') NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approvals_user_id ON approvals(user_id);
CREATE INDEX IF NOT EXISTS idx_approvals_conversation_id ON approvals(conversation_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

-- 10. CONNECTED ACCOUNTS (OAuth / External Services)
CREATE TABLE IF NOT EXISTS connected_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(100) NOT NULL,
    account_id VARCHAR(255) NOT NULL,
    scopes TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,
    token_data JSONB DEFAULT '{}'::jsonb NOT NULL,
    status VARCHAR(50) DEFAULT 'active' NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    CONSTRAINT uq_connected_accounts_user_provider UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_connected_accounts_user_id ON connected_accounts(user_id);

-- 11. AUDIT LOGS (Security & Compliance)
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    resource VARCHAR(100) NOT NULL,
    details JSONB DEFAULT '{}'::jsonb NOT NULL,
    ip_address VARCHAR(45),
    status VARCHAR(50) DEFAULT 'success' NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- Helper function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_conversations_updated_at ON conversations;
CREATE TRIGGER update_conversations_updated_at BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_memories_updated_at ON memories;
CREATE TRIGGER update_memories_updated_at BEFORE UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_tasks_updated_at ON tasks;
CREATE TRIGGER update_tasks_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_connected_accounts_updated_at ON connected_accounts;
CREATE TRIGGER update_connected_accounts_updated_at BEFORE UPDATE ON connected_accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ====================================================================
-- 12. IDENTITY & MEMORY V2 (Additive, Non-destructive)
-- ====================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_name VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_confirmed BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_source VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_title VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS title_confirmed BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS title_source VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS memory_version INTEGER DEFAULT 1;

ALTER TABLE memories ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'USER_PROVIDED';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS confirmed BOOLEAN DEFAULT TRUE;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_memories_user_category ON memories(user_id, category);
CREATE INDEX IF NOT EXISTS idx_users_preferred_title ON users(preferred_title);

-- ====================================================================
-- 13. WALLET ARCHITECTURE (Ledger, Transactions, Top-ups & Limits)
-- ====================================================================

-- 13.1 WALLETS
CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    currency VARCHAR(10) DEFAULT 'INR' NOT NULL,
    balance_minor INTEGER DEFAULT 0 NOT NULL CHECK (balance_minor >= 0),
    status VARCHAR(50) DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'frozen', 'closed')),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    CONSTRAINT uq_wallets_user_id UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_status ON wallets(status);

DROP TRIGGER IF EXISTS update_wallets_updated_at ON wallets;
CREATE TRIGGER update_wallets_updated_at
    BEFORE UPDATE ON wallets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 13.2 WALLET TRANSACTIONS
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('topup', 'payment', 'transfer', 'refund', 'adjustment')),
    amount_minor INTEGER NOT NULL,
    currency VARCHAR(10) DEFAULT 'INR' NOT NULL,
    balance_after_minor INTEGER NOT NULL CHECK (balance_after_minor >= 0),
    status VARCHAR(50) DEFAULT 'PENDING' NOT NULL CHECK (status IN (
        'PENDING',
        'AUTHORIZED',
        'PROCESSING',
        'SUCCEEDED',
        'FAILED',
        'CANCELLED',
        'REFUNDED'
    )),
    recipient VARCHAR(255),
    description TEXT NOT NULL,
    reference_id VARCHAR(255),
    metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    CONSTRAINT uq_wallet_transactions_idempotency_key UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_id ON wallet_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_idempotency_key ON wallet_transactions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_status ON wallet_transactions(status);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_type ON wallet_transactions(type);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_at ON wallet_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_reference_id ON wallet_transactions(reference_id);

DROP TRIGGER IF EXISTS update_wallet_transactions_updated_at ON wallet_transactions;
CREATE TRIGGER update_wallet_transactions_updated_at
    BEFORE UPDATE ON wallet_transactions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 13.3 WALLET TOPUPS
CREATE TABLE IF NOT EXISTS wallet_topups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(255) NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    currency VARCHAR(10) DEFAULT 'INR' NOT NULL,
    provider VARCHAR(50) NOT NULL CHECK (provider IN ('upi_qr', 'razorpay', 'stripe', 'mock')),
    provider_intent_id VARCHAR(255),
    qr_code_data TEXT,
    payment_url TEXT,
    status VARCHAR(50) DEFAULT 'PENDING' NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    completed_at TIMESTAMPTZ,
    CONSTRAINT uq_wallet_topups_idempotency_key UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_wallet_topups_wallet_id ON wallet_topups(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_topups_idempotency_key ON wallet_topups(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_wallet_topups_status ON wallet_topups(status);
CREATE INDEX IF NOT EXISTS idx_wallet_topups_provider_intent_id ON wallet_topups(provider_intent_id);
CREATE INDEX IF NOT EXISTS idx_wallet_topups_created_at ON wallet_topups(created_at DESC);

-- 13.4 WALLET PAYMENT REQUESTS
CREATE TABLE IF NOT EXISTS wallet_payment_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(255) NOT NULL,
    recipient VARCHAR(255) NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    currency VARCHAR(10) DEFAULT 'INR' NOT NULL,
    reason TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending_approval' NOT NULL CHECK (status IN (
        'pending_approval',
        'approved',
        'rejected',
        'executed',
        'failed'
    )),
    approval_id UUID REFERENCES approvals(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_wallet_payment_requests_idempotency_key UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_wallet_payment_requests_wallet_id ON wallet_payment_requests(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_payment_requests_idempotency_key ON wallet_payment_requests(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_wallet_payment_requests_status ON wallet_payment_requests(status);
CREATE INDEX IF NOT EXISTS idx_wallet_payment_requests_approval_id ON wallet_payment_requests(approval_id);
CREATE INDEX IF NOT EXISTS idx_wallet_payment_requests_created_at ON wallet_payment_requests(created_at DESC);

-- 13.5 WALLET LIMITS
CREATE TABLE IF NOT EXISTS wallet_limits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    daily_limit_minor INTEGER DEFAULT 0 NOT NULL CHECK (daily_limit_minor >= 0),
    monthly_limit_minor INTEGER DEFAULT 0 NOT NULL CHECK (monthly_limit_minor >= 0),
    single_tx_limit_minor INTEGER DEFAULT 0 NOT NULL CHECK (single_tx_limit_minor >= 0),
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    CONSTRAINT uq_wallet_limits_wallet_id UNIQUE (wallet_id)
);

CREATE INDEX IF NOT EXISTS idx_wallet_limits_wallet_id ON wallet_limits(wallet_id);

DROP TRIGGER IF EXISTS update_wallet_limits_updated_at ON wallet_limits;
CREATE TRIGGER update_wallet_limits_updated_at
    BEFORE UPDATE ON wallet_limits
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 13.6 WALLET PROVIDER EVENTS
CREATE TABLE IF NOT EXISTS wallet_provider_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(100) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb NOT NULL,
    processed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    CONSTRAINT uq_wallet_provider_events_idempotency_key UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_wallet_provider_events_idempotency_key ON wallet_provider_events(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_wallet_provider_events_provider ON wallet_provider_events(provider);
CREATE INDEX IF NOT EXISTS idx_wallet_provider_events_processed_at ON wallet_provider_events(processed_at DESC);

-- 13.7 WALLET AUDIT LOGS
CREATE TABLE IF NOT EXISTS wallet_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    action VARCHAR(100) NOT NULL,
    actor VARCHAR(100) NOT NULL,
    details JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wallet_audit_logs_wallet_id ON wallet_audit_logs(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_audit_logs_action ON wallet_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_wallet_audit_logs_created_at ON wallet_audit_logs(created_at DESC);


