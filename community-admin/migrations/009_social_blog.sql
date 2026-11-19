-- Operator attestation is private provenance, never provider verification or website deployment.
CREATE TABLE IF NOT EXISTS social_blog_links (
 community_id uuid NOT NULL, publication_id uuid NOT NULL REFERENCES integration_publications(id),
 blog_record_id uuid NOT NULL REFERENCES records(id), source_network text NOT NULL,
 canonical_permalink_key text NOT NULL, source_fields jsonb NOT NULL,
 confirmed_by uuid NOT NULL REFERENCES users(id), confirmed_at timestamptz NOT NULL DEFAULT now(),
 publication_version integer NOT NULL, publication_revision_hash text NOT NULL,
 method text NOT NULL CHECK(method='operator-attested'),
 CONSTRAINT social_blog_publication_once PRIMARY KEY(community_id,publication_id), CONSTRAINT social_blog_record_once UNIQUE(community_id,blog_record_id),
 CONSTRAINT social_blog_source_once UNIQUE(community_id,source_network,canonical_permalink_key)
);
CREATE TABLE IF NOT EXISTS social_blog_requests (
 community_id uuid NOT NULL, request_key text NOT NULL, actor_id uuid NOT NULL REFERENCES users(id),
 request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT social_blog_request_once PRIMARY KEY(community_id,request_key)
);
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='social_blog_links'::regclass AND tgname='social_blog_link_immutable') THEN CREATE TRIGGER social_blog_link_immutable BEFORE UPDATE OR DELETE ON social_blog_links FOR EACH ROW EXECUTE FUNCTION reject_history_mutation(); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='social_blog_requests'::regclass AND tgname='social_blog_request_immutable') THEN CREATE TRIGGER social_blog_request_immutable BEFORE UPDATE OR DELETE ON social_blog_requests FOR EACH ROW EXECUTE FUNCTION reject_history_mutation(); END IF; END $$;
INSERT INTO schema_migrations(version) VALUES(9) ON CONFLICT DO NOTHING;
