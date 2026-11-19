import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/server/app";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
test("actual confirmation API rejects forgery/stale writes, preserves copy and exports only attested source", async () => {
  const schema = "test_social_api_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema),
    origin = "http://127.0.0.1:49123";
  try {
    await migrate(pool, schema);
    const app = createApp({
        pool,
        media: [],
        origin,
        environment: "test",
        fixtureAuthEnabled: true,
      }),
      agent = request.agent(app);
    const login = await agent
      .post("/api/dev/login")
      .set("Origin", origin)
      .send({ persona: "owner" });
    assert.equal(login.status, 200);
    const csrf = login.body.csrfToken;
    const send = (
      method: "post" | "patch",
      url: string,
      body: any,
      key = randomUUID(),
      version = 1,
    ) =>
      agent[method](url)
        .set("Origin", origin)
        .set("X-CSRF-Token", csrf)
        .set("Idempotency-Key", key)
        .set("If-Match", `"${version}"`)
        .send(body);
    const pub = randomUUID(),
      actor = "10000000-0000-4000-8000-000000000004",
      reviewer = "10000000-0000-4000-8000-000000000002";
    await pool.query(
      "INSERT INTO integration_publications(id,community_id,author_id,reviewer_id,channel,destination,payload,revision_hash,approved_hash,state) VALUES($1,$2,$3,$4,'linkedin','fixture','{\"text\":\"Approved original\"}',$5,$5,'approved')",
      [pub, COMMUNITY_ID, actor, reviewer, "a".repeat(64)],
    );
    const input = {
      version: 1,
      revisionHash: "a".repeat(64),
      sourceNetwork: "linkedin",
      sourceUrl:
        "https://www.linkedin.com/feed/update/urn:li:activity:987654321/",
      sourcePublishedAt: "2026-11-18T10:00:00-05:00",
      sourceLanguage: "en",
      attested: true,
      blog: {
        title: { "es-pe": "Publicación revisada", en: "Reviewed post" },
        description: { "es-pe": "Resumen revisado", en: "Reviewed excerpt" },
        body: { "es-pe": "Texto revisado", en: "Reviewed text" },
        tags: [],
      },
    };
    assert.equal(
      (
        await send("post", `/api/publications/${pub}/manual-confirm`, {
          url: input.sourceUrl,
        })
      ).status,
      422,
    );
    const confirmed = await send(
      "post",
      `/api/publications/${pub}/manual-confirm`,
      input,
    );
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.website.state, "local");
    const record = confirmed.body.blog;
    const detail = await agent.get(`/api/publications/${pub}`);
    assert.equal(detail.body.socialIndex.id, record.id);
    const list = await agent.get("/api/publications");
    assert.equal(
      list.body.items.find((row: any) => row.id === pub).socialIndex.id,
      record.id,
    );
    assert.equal(
      detail.body.socialIndex.confirmationMethod,
      "operator-attested",
    );
    assert.equal(
      (
        await send("post", "/api/records", {
          type: "blog",
          payload: record.payload,
        })
      ).body.code,
      "BLOG_CONFIRMATION_REQUIRED",
    );
    const forged = await send("patch", `/api/records/${record.id}`, {
      payload: {
        ...record.payload,
        sourceUrl:
          "https://www.linkedin.com/feed/update/urn:li:activity:11111111/",
      },
    });
    assert.equal(forged.body.code, "BLOG_SOURCE_IMMUTABLE");
    const edited = await send("patch", `/api/records/${record.id}`, {
      payload: {
        ...record.payload,
        body: { ...record.payload.body, en: "Revised editorial text" },
      },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.revision, 2);
    assert.equal(edited.body.state, "draft");
    const stale = await send("patch", `/api/records/${record.id}`, {
      payload: record.payload,
    });
    assert.equal(stale.body.code, "REVISION_CONFLICT");
    assert.equal(
      (await agent.get(`/api/records/${record.id}`)).body.payload.body.en,
      "Revised editorial text",
    );
    assert.equal(
      (await pool.query("SELECT count(*) FROM social_blog_links")).rows[0]
        .count,
      "1",
    );
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
