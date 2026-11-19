CREATE TABLE IF NOT EXISTS website_publication_attempts (
 sequence bigserial PRIMARY KEY,
 operation_id text NOT NULL,
 attempt_id text NOT NULL,
 repository text NOT NULL,
 branch text NOT NULL CHECK(branch='main'),
 subject text NOT NULL,
 attempt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(operation_id,attempt_id)
);
ALTER TABLE editorial_proposals ADD COLUMN IF NOT EXISTS publication_mode text NOT NULL DEFAULT 'pull-request';
INSERT INTO schema_migrations(version) VALUES(7) ON CONFLICT(version) DO NOTHING;
