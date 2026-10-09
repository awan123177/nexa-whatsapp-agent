-- ====================================================================
-- Migration: 006_memory_schema_contract_sync.sql
-- Additive non-destructive migration to synchronize memories schema contract
-- and ensure PostgREST schema cache is reloaded
-- ====================================================================

-- 1. Ensure all memory table columns exist
ALTER TABLE memories ADD COLUMN IF NOT EXISTS confirmed BOOLEAN DEFAULT TRUE;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'USER_PROVIDED';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS evidence_summary TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_confirmed_at TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS sensitivity VARCHAR(20) DEFAULT 'low';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS correction_history JSONB DEFAULT '[]'::jsonb;

-- 2. Ensure user identity and personalization columns exist
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_name VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_confirmed BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_source VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_title VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS title_confirmed BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS title_source VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS memory_version INTEGER DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS personalization_enabled BOOLEAN DEFAULT TRUE;

-- 3. Non-destructive indexes for performant relevance queries
CREATE INDEX IF NOT EXISTS idx_memories_confirmed ON memories(user_id, confirmed);
CREATE INDEX IF NOT EXISTS idx_memories_user_status ON memories(user_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_user_category ON memories(user_id, category);

-- 4. Reload PostgREST schema cache so PGRST204 is permanently cleared
NOTIFY pgrst, 'reload schema';
