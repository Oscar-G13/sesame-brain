ALTER TABLE users ADD COLUMN ai_access_state TEXT NOT NULL DEFAULT 'pending' CHECK(ai_access_state IN ('pending','approved','revoked'));
ALTER TABLE users ADD COLUMN ai_approved_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN ai_access_reason TEXT NOT NULL DEFAULT 'Operator approval is required before hosted AI is available. Your memory and assistant connections still work.';
-- Preserve access for accounts that predate this access-control migration.
UPDATE users SET ai_access_state='approved',ai_approved_at=now(),ai_access_reason='Hosted AI access was preserved for this existing account.' WHERE deleted_at IS NULL;
CREATE TABLE account_recovery_codes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 code_hash TEXT NOT NULL UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 used_at TIMESTAMPTZ
);
CREATE INDEX account_recovery_user_idx ON account_recovery_codes(user_id);
CREATE TABLE ai_access_audit (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('pending','approved','revoked')),
 changed_by TEXT NOT NULL,
 reason TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ai_access_audit_user_idx ON ai_access_audit(user_id);
CREATE TABLE operational_status (
 key TEXT PRIMARY KEY,
 ok BOOLEAN NOT NULL,
 code TEXT NOT NULL,
 checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
