ALTER TABLE brain_sessions ADD COLUMN last_project_id UUID;
ALTER TABLE brain_sessions ADD COLUMN resume_count BIGINT NOT NULL DEFAULT 0 CHECK(resume_count>=0);
ALTER TABLE brain_sessions ADD COLUMN resumed_at TIMESTAMPTZ;
ALTER TABLE brain_sessions ADD CONSTRAINT brain_sessions_project_fk
 FOREIGN KEY(last_project_id,user_id,brain_id) REFERENCES projects(id,user_id,brain_id)
 ON DELETE SET NULL(last_project_id);
CREATE INDEX brain_sessions_previous_voice ON brain_sessions(user_id,brain_id,agent_label,last_activity_at DESC);
CREATE INDEX brain_sessions_project_idx ON brain_sessions(last_project_id,user_id,brain_id);
