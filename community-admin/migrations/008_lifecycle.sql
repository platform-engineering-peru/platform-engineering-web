-- Retain local Memories draft revisions and audit while removing discarded drafts from mutable lists.
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_state_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_state_check CHECK(state IN('draft','submitted','approved','changes_requested','discarded'));
INSERT INTO schema_migrations(version) VALUES(8) ON CONFLICT(version) DO NOTHING;
