-- Hard per-brain logical-content limits. No existing row is removed or truncated.
ALTER TABLE brains ADD COLUMN content_bytes BIGINT NOT NULL DEFAULT 0 CHECK(content_bytes>=0);
ALTER TABLE brains ADD COLUMN content_rows BIGINT NOT NULL DEFAULT 0 CHECK(content_rows>=0);
ALTER TABLE brains ADD COLUMN content_limit_bytes BIGINT NOT NULL DEFAULT 26214400 CHECK(content_limit_bytes>=0);
ALTER TABLE brains ADD COLUMN content_limit_rows BIGINT NOT NULL DEFAULT 10000 CHECK(content_limit_rows>=0);
CREATE FUNCTION brain_content_size(document JSONB) RETURNS BIGINT LANGUAGE sql IMMUTABLE AS $$
 SELECT octet_length((document - ARRAY[
 'created_at','updated_at','started_at','finished_at','accepted_at','completed_at',
 'last_activity_at','last_used_at','received_at','lease_id','lease_expires_at',
 'rollup_claimed_at','heartbeat_at','attempt','tokens_used','input_tokens','output_tokens',
 'surfaced_to','read_by','state','status','error','last_seen_version','version','revision',
 'current_revision_id','superseded_by_id','request_grant_id','content_epoch'
 ])::text)::bigint
$$;
CREATE FUNCTION recount_brain_content() RETURNS void LANGUAGE plpgsql AS $$
DECLARE relation TEXT;
BEGIN
 UPDATE brains SET content_bytes=0,content_rows=0;
 FOREACH relation IN ARRAY ARRAY['facts','notes','snapshots','handoffs','fact_revisions','jobs','projects','project_items','project_links','project_events','project_receipts']
 LOOP
  IF to_regclass('public.'||relation) IS NOT NULL THEN
   EXECUTE format('UPDATE brains b SET content_bytes=b.content_bytes+s.bytes,content_rows=b.content_rows+s.rows FROM (SELECT user_id,brain_id,sum(brain_content_size(to_jsonb(t))) AS bytes,count(*) AS rows FROM %I t GROUP BY user_id,brain_id) s WHERE b.id=s.brain_id AND b.user_id=s.user_id',relation);
  END IF;
 END LOOP;
END
$$;
SELECT recount_brain_content();
CREATE FUNCTION enforce_brain_content_quota() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_bytes BIGINT:=0; new_bytes BIGINT:=0; row_delta INTEGER:=0; delta BIGINT; owner_id UUID; parent_id UUID; parent brains%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.user_id<>NEW.user_id OR OLD.brain_id<>NEW.brain_id) THEN
  RAISE EXCEPTION 'Content ownership is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP<>'INSERT' THEN old_bytes:=brain_content_size(to_jsonb(OLD)); owner_id:=OLD.user_id; parent_id:=OLD.brain_id; END IF;
 IF TG_OP<>'DELETE' THEN new_bytes:=brain_content_size(to_jsonb(NEW)); owner_id:=NEW.user_id; parent_id:=NEW.brain_id; END IF;
 row_delta:=CASE TG_OP WHEN 'INSERT' THEN 1 WHEN 'DELETE' THEN -1 ELSE 0 END;
 delta:=new_bytes-old_bytes;
 SELECT * INTO parent FROM brains WHERE user_id=owner_id AND id=parent_id FOR UPDATE;
 -- A parent already removed by ON DELETE CASCADE needs no accounting.
 IF NOT FOUND THEN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Brain not found' USING ERRCODE='23503';
 END IF;
 IF (delta>0 AND parent.content_bytes+delta>parent.content_limit_bytes)
 OR (row_delta>0 AND parent.content_rows+row_delta>parent.content_limit_rows) THEN
  RAISE EXCEPTION 'Brain content quota reached; remove content or contact the owner' USING ERRCODE='23514',CONSTRAINT='brain_content_quota';
 END IF;
 UPDATE brains SET content_bytes=greatest(0,content_bytes+delta),content_rows=greatest(0,content_rows+row_delta) WHERE user_id=owner_id AND id=parent_id;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END
$$;
CREATE FUNCTION recount_brain_content_after_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM recount_brain_content(); RETURN NULL; END
$$;
DO $$
DECLARE relation TEXT;
BEGIN
 FOREACH relation IN ARRAY ARRAY['facts','notes','snapshots','handoffs','fact_revisions','jobs','projects','project_items','project_links','project_events','project_receipts']
 LOOP
  IF to_regclass('public.'||relation) IS NOT NULL THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION enforce_brain_content_quota()',relation||'_content_quota',relation);
   EXECUTE format('CREATE TRIGGER %I AFTER TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION recount_brain_content_after_truncate()',relation||'_content_quota_truncate',relation);
  END IF;
 END LOOP;
END
$$;
