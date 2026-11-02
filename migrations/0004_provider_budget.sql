-- Operational token-cost counters contain no account, brain, model or content identifiers.
-- They survive account deletion and memory purge so those operations cannot reset the service spending ceiling.
CREATE TABLE provider_budget_days (
 local_date DATE PRIMARY KEY,
 used_tokens BIGINT NOT NULL DEFAULT 0 CHECK(used_tokens>=0),
 reserved_tokens BIGINT NOT NULL DEFAULT 0 CHECK(reserved_tokens>=0)
);
CREATE TABLE provider_budget_reservations (
 id UUID PRIMARY KEY,
 local_date DATE NOT NULL REFERENCES provider_budget_days(local_date),
 reserved_tokens BIGINT NOT NULL CHECK(reserved_tokens>=0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX provider_budget_reservations_day_idx ON provider_budget_reservations(local_date);
