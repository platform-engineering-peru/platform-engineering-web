CREATE TABLE IF NOT EXISTS integration_accounts (
 id uuid PRIMARY KEY, community_id uuid NOT NULL, provider text NOT NULL, destination text NOT NULL,
 scopes jsonb NOT NULL DEFAULT '[]', encrypted_secret text NOT NULL, health text NOT NULL DEFAULT 'connected',
 config jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(community_id,provider,destination)
);
CREATE TABLE IF NOT EXISTS integration_publications (
 id uuid PRIMARY KEY, community_id uuid NOT NULL, author_id uuid NOT NULL, reviewer_id uuid,
 channel text NOT NULL CHECK(channel IN ('linkedin','youtube','manual')), destination text NOT NULL,
 payload jsonb NOT NULL, revision_hash text NOT NULL, approved_hash text, state text NOT NULL DEFAULT 'draft',
 schedule_at timestamptz, local_time text, timezone text NOT NULL DEFAULT 'America/Lima', dependency_id uuid,
 remote_id text, remote_url text, upload_state jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS integration_changesets (
 id uuid PRIMARY KEY, community_id uuid NOT NULL, actor_id uuid NOT NULL, revision_hash text NOT NULL,
 files jsonb NOT NULL, state text NOT NULL DEFAULT 'approved', pr_number integer, head_sha text, merged_sha text,deployed_sha text,
 result jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS worker_outbox (
 id uuid PRIMARY KEY, community_id uuid NOT NULL, actor_id uuid NOT NULL, kind text NOT NULL, subject_id uuid NOT NULL,
 intent_key text NOT NULL, semantic_key text, request_hash text NOT NULL, payload jsonb NOT NULL DEFAULT '{}',state text NOT NULL DEFAULT 'queued',
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), lease_owner text, lease_until timestamptz,
 last_code text, result jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(community_id,intent_key)
);
ALTER TABLE worker_outbox ADD COLUMN IF NOT EXISTS semantic_key text;
CREATE UNIQUE INDEX IF NOT EXISTS worker_semantic_intent ON worker_outbox(community_id,semantic_key) WHERE semantic_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS worker_ready ON worker_outbox(available_at) WHERE state='queued';
CREATE TABLE IF NOT EXISTS integration_attempts (
 id uuid PRIMARY KEY, operation_id uuid NOT NULL REFERENCES worker_outbox(id), attempt integer NOT NULL,code text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS integration_webhooks (
 provider text NOT NULL, delivery_id text NOT NULL, payload_hash text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider,delivery_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_payload_once ON integration_webhooks(provider,payload_hash);
CREATE TABLE IF NOT EXISTS job_sources (
 id text NOT NULL, community_id uuid NOT NULL, config jsonb NOT NULL,version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(community_id,id)
);
CREATE TABLE IF NOT EXISTS job_records (
 id text NOT NULL, community_id uuid NOT NULL, source_id text NOT NULL, payload jsonb NOT NULL,version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(community_id,id)
);
CREATE TABLE IF NOT EXISTS job_runs (
 id uuid PRIMARY KEY, community_id uuid NOT NULL, source_id text NOT NULL,status text NOT NULL,summary jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version) VALUES (3) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS integration_video_assets (
 id uuid PRIMARY KEY,community_id uuid NOT NULL,actor_id uuid NOT NULL,upload_id text,storage_key text NOT NULL,
 backend text NOT NULL,bytes bigint NOT NULL CHECK(bytes>0),mime text NOT NULL,sha256 text NOT NULL,
 state text NOT NULL DEFAULT 'uploading',parts jsonb NOT NULL DEFAULT '[]',expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS integration_oauth_states (
 state_hash text PRIMARY KEY,community_id uuid NOT NULL,actor_id uuid NOT NULL,provider text NOT NULL,destination text NOT NULL,
 verifier text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS integration_requests (
 community_id uuid NOT NULL,key text NOT NULL,request_hash text NOT NULL,response jsonb NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days', PRIMARY KEY(community_id,key)
);
