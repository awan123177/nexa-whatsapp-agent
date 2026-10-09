-- ====================================================================
-- Migration: 005_adaptive_learning_system.sql
-- Additive non-destructive migration for NEXA Adaptive Learning & Memory
-- ====================================================================

-- 1. Additive columns for memories table: lifecycle, evidence, sensitivity, correction history
ALTER TABLE memories ADD COLUMN IF NOT EXISTS evidence_summary TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_confirmed_at TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS sensitivity VARCHAR(20) DEFAULT 'low';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS correction_history JSONB DEFAULT '[]'::jsonb;

-- 2. Additive columns for users table: personalization controls
ALTER TABLE users ADD COLUMN IF NOT EXISTS personalization_enabled BOOLEAN DEFAULT TRUE;

-- 3. Non-destructive indexes for performant relevance queries and lifecycle management
CREATE INDEX IF NOT EXISTS idx_memories_user_status ON memories(user_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_user_last_used ON memories(user_id, last_used_at);
