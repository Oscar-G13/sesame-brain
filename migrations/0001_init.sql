CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE users (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 email CITEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 deleted_at TIMESTAMPTZ
);
CREATE TABLE brains (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL DEFAULT 'default',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(id,user_id), UNIQUE(user_id,name)
);
CREATE INDEX brains_user_idx ON brains(user_id);
CREATE TABLE sessions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,
 user_agent TEXT
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);
CREATE TABLE oauth_clients (
 client_id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('cimd','dcr','preregistered')),
 metadata JSONB NOT NULL,
 secret_hash TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 last_seen_at TIMESTAMPTZ
);
CREATE TABLE auth_codes (
 code_hash TEXT PRIMARY KEY,
 client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 brain_id UUID NOT NULL,
 agent_label TEXT NOT NULL CHECK(agent_label ~ '^[a-z0-9-]{1,32}$' AND agent_label <> 'all'),
 redirect_uri TEXT NOT NULL,
 code_challenge TEXT NOT NULL,
 scope TEXT NOT NULL,
 resource TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 used_at TIMESTAMPTZ,
 FOREIGN KEY(brain_id,user_id) REFERENCES brains(id,user_id) ON DELETE CASCADE
);
CREATE INDEX auth_codes_client_idx ON auth_codes(client_id);
CREATE INDEX auth_codes_user_idx ON auth_codes(user_id);
CREATE INDEX auth_codes_brain_idx ON auth_codes(brain_id,user_id);
CREATE TABLE grants (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 brain_id UUID NOT NULL,
 agent_label TEXT NOT NULL CHECK(agent_label ~ '^[a-z0-9-]{1,32}$' AND agent_label <> 'all'),
 client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
 scope TEXT NOT NULL,
 resource TEXT NOT NULL DEFAULT 'https://brain.arxsable.ai/mcp',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 last_used_at TIMESTAMPTZ,
 revoked_at TIMESTAMPTZ,
 FOREIGN KEY(brain_id,user_id) REFERENCES brains(id,user_id) ON DELETE CASCADE
);
ALTER TABLE auth_codes ADD COLUMN grant_id UUID REFERENCES grants(id) ON DELETE CASCADE;
CREATE INDEX auth_codes_grant_idx ON auth_codes(grant_id);
CREATE INDEX grants_user_idx ON grants(user_id);
CREATE INDEX grants_client_idx ON grants(client_id);
CREATE INDEX grants_brain_idx ON grants(brain_id,user_id);
CREATE TABLE access_tokens (
 token_hash TEXT PRIMARY KEY,
 grant_id UUID NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX access_tokens_grant_idx ON access_tokens(grant_id);
CREATE INDEX access_tokens_expires_idx ON access_tokens(expires_at);
CREATE TABLE refresh_tokens (
 token_hash TEXT PRIMARY KEY,
 grant_id UUID NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
 family_id UUID NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 used_at TIMESTAMPTZ,
 revoked_at TIMESTAMPTZ
);
CREATE INDEX refresh_tokens_grant_idx ON refresh_tokens(grant_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens(family_id);
CREATE TABLE notes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL,
 brain_id UUID NOT NULL,
 from_agent TEXT NOT NULL,
 to_agents TEXT[] NOT NULL,
 text TEXT NOT NULL CHECK(char_length(text) BETWEEN 1 AND 8000),
 tags TEXT[] NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 read_by TEXT[] NOT NULL DEFAULT '{}',
 FOREIGN KEY(brain_id,user_id) REFERENCES brains(id,user_id) ON DELETE CASCADE
);
CREATE INDEX notes_user_idx ON notes(user_id);
CREATE INDEX notes_brain_created_idx ON notes(brain_id,created_at DESC);
CREATE INDEX notes_brain_user_idx ON notes(brain_id,user_id);
CREATE TABLE handoffs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL,
 brain_id UUID NOT NULL,
 from_agent TEXT NOT NULL,
 to_agent TEXT NOT NULL,
 title TEXT NOT NULL CHECK(char_length(title) BETWEEN 1 AND 256),
 context TEXT NOT NULL CHECK(char_length(context) BETWEEN 1 AND 32000),
 next_steps TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','completed')),
 summary TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 accepted_at TIMESTAMPTZ,
 completed_at TIMESTAMPTZ,
 FOREIGN KEY(brain_id,user_id) REFERENCES brains(id,user_id) ON DELETE CASCADE
);
CREATE INDEX handoffs_user_idx ON handoffs(user_id);
CREATE INDEX handoffs_brain_user_idx ON handoffs(brain_id,user_id);
CREATE INDEX handoffs_brain_created_idx ON handoffs(brain_id,created_at DESC);
CREATE TABLE facts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL,
 brain_id UUID NOT NULL,
 key TEXT NOT NULL CHECK(char_length(key) BETWEEN 1 AND 128),
 value TEXT NOT NULL CHECK(char_length(value) BETWEEN 1 AND 8000),
 tags TEXT[] NOT NULL DEFAULT '{}',
 updated_by TEXT NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(brain_id,user_id) REFERENCES brains(id,user_id) ON DELETE CASCADE,
 UNIQUE(brain_id,key)
);
CREATE INDEX facts_user_idx ON facts(user_id);
CREATE INDEX facts_brain_user_idx ON facts(brain_id,user_id);
CREATE INDEX facts_trgm_idx ON facts USING GIN ((key || ' ' || value) gin_trgm_ops);
CREATE INDEX facts_fulltext_idx ON facts USING GIN (to_tsvector('simple',key || ' ' || value));
CREATE TABLE snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL,
 brain_id UUID NOT NULL,
 agent_label TEXT NOT NULL,
 title TEXT,
 content TEXT NOT NULL CHECK(char_length(content) BETWEEN 1 AND 200000),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(brain_id,user_id) REFERENCES brains(id,user_id) ON DELETE CASCADE
);
CREATE INDEX snapshots_user_idx ON snapshots(user_id);
CREATE INDEX snapshots_brain_user_idx ON snapshots(brain_id,user_id);
CREATE INDEX snapshots_agent_idx ON snapshots(brain_id,agent_label,created_at DESC);
CREATE TABLE activity (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL,
 brain_id UUID NOT NULL,
 actor_agent TEXT NOT NULL,
 kind TEXT NOT NULL,
 ref_id UUID,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(brain_id,user_id) REFERENCES brains(id,user_id) ON DELETE CASCADE
);
CREATE INDEX activity_user_idx ON activity(user_id);
CREATE INDEX activity_brain_created_idx ON activity(brain_id,created_at DESC);
CREATE INDEX activity_brain_user_idx ON activity(brain_id,user_id);
