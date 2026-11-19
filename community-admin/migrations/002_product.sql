ALTER TABLE fixture_users RENAME TO users;
ALTER TABLE users DROP CONSTRAINT fixture_users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('owner','editor','reviewer','viewer','publisher','coordinator','jobs_curator'));
ALTER TABLE users ADD COLUMN roles text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN provider_subject text UNIQUE;
ALTER TABLE users ADD COLUMN is_fixture boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN version integer NOT NULL DEFAULT 1;
CREATE VIEW fixture_users AS SELECT * FROM users;
INSERT INTO users(id,community_id,persona,display_name,role) VALUES
('10000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','owner','Owner de prueba','owner'),
('10000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001','coordinator','Coordinación de prueba','coordinator'),
('10000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001','jobs_curator','Curación de prueba','jobs_curator'),
('10000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000001','publisher','Publicación de prueba','publisher');
CREATE TABLE records(id uuid PRIMARY KEY,community_id uuid NOT NULL,type text NOT NULL,scope text NOT NULL CHECK(scope IN('public','private')),author_id uuid NOT NULL REFERENCES users(id),payload jsonb NOT NULL,revision integer NOT NULL DEFAULT 1,state text NOT NULL,revision_hash text NOT NULL,submitted_hash text,approved_hash text,reviewer_id uuid REFERENCES users(id),source_hash text,source_commit text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL);
ALTER TABLE records ADD COLUMN desired_status text NOT NULL DEFAULT 'published';
ALTER TABLE sessions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX records_list ON records(community_id,type,id);
CREATE TABLE record_revisions(record_id uuid NOT NULL REFERENCES records(id),revision integer NOT NULL,payload jsonb NOT NULL,revision_hash text NOT NULL,updated_at timestamptz NOT NULL,PRIMARY KEY(record_id,revision));
CREATE TRIGGER record_history_immutable BEFORE UPDATE OR DELETE ON record_revisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE record_reviews(id uuid PRIMARY KEY,record_id uuid NOT NULL REFERENCES records(id),revision_hash text NOT NULL,reviewer_id uuid NOT NULL REFERENCES users(id),decision text NOT NULL,comment text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER record_review_immutable BEFORE UPDATE OR DELETE ON record_reviews FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE media_assets(id uuid PRIMARY KEY,community_id uuid NOT NULL,uploader_id uuid REFERENCES users(id),path text NOT NULL,sha256 text NOT NULL,width integer NOT NULL,height integer NOT NULL,mime text NOT NULL,bytes bigint NOT NULL,storage_key text NOT NULL,storage_backend text NOT NULL DEFAULT 'local',original_name text NOT NULL,rights jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(community_id,path));
CREATE TABLE invitations(id uuid PRIMARY KEY,community_id uuid NOT NULL,provider_subject text NOT NULL,roles text[] NOT NULL,invited_by uuid NOT NULL REFERENCES users(id),expires_at timestamptz NOT NULL,accepted_at timestamptz,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX invitation_pending ON invitations(community_id,provider_subject) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE TABLE oauth_states(state_hash text PRIMARY KEY,verifier text NOT NULL,expires_at timestamptz NOT NULL,return_path text NOT NULL DEFAULT '/');
CREATE TABLE deletion_tombstones(id uuid PRIMARY KEY,community_id uuid NOT NULL,record_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),subject_hash text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE core_idempotency(community_id uuid NOT NULL,key text NOT NULL,request_hash text NOT NULL,response jsonb NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(community_id,key));
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE public_projections(public_record_id uuid PRIMARY KEY REFERENCES records(id),person_id uuid NOT NULL REFERENCES records(id),profile_id uuid NOT NULL REFERENCES records(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE previews(id uuid PRIMARY KEY,community_id uuid NOT NULL,record_id uuid NOT NULL REFERENCES records(id),revision_hash text NOT NULL,state text NOT NULL,path text NOT NULL,source_commit text,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE source_mappings(source_key text PRIMARY KEY,record_id uuid NOT NULL UNIQUE,source_hash text NOT NULL,source_commit text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO schema_migrations(version) VALUES(2);
