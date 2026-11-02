ALTER TABLE project_events ADD COLUMN request_hash TEXT;
SELECT recount_brain_content();
