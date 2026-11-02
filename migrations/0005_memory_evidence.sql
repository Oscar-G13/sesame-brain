ALTER TABLE facts ADD COLUMN source_type TEXT NOT NULL DEFAULT 'legacy' CHECK(source_type IN ('legacy','assistant_record','user_report','model_derived','user_correction'));
ALTER TABLE facts ADD COLUMN confidence TEXT NOT NULL DEFAULT 'unknown' CHECK(confidence IN ('unknown','low','moderate','high'));
ALTER TABLE facts ADD COLUMN confirmation TEXT NOT NULL DEFAULT 'unconfirmed' CHECK(confirmation IN ('unconfirmed','user_confirmed','disputed'));
ALTER TABLE facts ADD COLUMN source_refs JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(source_refs)='array');
ALTER TABLE facts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared' CHECK(visibility IN ('shared','restricted','owner_only'));
ALTER TABLE facts ADD COLUMN to_agents TEXT[] NOT NULL DEFAULT '{all}';
ALTER TABLE facts ADD COLUMN current_revision_id UUID;
ALTER TABLE facts ADD CONSTRAINT facts_revision_tenant_unique UNIQUE(id,user_id,brain_id);
CREATE TABLE fact_revisions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL,
 brain_id UUID NOT NULL,
 fact_id UUID NOT NULL,
 key TEXT NOT NULL,
 value TEXT NOT NULL CHECK(char_length(value) BETWEEN 1 AND 8000),
 previous_value TEXT,
 actor_agent TEXT NOT NULL,
 source_type TEXT NOT NULL CHECK(source_type IN ('legacy','assistant_record','user_report','model_derived','user_correction')),
 confidence TEXT NOT NULL DEFAULT 'unknown' CHECK(confidence IN ('unknown','low','moderate','high')),
 confirmation TEXT NOT NULL DEFAULT 'unconfirmed' CHECK(confirmation IN ('unconfirmed','user_confirmed','disputed')),
 source_refs JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(source_refs)='array'),
 visibility TEXT NOT NULL DEFAULT 'shared' CHECK(visibility IN ('shared','restricted','owner_only')),
 to_agents TEXT[] NOT NULL DEFAULT '{all}',
 status TEXT NOT NULL DEFAULT 'current' CHECK(status IN ('current','superseded','proposed')),
 supersedes_id UUID,
 superseded_by_id UUID,
 reason TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(id,user_id,brain_id),
 FOREIGN KEY(brain_id,user_id) REFERENCES brains(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(fact_id,user_id,brain_id) REFERENCES facts(id,user_id,brain_id) ON DELETE CASCADE
);
ALTER TABLE facts ADD CONSTRAINT facts_current_revision_fkey FOREIGN KEY(current_revision_id,user_id,brain_id) REFERENCES fact_revisions(id,user_id,brain_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX fact_revisions_user_idx ON fact_revisions(user_id);
CREATE INDEX fact_revisions_brain_key_idx ON fact_revisions(brain_id,user_id,key,created_at DESC,id DESC);
CREATE INDEX fact_revisions_fact_idx ON fact_revisions(fact_id,user_id,brain_id);
INSERT INTO fact_revisions(user_id,brain_id,fact_id,key,value,actor_agent,source_type,confidence,confirmation,source_refs,visibility,to_agents,created_at)
 SELECT user_id,brain_id,id,key,value,updated_by,'legacy','unknown','unconfirmed','[]','shared','{all}',updated_at FROM facts;
UPDATE facts f SET current_revision_id=r.id FROM fact_revisions r WHERE r.fact_id=f.id AND r.user_id=f.user_id AND r.brain_id=f.brain_id;
CREATE TRIGGER fact_revisions_memory_changed AFTER INSERT OR UPDATE OR DELETE ON fact_revisions FOR EACH ROW EXECUTE FUNCTION brain_memory_changed();
CREATE TRIGGER fact_revisions_memory_truncated AFTER TRUNCATE ON fact_revisions FOR EACH STATEMENT EXECUTE FUNCTION brain_memory_truncated();

ALTER TABLE notes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared' CHECK(visibility IN ('shared','restricted','owner_only'));
ALTER TABLE notes ADD COLUMN source_audience TEXT[] NOT NULL DEFAULT '{all}';
ALTER TABLE notes ADD COLUMN source_refs JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(source_refs)='array');
ALTER TABLE handoffs ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared' CHECK(visibility IN ('shared','restricted','owner_only'));
ALTER TABLE handoffs ADD COLUMN source_audience TEXT[] NOT NULL DEFAULT '{all}';
ALTER TABLE handoffs ADD COLUMN source_refs JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(source_refs)='array');
ALTER TABLE jobs ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared' CHECK(visibility IN ('shared','restricted','owner_only'));
ALTER TABLE jobs ADD COLUMN source_audience TEXT[] NOT NULL DEFAULT '{all}';
ALTER TABLE jobs ADD COLUMN source_refs JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(source_refs)='array');
ALTER TABLE snapshots ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared' CHECK(visibility IN ('shared','restricted','owner_only'));
ALTER TABLE snapshots ADD COLUMN to_agents TEXT[] NOT NULL DEFAULT '{all}';
ALTER TABLE snapshots ADD COLUMN source_refs JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(source_refs)='array');
ALTER TABLE brain_sessions ADD COLUMN to_agents TEXT[] NOT NULL DEFAULT '{all}';
ALTER TABLE brain_sessions ADD COLUMN source_refs JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(source_refs)='array');
-- Legacy generated artifacts have no reliable source ACL; retain bytes for the owner.
UPDATE snapshots SET visibility='owner_only',to_agents='{you}' WHERE kind IN ('auto','formulation','audit','diff');
UPDATE notes SET visibility='owner_only',source_audience='{you}' WHERE kind='job_result';
UPDATE handoffs SET visibility='owner_only',source_audience='{you}' WHERE EXISTS(SELECT 1 FROM jobs j WHERE j.user_id=handoffs.user_id AND j.brain_id=handoffs.brain_id AND j.handoff_id=handoffs.id);
UPDATE jobs SET visibility='owner_only',source_audience='{you}' WHERE state IN ('done','partial');
UPDATE brain_sessions SET to_agents=ARRAY[agent_label];
