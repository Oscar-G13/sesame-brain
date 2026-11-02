CREATE TABLE projects (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL,
 brain_id UUID NOT NULL,
 title TEXT NOT NULL CHECK(char_length(title) BETWEEN 1 AND 160),
 goal TEXT NOT NULL DEFAULT '' CHECK(char_length(goal)<=12000),
 summary TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed','archived')),
 version INTEGER NOT NULL DEFAULT 1,
 allowed_agents TEXT[] NOT NULL DEFAULT '{all}' CHECK(cardinality(allowed_agents)>0),
 created_by TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(brain_id,user_id) REFERENCES brains(id,user_id) ON DELETE CASCADE,
 UNIQUE(id,user_id,brain_id)
);
CREATE INDEX projects_owner_updated ON projects(user_id,brain_id,updated_at DESC);
CREATE TABLE project_items (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id UUID NOT NULL,
 user_id UUID NOT NULL,
 brain_id UUID NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('constraint','decision','question','milestone','task','artifact')),
 title TEXT NOT NULL CHECK(char_length(title) BETWEEN 1 AND 200),
 content TEXT NOT NULL DEFAULT '' CHECK(char_length(content)<=32000),
 status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','confirmed','in_progress','blocked','done','superseded')),
 confirmation TEXT NOT NULL DEFAULT 'proposed' CHECK(confirmation IN ('proposed','confirmed','disputed')),
 revision INTEGER NOT NULL DEFAULT 1,
 needs_review BOOLEAN NOT NULL DEFAULT false,
 source_type TEXT NOT NULL DEFAULT 'assistant_summary' CHECK(source_type IN ('user_statement','assistant_summary','inference','tool_result')),
 source_refs JSONB NOT NULL DEFAULT '[]',
 created_by TEXT NOT NULL,
 updated_by TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,user_id,brain_id) REFERENCES projects(id,user_id,brain_id) ON DELETE CASCADE,
 UNIQUE(id,project_id,user_id,brain_id)
);
CREATE INDEX project_items_project ON project_items(project_id,user_id,brain_id);
CREATE TABLE project_links (
 project_id UUID NOT NULL,
 user_id UUID NOT NULL,
 brain_id UUID NOT NULL,
 from_item_id UUID NOT NULL,
 to_item_id UUID NOT NULL,
 kind TEXT NOT NULL DEFAULT 'depends_on' CHECK(kind='depends_on'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(from_item_id,to_item_id),
 CHECK(from_item_id<>to_item_id),
 FOREIGN KEY(from_item_id,project_id,user_id,brain_id) REFERENCES project_items(id,project_id,user_id,brain_id) ON DELETE CASCADE,
 FOREIGN KEY(to_item_id,project_id,user_id,brain_id) REFERENCES project_items(id,project_id,user_id,brain_id) ON DELETE CASCADE
);
CREATE TABLE project_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id UUID NOT NULL,
 user_id UUID NOT NULL,
 brain_id UUID NOT NULL,
 version INTEGER NOT NULL,
 kind TEXT NOT NULL,
 actor_agent TEXT NOT NULL,
 summary TEXT NOT NULL,
 item_id UUID,
 source_refs JSONB NOT NULL DEFAULT '[]',
 before JSONB,
 after JSONB,
 request_id UUID,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,user_id,brain_id) REFERENCES projects(id,user_id,brain_id) ON DELETE CASCADE,
 UNIQUE(project_id,version),
 UNIQUE(project_id,request_id)
);
CREATE INDEX project_events_history ON project_events(project_id,version DESC);
CREATE TABLE project_receipts (
 project_id UUID NOT NULL,
 user_id UUID NOT NULL,
 brain_id UUID NOT NULL,
 grant_key TEXT NOT NULL,
 agent_label TEXT NOT NULL,
 last_seen_version INTEGER NOT NULL,
 received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,grant_key),
 FOREIGN KEY(project_id,user_id,brain_id) REFERENCES projects(id,user_id,brain_id) ON DELETE CASCADE
);
ALTER TABLE jobs ADD COLUMN project_id UUID;
ALTER TABLE jobs ADD COLUMN project_item_id UUID;
ALTER TABLE jobs ADD COLUMN project_version INTEGER;
ALTER TABLE jobs ADD COLUMN owner_requested BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE jobs ADD COLUMN audience TEXT[] NOT NULL DEFAULT '{all}';
ALTER TABLE jobs ADD COLUMN checkpoint JSONB;
ALTER TABLE jobs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD CONSTRAINT jobs_project_fk FOREIGN KEY(project_id,user_id,brain_id) REFERENCES projects(id,user_id,brain_id) ON DELETE CASCADE;
CREATE INDEX jobs_project ON jobs(project_id,user_id,brain_id);
ALTER TABLE projects ADD CONSTRAINT projects_agents_valid CHECK (array_length(allowed_agents,1)<=32);
