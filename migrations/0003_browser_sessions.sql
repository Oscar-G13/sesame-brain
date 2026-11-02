ALTER TABLE brain_sessions ADD COLUMN browser_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE brain_sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'oauth' CHECK(source IN ('oauth','dashboard'));
CREATE INDEX brain_sessions_browser_idx ON brain_sessions(browser_session_id);
