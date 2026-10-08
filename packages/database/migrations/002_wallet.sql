-- ====================================================================
-- Migration: 002_wallet.sql
-- Additive PostgreSQL / Supabase Migration for NEXA Wallet Architecture
--
-- Tables:
-- 1. wallets
-- 2. wallet_transactions
-- 3. wallet_topups
-- 4. wallet_payment_requests
-- 5. wallet_limits
-- 6. wallet_provider_events
-- 7. wallet_audit_logs
--
-- Safety Guarantees:
-- - Non-destructive: Does NOT drop, alter, or reset existing tables or data.
-- - Uses CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS.
-- - Idempotent triggers and Row Level Security (RLS) policies.
-- - Monetary amounts stored strictly as INTEGER minor units (paise), never floats.
-- - Zero secret storage: No card numbers, CVVs, passwords, or OTPs.
-- ====================================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Helper function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ====================================================================
-- 1. WALLETS (Core User Balance Ledger)
-- ====================================================================
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

-- ====================================================================
-- 2. WALLET TRANSACTIONS (Double-Entry Transaction History)
-- ====================================================================
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

-- ====================================================================
-- 3. WALLET TOPUPS (UPI / Payment Gateway Top-up Intents)
-- ====================================================================
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

-- ====================================================================
-- 4. WALLET PAYMENT REQUESTS (Pending Approvals & Transfers)
-- ====================================================================
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

-- ====================================================================
-- 5. WALLET LIMITS (Per-transaction, Daily, and Monthly Thresholds)
-- ====================================================================
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

-- ====================================================================
-- 6. WALLET PROVIDER EVENTS (Idempotent Webhook Event Log)
-- ====================================================================
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

-- ====================================================================
-- 7. WALLET AUDIT LOGS (Compliance & Security Tracking)
-- ====================================================================
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

-- ====================================================================
-- 8. ATOMIC BALANCE HELPER FUNCTION
-- ====================================================================
CREATE OR REPLACE FUNCTION atomic_update_wallet_balance(
    p_wallet_id UUID,
    p_amount_delta INTEGER
)
RETURNS INTEGER AS $$
DECLARE
    v_new_balance INTEGER;
BEGIN
    UPDATE wallets
    SET balance_minor = balance_minor + p_amount_delta,
        updated_at = NOW()
    WHERE id = p_wallet_id
      AND (balance_minor + p_amount_delta) >= 0
    RETURNING balance_minor INTO v_new_balance;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient wallet balance or wallet not found';
    END IF;

    RETURN v_new_balance;
END;
$$ LANGUAGE plpgsql;

-- ====================================================================
-- 9. ROW LEVEL SECURITY (RLS) POLICIES
-- ====================================================================
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_topups ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_payment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_audit_logs ENABLE ROW LEVEL SECURITY;

-- 9.1 Service Role Policies (Backend full access without bypassing security)
DROP POLICY IF EXISTS "service_role_wallets_all" ON wallets;
CREATE POLICY "service_role_wallets_all" ON wallets
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_wallet_transactions_all" ON wallet_transactions;
CREATE POLICY "service_role_wallet_transactions_all" ON wallet_transactions
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_wallet_topups_all" ON wallet_topups;
CREATE POLICY "service_role_wallet_topups_all" ON wallet_topups
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_wallet_payment_requests_all" ON wallet_payment_requests;
CREATE POLICY "service_role_wallet_payment_requests_all" ON wallet_payment_requests
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_wallet_limits_all" ON wallet_limits;
CREATE POLICY "service_role_wallet_limits_all" ON wallet_limits
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_wallet_provider_events_all" ON wallet_provider_events;
CREATE POLICY "service_role_wallet_provider_events_all" ON wallet_provider_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_wallet_audit_logs_all" ON wallet_audit_logs;
CREATE POLICY "service_role_wallet_audit_logs_all" ON wallet_audit_logs
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 9.2 Authenticated User Policies (Strict per-user boundary isolation)
DROP POLICY IF EXISTS "users_manage_own_wallets" ON wallets;
CREATE POLICY "users_manage_own_wallets" ON wallets
    FOR ALL TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_read_own_wallet_transactions" ON wallet_transactions;
CREATE POLICY "users_read_own_wallet_transactions" ON wallet_transactions
    FOR SELECT TO authenticated
    USING (wallet_id IN (SELECT id FROM wallets WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "users_read_own_wallet_topups" ON wallet_topups;
CREATE POLICY "users_read_own_wallet_topups" ON wallet_topups
    FOR SELECT TO authenticated
    USING (wallet_id IN (SELECT id FROM wallets WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "users_manage_own_payment_requests" ON wallet_payment_requests;
CREATE POLICY "users_manage_own_payment_requests" ON wallet_payment_requests
    FOR ALL TO authenticated
    USING (wallet_id IN (SELECT id FROM wallets WHERE user_id = auth.uid()))
    WITH CHECK (wallet_id IN (SELECT id FROM wallets WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "users_read_own_wallet_limits" ON wallet_limits;
CREATE POLICY "users_read_own_wallet_limits" ON wallet_limits
    FOR SELECT TO authenticated
    USING (wallet_id IN (SELECT id FROM wallets WHERE user_id = auth.uid()));
