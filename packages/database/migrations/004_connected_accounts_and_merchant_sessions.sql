-- ====================================================================
-- Migration: 004_connected_accounts_and_merchant_sessions.sql
-- Additive PostgreSQL / Supabase Migration for Connected Accounts,
-- Merchant Sessions & User Delivery Addresses V2
--
-- Tables:
-- 1. merchant_sessions (User authenticated browser session state per merchant)
-- 2. user_addresses (Verified saved delivery addresses for shopping/commerce)
--
-- Safety Guarantees:
-- - Non-destructive: Does NOT drop, alter, or reset existing tables or data.
-- - Uses CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS.
-- - Zero plaintext secret storage: Passwords/secrets are prohibited in plaintext.
-- ====================================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Helper function to automatically update updated_at timestamp (idempotent)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ====================================================================
-- 1. MERCHANT SESSIONS (Persistent Authenticated Merchant Sessions)
-- ====================================================================
CREATE TABLE IF NOT EXISTS merchant_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant VARCHAR(100) NOT NULL,
    auth_state VARCHAR(50) DEFAULT 'IDLE' NOT NULL,
    session_state JSONB DEFAULT '{}'::jsonb NOT NULL,
    browser_profile_reference TEXT,
    last_verified_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    last_used_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    CONSTRAINT uq_merchant_sessions_user_merchant UNIQUE (user_id, merchant)
);

CREATE INDEX IF NOT EXISTS idx_merchant_sessions_user_id ON merchant_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_merchant_sessions_merchant ON merchant_sessions(merchant);
CREATE INDEX IF NOT EXISTS idx_merchant_sessions_auth_state ON merchant_sessions(auth_state);

DROP TRIGGER IF EXISTS update_merchant_sessions_updated_at ON merchant_sessions;
CREATE TRIGGER update_merchant_sessions_updated_at
    BEFORE UPDATE ON merchant_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ====================================================================
-- 2. USER ADDRESSES (Saved Delivery Addresses for Commerce Orders)
-- ====================================================================
CREATE TABLE IF NOT EXISTS user_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant VARCHAR(100),
    label VARCHAR(100) DEFAULT 'Home' NOT NULL,
    recipient_name VARCHAR(255),
    phone VARCHAR(50),
    address_line1 TEXT NOT NULL,
    address_line2 TEXT,
    city VARCHAR(100) NOT NULL,
    pincode VARCHAR(20) NOT NULL,
    state VARCHAR(100),
    is_default BOOLEAN DEFAULT FALSE NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_addresses_user_id ON user_addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_user_addresses_merchant ON user_addresses(merchant);

DROP TRIGGER IF EXISTS update_user_addresses_updated_at ON user_addresses;
CREATE TRIGGER update_user_addresses_updated_at
    BEFORE UPDATE ON user_addresses
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ====================================================================
-- 3. ROW LEVEL SECURITY (RLS) POLICIES
-- ====================================================================
ALTER TABLE merchant_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_addresses ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'merchant_sessions' AND policyname = 'Users can view own merchant sessions'
    ) THEN
        CREATE POLICY "Users can view own merchant sessions"
            ON merchant_sessions FOR SELECT
            USING (auth.uid() = user_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'merchant_sessions' AND policyname = 'Service role full access on merchant_sessions'
    ) THEN
        CREATE POLICY "Service role full access on merchant_sessions"
            ON merchant_sessions FOR ALL
            USING (auth.role() = 'service_role');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'user_addresses' AND policyname = 'Users can view own addresses'
    ) THEN
        CREATE POLICY "Users can view own addresses"
            ON user_addresses FOR SELECT
            USING (auth.uid() = user_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'user_addresses' AND policyname = 'Service role full access on user_addresses'
    ) THEN
        CREATE POLICY "Service role full access on user_addresses"
            ON user_addresses FOR ALL
            USING (auth.role() = 'service_role');
    END IF;
END $$;
