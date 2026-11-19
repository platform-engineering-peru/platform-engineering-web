CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE fixture_users (
  id uuid PRIMARY KEY, community_id uuid NOT NULL, persona text NOT NULL UNIQUE,
  display_name text NOT NULL, role text NOT NULL CHECK (role IN ('editor','reviewer','viewer')), active boolean NOT NULL DEFAULT true
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES fixture_users(id),
  csrf_token text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE drafts (
  id uuid PRIMARY KEY, community_id uuid NOT NULL, author_id uuid NOT NULL REFERENCES fixture_users(id),
  slug text NOT NULL, display_order integer NOT NULL, revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('draft','submitted','approved','changes_requested')),
  payload jsonb NOT NULL, revision_hash text NOT NULL, submitted_hash text, approved_hash text,
  reviewer_id uuid REFERENCES fixture_users(id), updated_at timestamptz NOT NULL,
  UNIQUE (community_id, slug)
);
CREATE UNIQUE INDEX approved_memory_order ON drafts(community_id,display_order) WHERE state='approved';
CREATE TABLE draft_revisions (
  draft_id uuid NOT NULL REFERENCES drafts(id), revision integer NOT NULL, payload jsonb NOT NULL,
  revision_hash text NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY (draft_id, revision)
);
CREATE TABLE reviews (
  id uuid PRIMARY KEY, draft_id uuid NOT NULL REFERENCES drafts(id), revision integer NOT NULL,
  revision_hash text NOT NULL, reviewer_id uuid NOT NULL REFERENCES fixture_users(id),
  decision text NOT NULL CHECK (decision IN ('approved','changes_requested')), comment text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY, community_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES fixture_users(id),
  entity_id uuid NOT NULL, action text NOT NULL, details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'History is immutable'; END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER revision_immutable BEFORE UPDATE OR DELETE ON draft_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER review_immutable BEFORE UPDATE OR DELETE ON reviews FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
INSERT INTO fixture_users (id,community_id,persona,display_name,role) VALUES
('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','editor','Editor de prueba','editor'),
('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','reviewer','Revisor de prueba','reviewer'),
('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','viewer','Lector de prueba','viewer');
INSERT INTO schema_migrations(version) VALUES (1);
