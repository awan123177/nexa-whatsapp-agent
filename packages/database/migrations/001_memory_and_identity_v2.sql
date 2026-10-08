-- ====================================================================
-- Migration: 001_memory_and_identity_v2.sql
-- Additive non-destructive migration for NEXA memory and identity v2
-- ====================================================================

-- 1. Additive columns for User identity, titles, and schema versioning
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_name VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_confirmed BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_source VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_title VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS title_confirmed BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS title_source VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS memory_version INTEGER DEFAULT 1;

-- 2. Additive columns for Memories table versioning and source tracking
ALTER TABLE memories ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'USER_PROVIDED';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS confirmed BOOLEAN DEFAULT TRUE;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

-- 3. Non-destructive index on user_id and category for efficient relevant memory retrieval
CREATE INDEX IF NOT EXISTS idx_memories_user_category ON memories(user_id, category);
CREATE INDEX IF NOT EXISTS idx_users_preferred_title ON users(preferred_title);
