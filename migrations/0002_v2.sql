ALTER TABLE brains ADD COLUMN memory_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE brains ADD COLUMN content_epoch BIGINT NOT NULL DEFAULT 0;
ALTER TABLE snapshots ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual'
 CHECK(kind IN ('manual','auto','formulation','audit','diff'));
ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual'
 CHECK(kind IN ('manual','job_result'));
ALTER TABLE activity ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}';

-- Browser authentication continues to use the existing sessions table.
CREATE TABLE brain_sessions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL,
 brain_id UUID NOT NULL,
 agent_label TEXT NOT NULL CHECK(agent_label ~ '^[a-z0-9-]{1,32}$' AND agent_label <> 'all'),
 session_key TEXT NOT NULL,
 transport_session_id TEXT,
 request_grant_id UUID REFERENCES grants(id) ON DELETE SET NULL,
 writable BOOLEAN NOT NULL DEFAULT false,
 content_epoch BIGINT NOT NULL,
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 closed_at TIMESTAMPTZ,
 write_count BIGINT NOT NULL DEFAULT 0 CHECK(write_count>=0),
 activity_count BIGINT NOT NULL DEFAULT 0 CHECK(activity_count>=0),
 think_count BIGINT NOT NULL DEFAULT 0 CHECK(think_count>=0),
 do_count BIGINT NOT NULL DEFAULT 0 CHECK(do_count>=0),
 rolled_up_snapshot_id UUID,
 briefing TEXT,
 briefing_at TIMESTAMPTZ,
 last_snapshot_at TIMESTAMPTZ,
 rollup_claimed_at TIMESTAMPTZ,
 rollup_error TEXT,
 FOREIGN KEY(brain_id,user_id) REFERENCES brains(id,user_id) ON DELETE CASCADE,
 UNIQUE(id,user_id,brain_id)
);
CREATE INDEX brain_sessions_user_idx ON brain_sessions(user_id);
CREATE INDEX brain_sessions_brain_idx ON brain_sessions(brain_id,user_id,last_activity_at DESC);
CREATE INDEX brain_sessions_open_idx ON brain_sessions(last_activity_at) WHERE closed_at IS NULL;
CREATE INDEX brain_sessions_key_idx ON brain_sessions(user_id,brain_id,session_key,started_at DESC);
CREATE INDEX brain_sessions_grant_idx ON brain_sessions(request_grant_id);
-- Snapshot ownership is checked by scoped service queries rather than an unscoped identifier FK.
CREATE TABLE jobs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL,
 brain_id UUID NOT NULL,
 requested_by_agent TEXT NOT NULL,
 request_grant_id UUID REFERENCES grants(id) ON DELETE SET NULL,
 task TEXT NOT NULL CHECK(char_length(task) BETWEEN 1 AND 32000),
 title TEXT NOT NULL,
 deliver TEXT NOT NULL DEFAULT 'brain' CHECK(deliver IN ('brain','brain+email')),
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','partial','failed')),
 content_epoch BIGINT NOT NULL,
 lease_id UUID,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 started_at TIMESTAMPTZ,
 finished_at TIMESTAMPTZ,
 result_note_id UUID,
 handoff_id UUID,
 result_text TEXT,
 result_summary TEXT,
 tokens_used BIGINT NOT NULL DEFAULT 0 CHECK(tokens_used>=0),
 surfaced_to TEXT[] NOT NULL DEFAULT '{}',
 error TEXT,
 FOREIGN KEY(brain_id,user_id) REFERENCES brains(id,user_id) ON DELETE CASCADE
);
CREATE INDEX jobs_user_idx ON jobs(user_id);
CREATE INDEX jobs_brain_idx ON jobs(brain_id,user_id,created_at DESC);
CREATE INDEX jobs_state_idx ON jobs(state,created_at);
CREATE INDEX jobs_grant_idx ON jobs(request_grant_id);
CREATE TABLE usage (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL,
 brain_id UUID NOT NULL,
 local_date DATE NOT NULL,
 model TEXT NOT NULL,
 input_tokens BIGINT NOT NULL DEFAULT 0 CHECK(input_tokens>=0),
 output_tokens BIGINT NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
 FOREIGN KEY(brain_id,user_id) REFERENCES brains(id,user_id) ON DELETE CASCADE,
 UNIQUE(user_id,brain_id,local_date,model)
);
CREATE INDEX usage_user_idx ON usage(user_id);
CREATE INDEX usage_brain_idx ON usage(brain_id,user_id,local_date);
CREATE TABLE usage_reservations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL,
 brain_id UUID NOT NULL,
 local_date DATE NOT NULL,
 model TEXT NOT NULL,
 reserved_tokens BIGINT NOT NULL CHECK(reserved_tokens>=0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(brain_id,user_id) REFERENCES brains(id,user_id) ON DELETE CASCADE
);
CREATE INDEX usage_reservations_user_idx ON usage_reservations(user_id);
CREATE INDEX usage_reservations_brain_idx ON usage_reservations(brain_id,user_id,local_date);
CREATE TABLE nightly_runs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL,
 brain_id UUID NOT NULL,
 local_date DATE NOT NULL,
 state TEXT NOT NULL DEFAULT 'running' CHECK(state IN ('running','done','failed','skipped')),
 snapshot_ids JSONB NOT NULL DEFAULT '{}',
 error TEXT,
 tokens_used BIGINT NOT NULL DEFAULT 0 CHECK(tokens_used>=0),
 content_epoch BIGINT NOT NULL,
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 finished_at TIMESTAMPTZ,
 FOREIGN KEY(brain_id,user_id) REFERENCES brains(id,user_id) ON DELETE CASCADE,
 UNIQUE(user_id,brain_id,local_date)
);
CREATE INDEX nightly_runs_user_idx ON nightly_runs(user_id);
CREATE INDEX nightly_runs_brain_idx ON nightly_runs(brain_id,user_id,local_date);

CREATE FUNCTION brain_memory_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  UPDATE brains SET memory_version=memory_version+1 WHERE id=OLD.brain_id AND user_id=OLD.user_id;
  RETURN OLD;
 END IF;
 UPDATE brains SET memory_version=memory_version+1 WHERE id=NEW.brain_id AND user_id=NEW.user_id;
 IF TG_OP='UPDATE' AND (OLD.brain_id<>NEW.brain_id OR OLD.user_id<>NEW.user_id) THEN
  UPDATE brains SET memory_version=memory_version+1 WHERE id=OLD.brain_id AND user_id=OLD.user_id;
 END IF;
 RETURN NEW;
END;
$$;
CREATE FUNCTION brain_memory_truncated() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 UPDATE brains SET memory_version=memory_version+1;
 RETURN NULL;
END;
$$;
DO $$
DECLARE table_name TEXT;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['notes','handoffs','facts','snapshots','activity','jobs'] LOOP
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION brain_memory_changed()',table_name || '_memory_changed',table_name);
  EXECUTE format('CREATE TRIGGER %I AFTER TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION brain_memory_truncated()',table_name || '_memory_truncated',table_name);
 END LOOP;
END;
$$;
