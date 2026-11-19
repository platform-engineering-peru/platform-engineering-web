import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import {
  confirmSocialPost,
  assertBlogConfirmation,
} from "../src/server/integrations/social-indexing";
import { capabilitiesFor } from "../src/server/context";
import { projectPublicRecord } from "../src/server/export";
import { IntegrationService } from "../src/server/integrations/service";
const actor = "10000000-0000-4000-8000-000000000004",
  reviewer = "10000000-0000-4000-8000-000000000002";
const session: any = {
  id: actor,
  communityId: COMMUNITY_ID,
  capabilities: capabilitiesFor(["owner"]),
};
const body = (version = 1) => ({
  version,
  revisionHash: "a".repeat(64),
  sourceNetwork: "linkedin",
  sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123456789/",
  sourcePublishedAt: "2026-11-18T10:00:00-05:00",
  sourceLanguage: "en",
  attested: true,
  blog: {
    title: { "es-pe": "Publicación revisada", en: "Reviewed post" },
    description: { "es-pe": "Descripción revisada", en: "Reviewed excerpt" },
    body: { "es-pe": "Texto revisado.", en: "Reviewed text." },
    tags: ["platform"],
  },
});
test("social confirmation is atomic, versioned, idempotent, permission guarded and one blog per canonical source", async () => {
  const schema = "test_social_" + randomUUID().replaceAll("-", "");
  const pool = createPool(process.env.DATABASE_URL!, schema);
  try {
    await migrate(pool, schema);
    const insert = async () => {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO integration_publications(id,community_id,author_id,reviewer_id,channel,destination,payload,revision_hash,approved_hash,state) VALUES($1,$2,$3,$4,'linkedin','fixture',$5,$6,$6,'approved')",
        [
          id,
          COMMUNITY_ID,
          actor,
          reviewer,
          { text: "Original approved text" },
          "a".repeat(64),
        ],
      );
      return id;
    };
    const id = await insert();
    const input = body();
    await assert.rejects(
      () =>
        confirmSocialPost(
          pool,
          { ...session, communityId: randomUUID() },
          id,
          input,
          "foreign",
        ),
      /PERMISSION_DENIED/,
    );
    await assert.rejects(
      () =>
        confirmSocialPost(pool, session, id, { ...input, version: 2 }, "stale"),
      /REVISION_CONFLICT/,
    );
    const [a, b] = await Promise.all([
      confirmSocialPost(pool, session, id, input, "same-key"),
      confirmSocialPost(pool, session, id, input, "same-key"),
    ]);
    assert.deepEqual(a, b);
    assert.equal(a.website.state, "local");
    assert.equal(a.blog.state, "draft");
    assert.equal(
      (await pool.query("SELECT count(*) FROM records WHERE type='blog'"))
        .rows[0].count,
      "1",
    );
    await assert.rejects(
      () =>
        confirmSocialPost(
          pool,
          session,
          id,
          { ...input, blog: { ...input.blog, tags: ["changed"] } },
          "same-key",
        ),
      /IDEMPOTENCY_CONFLICT/,
    );
    const duplicate = await insert();
    await assert.rejects(
      () => confirmSocialPost(pool, session, duplicate, input, "duplicate"),
      /SOCIAL_SOURCE_ALREADY_INDEXED/,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT state FROM integration_publications WHERE id=$1",
          [duplicate],
        )
      ).rows[0].state,
      "approved",
    );
    const row = (
      await pool.query("SELECT * FROM records WHERE id=$1", [a.blog.id])
    ).rows[0];
    await assertBlogConfirmation(pool, COMMUNITY_ID, row.id, row.payload);
    const exported = await projectPublicRecord(pool, COMMUNITY_ID, row);
    assert.ok(
      !/confirmedBy|publicationId|requestKey|operator-attested/.test(
        JSON.stringify(exported),
      ),
    );
    await assert.rejects(
      () =>
        assertBlogConfirmation(pool, COMMUNITY_ID, row.id, {
          ...row.payload,
          sourcePublishedAt: "2026-01-01T00:00:00Z",
        }),
      /BLOG_SOURCE_IMMUTABLE/,
    );
    await assert.rejects(
      () =>
        assertBlogConfirmation(pool, COMMUNITY_ID, randomUUID(), row.payload),
      /BLOG_CONFIRMATION_REQUIRED/,
    );
    const blocked = await insert();
    await pool.query(
      "UPDATE integration_publications SET state='unknown' WHERE id=$1",
      [blocked],
    );
    await assert.rejects(
      () =>
        confirmSocialPost(
          pool,
          session,
          blocked,
          {
            ...input,
            sourceUrl:
              "https://www.linkedin.com/feed/update/urn:li:activity:987654321/",
          },
          "unknown",
        ),
      /PUBLICATION_STATE/,
    );
    // A failed second half must roll back the publication, record, revision and audit together.
    const rollbackId = await insert(),
      beforeCount = (await pool.query("SELECT count(*) FROM records")).rows[0]
        .count;
    await pool.query(
      "CREATE FUNCTION fail_social_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic link failure'; END $$",
    );
    await pool.query(
      "CREATE TRIGGER fail_social_link BEFORE INSERT ON social_blog_links FOR EACH ROW EXECUTE FUNCTION fail_social_link()",
    );
    await assert.rejects(
      () =>
        confirmSocialPost(
          pool,
          session,
          rollbackId,
          {
            ...input,
            sourceUrl:
              "https://www.linkedin.com/feed/update/urn:li:activity:222222222/",
          },
          "rollback",
        ),
      /synthetic link failure/,
    );
    await pool.query("DROP TRIGGER fail_social_link ON social_blog_links");
    assert.equal(
      (await pool.query("SELECT count(*) FROM records")).rows[0].count,
      beforeCount,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT state FROM integration_publications WHERE id=$1",
          [rollbackId],
        )
      ).rows[0].state,
      "approved",
    );
    // Scheduling and manual confirmation share the publication row fence; exactly one may win.
    const raceId = await insert(),
      date = new Date(Date.now() + 3600000),
      local = date.toISOString().slice(0, 16);
    await pool.query(
      "UPDATE integration_publications SET schedule_at=$2,timezone='UTC',local_time=$3 WHERE id=$1",
      [raceId, date, local],
    );
    const integration = new IntegrationService({ pool });
    const outcomes = await Promise.allSettled([
      confirmSocialPost(
        pool,
        session,
        raceId,
        {
          ...input,
          sourceUrl:
            "https://www.linkedin.com/feed/update/urn:li:activity:333333333/",
        },
        "confirm-race",
      ),
      integration.schedule(
        COMMUNITY_ID,
        actor,
        raceId,
        input.revisionHash,
        date,
        "UTC",
        local,
        "schedule-race",
      ),
    ]);
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
    const raced = (
      await pool.query(
        "SELECT state FROM integration_publications WHERE id=$1",
        [raceId],
      )
    ).rows[0].state;
    assert.ok(["scheduled", "manual-published"].includes(raced));
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM social_blog_links WHERE publication_id=$1",
          [raceId],
        )
      ).rows[0].count,
      raced === "manual-published" ? "1" : "0",
    );
    const cancelId = await insert();
    const cancelResults = await Promise.allSettled([
      confirmSocialPost(
        pool,
        session,
        cancelId,
        {
          ...input,
          sourceUrl:
            "https://www.linkedin.com/feed/update/urn:li:activity:555555555/",
        },
        "cancel-confirm-race",
      ),
      integration.cancel(
        COMMUNITY_ID,
        cancelId,
        1,
        input.revisionHash,
        actor,
        "Synthetic cancellation race",
      ),
    ]);
    assert.equal(
      cancelResults.filter((r) => r.status === "fulfilled").length,
      1,
    );
    const manualId = await insert();
    await pool.query(
      "UPDATE integration_publications SET channel='manual',state='manual-export' WHERE id=$1",
      [manualId],
    );
    const manual = await confirmSocialPost(
      pool,
      session,
      manualId,
      {
        ...input,
        sourceNetwork: "other",
        sourceNetworkLabel: "Community network",
        sourceUrl: "https://community.example/posts/manual",
      },
      "manual-existing",
    );
    assert.equal(manual.blog.payload.sourceNetwork, "other");
    await assert.rejects(
      () =>
        integration.handleOperation({
          kind: "publication",
          community_id: COMMUNITY_ID,
          subject_id: manualId,
          payload: { revisionHash: input.revisionHash },
        } as any),
      /APPROVAL_REVOKED/,
    );
    // A replay never restores or edits a blog that has subsequently been withdrawn.
    await pool.query(
      "UPDATE records SET state='draft',desired_status='archived',revision=revision+1 WHERE id=$1",
      [a.blog.id],
    );
    await confirmSocialPost(pool, session, id, input, "same-key");
    assert.equal(
      (
        await pool.query("SELECT desired_status FROM records WHERE id=$1", [
          a.blog.id,
        ])
      ).rows[0].desired_status,
      "archived",
    );
    await pool.query("UPDATE users SET active=false WHERE id=$1", [reviewer]);
    const revokedId = await insert();
    await assert.rejects(
      () =>
        confirmSocialPost(
          pool,
          session,
          revokedId,
          {
            ...input,
            sourceUrl:
              "https://www.linkedin.com/feed/update/urn:li:activity:444444444/",
          },
          "reviewer-revoked",
        ),
      /APPROVAL_REVOKED/,
    );
    await pool.query("UPDATE users SET active=true WHERE id=$1", [reviewer]);
    await pool.query("UPDATE users SET active=false WHERE id=$1", [actor]);
    await assert.rejects(
      () => confirmSocialPost(pool, session, id, input, "same-key"),
      /PERMISSION_DENIED/,
    );
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
