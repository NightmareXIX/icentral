-- services/chat-service/schema.sql
-- Run this against the Supabase Postgres database used by chat-service.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL DEFAULT 'dm',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_message_at TIMESTAMPTZ,
    CONSTRAINT conversations_type_check CHECK (type IN ('dm'))
);

CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_read_at TIMESTAMPTZ,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT messages_body_not_empty CHECK (char_length(btrim(body)) > 0),
    CONSTRAINT messages_body_max_len CHECK (char_length(body) <= 2000)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_desc
    ON messages (conversation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_members_user
    ON conversation_members (user_id);

CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at_desc
    ON conversations (last_message_at DESC NULLS LAST);
