-- ====================================================================
-- Migration: 003_computer_use_and_tasks.sql
-- Additive PostgreSQL / Supabase Migration for Autonomous Computer-Use
-- Sessions & Task Execution States
--
-- Tables:
-- 1. browser_sessions (Reusable browser sessions, cart state, action history)
--
-- Alterations:
-- 2. tasks (plan, current_step, verification_state columns)
--
-- Safety Guarantees:
-- - Non-destructive: Does NOT drop, alter, or reset existing tables or data.
-- - Uses CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD COLUMN IF NOT EXISTS,
--   and CREATE INDEX IF NOT EXISTS.
-- - Idempotent triggers and Row Level Security (RLS) policies.
-- - Zero secret storage: No passwords, OTPs, CVVs, or session tokens.
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
-- 1. BROWSER SESSIONS (Autonomous Computer-Use Sessions & Cart State)
-- ====================================================================
CREATE TABLE IF NOT EXISTS browser_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(255) NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    active_url TEXT,
    auth_state VARCHAR(50) DEFAULT 'IDLE' NOT NULL CHECK (auth_state IN (
        'IDLE',
        'AUTH_REQUIRED',
        'AUTHENTICATED',
        'CAPTCHA_REQUIRED',
        'BLOCKED',
        'ERROR'
    )),
    metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
    cart_state JSONB DEFAULT '{"items": [], "totalMinor": 0, "currency": "INR", "itemCount": 0, "verified": false}'::jsonb NOT NULL,
    action_history JSONB DEFAULT '[]'::jsonb NOT NULL,
    last_action_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    CONSTRAINT uq_browser_sessions_session_id UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS idx_browser_sessions_session_id ON browser_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_user_id ON browser_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_auth_state ON browser_sessions(auth_state);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_last_action_at ON browser_sessions(last_action_at DESC);

DROP TRIGGER IF EXISTS update_browser_sessions_updated_at ON browser_sessions;
CREATE TRIGGER update_browser_sessions_updated_at
    BEFORE UPDATE ON browser_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ====================================================================
-- 2. TASKS EXTENSIONS (Autonomous Plan, Execution Step & Verification)
-- ====================================================================
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan JSONB DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS current_step INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification_state JSONB DEFAULT '{"verified": false}'::jsonb NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_current_step ON tasks(current_step);

-- ====================================================================
-- 3. ROW LEVEL SECURITY (RLS) POLICIES
-- ====================================================================
ALTER TABLE browser_sessions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'browser_sessions' AND policyname = 'Users can view own browser sessions'
    ) THEN
        CREATE POLICY "Users can view own browser sessions"
            ON browser_sessions FOR SELECT
            USING (auth.uid() = user_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'browser_sessions' AND policyname = 'Service role full access on browser_sessions'
    ) THEN
        CREATE POLICY "Service role full access on browser_sessions"
            ON browser_sessions FOR ALL
            USING (auth.role() = 'service_role');
    END IF;
END $$;
