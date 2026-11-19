import assert from "node:assert/strict";
import type { Journey } from "../harness";
import { socialBlogJourney as handoff } from "../../social-blog-browser";
import { read } from "./record-ui";
export const socialBlogJourney: Journey = {
  ...handoff,
  id: "social-blog-confirmation",
  requirements: ["BLOG-HANDOFF", "BLOG-CONFIRM", "BLOG-TRUST", "BLOG-REVIEW"],
  title:
    "Confirmed local blog uses normal independent review/export and invalidates approval after edits",
  async run(ctx) {
    await handoff.run(ctx);
    const row = (
      await ctx.pool.query("SELECT * FROM records WHERE type='blog'")
    ).rows[0];
    const before = await ctx.api("GET", `/records/${row.id}/export`);
    assert.equal(before.status(), 409);
    assert.equal((await before.json()).code, "APPROVAL_REQUIRED");
    const submitted = await ctx.api(
      "POST",
      `/records/${row.id}/submit`,
      {},
      { version: row.revision },
    );
    assert.equal(submitted.status(), 200, await submitted.text());
    const versioned = await submitted.json();
    await ctx.login("reviewer");
    const approved = await ctx.api(
      "POST",
      `/records/${row.id}/review`,
      {
        decision: "approved",
        revisionHash: versioned.revisionHash,
        comment: "QA synthetic independent blog review",
      },
      { version: versioned.revision },
    );
    assert.equal(approved.status(), 200, await approved.text());
    const exported = await ctx.api("GET", `/records/${row.id}/export`);
    assert.equal(exported.status(), 200, await exported.text());
    const publicRecord = await exported.json();
    assert.equal(publicRecord.id, row.id);
    assert.equal(publicRecord.status, "published");
    assert.equal(publicRecord.sourceUrl, row.payload.sourceUrl);
    assert.equal(publicRecord.body.en, row.payload.body.en);
    assert.ok(
      !/confirmedBy|confirmed_by|publicationId|requestKey|operator-attested|canonical_permalink/.test(
        JSON.stringify(publicRecord),
      ),
    );
    await ctx.login("owner");
    const edited = await ctx.api(
      "PATCH",
      `/records/${row.id}`,
      {
        payload: {
          ...row.payload,
          body: { ...row.payload.body, en: "Corrected reviewed copy" },
        },
      },
      { version: row.revision },
    );
    assert.equal(edited.status(), 200, await edited.text());
    const changed = await edited.json();
    assert.equal(changed.state, "draft");
    assert.equal(changed.approvedHash, null);
    assert.equal(changed.revision, row.revision + 1);
    assert.equal(
      (await ctx.api("GET", `/records/${row.id}/export`)).status(),
      409,
    );
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM social_blog_links")).rows[0]
        .count,
      "1",
    );
    assert.equal(
      (await ctx.pool.query("SELECT count(*) FROM integration_changesets"))
        .rows[0].count,
      "0",
    );
    await ctx.screenshot("blog-copy-edit-invalidates-export-approval");
  },
};
