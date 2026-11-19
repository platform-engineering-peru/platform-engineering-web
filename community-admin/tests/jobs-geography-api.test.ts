import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import { createIntegrationRouter } from "../src/server/integrations/router";
import { capabilitiesFor } from "../src/server/context";
import { normalizeJob } from "../src/server/jobs/engine";
import { JobsPublisher } from "../src/server/jobs/publication";
import { directRemote } from "./direct-fixture";
test("default review excludes foreign evidence, explicit audit views retain it, and approval/publication cannot relabel it", async () => {
  const schema = "test_geo_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema),
    actor = "10000000-0000-4000-8000-000000000004";
  try {
    await migrate(pool, schema);
    await pool.query("UPDATE users SET provider_subject='42' WHERE id=$1", [
      actor,
    ]);
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.session = {
        id: actor,
        communityId: COMMUNITY_ID,
        roles: ["owner"],
        role: "owner",
        capabilities: capabilitiesFor(["owner"]),
        csrfToken: "fixture",
      };
      next();
    });
    app.use(
      "/api",
      createIntegrationRouter({
        pool,
        origin: "http://127.0.0.1:4455",
        liveEnabled: false,
      }),
    );
    const api = request(app),
      records: any[] = [];
    for (let i = 0; i < 105; i++) {
      const record = {
        ...normalizeJob(
          {
            id: String(i).padStart(3, "0"),
            title: "Storage Platform Engineer",
            location: { name: i < 103 ? "Kuala Lumpur, Malaysia" : "Peru" },
            absolute_url: `https://employer.example/jobs/${i}`,
          },
          {
            id: "geo",
            adapter: "greenhouse",
            boardIdentifier: "geo",
            company: "Employer",
          },
          new Date(),
        ),
        status: "needs-review",
        summary: {
          "es-pe": "Ingeniería de plataforma.",
          en: "Platform engineering.",
        },
      };
      records.push(record);
      await pool.query(
        "INSERT INTO job_records(id,community_id,source_id,payload) VALUES($1,$2,'geo',$3)",
        [record.id, COMMUNITY_ID, record],
      );
    }
    const first = await api.get("/api/jobs/candidates?limit=1");
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 1);
    assert.equal(first.body.items[0].id, records[103].id);
    assert.equal(first.body.items[0].geography.qualified, true);
    assert.ok(first.body.nextCursor);
    const second = await api.get(
      `/api/jobs/candidates?limit=1&cursor=${first.body.nextCursor}`,
    );
    assert.equal(second.body.items[0].id, records[104].id);
    const all = await api.get("/api/jobs/candidates?scope=all&limit=100");
    assert.equal(all.body.items[0].id, records[0].id);
    const outside = await api.get(
      "/api/jobs/candidates?scope=ineligible&limit=100",
    );
    assert.equal(outside.body.items.length, 100);
    assert.equal(outside.body.items[0].geography.qualified, false);
    const denied = await api
      .post(`/api/jobs/${encodeURIComponent(records[0].id)}/review`)
      .send({
        version: 1,
        decision: "approve",
        eligibility: "peru",
        reason: "Employer has offices in Peru",
      });
    assert.equal(denied.status, 422);
    assert.equal(denied.body.code, "ELIGIBILITY_REVIEW_REQUIRED");
    for (const [location, excerpt] of [
      ["Remote LATAM excluding Peru", ""],
      ["Remote Peru", "United States residents only."],
    ]) {
      await pool.query(
        "UPDATE job_records SET payload=payload||$2::jsonb WHERE id=$1",
        [
          records[0].id,
          JSON.stringify({
            locations: [location],
            workplace: "remote",
            sourceExcerpt: excerpt,
            eligibility: "peru",
            editorialEligibility: "peru",
          }),
        ],
      );
      const refused = await api
        .post(`/api/jobs/${encodeURIComponent(records[0].id)}/review`)
        .send({
          version: 1,
          decision: "approve",
          eligibility: "peru",
          reason: "Peru override",
        });
      assert.equal(refused.status, 422);
      assert.equal(refused.body.code, "ELIGIBILITY_REVIEW_REQUIRED");
    }
    // Even a contradictory Peru location and operator label cannot defeat explicit source restriction.
    await pool.query(
      "UPDATE job_records SET payload=payload||$2::jsonb WHERE id=$1",
      [
        records[0].id,
        JSON.stringify({
          locations: ["Lima, Peru"],
          eligibility: "peru",
          editorialEligibility: "peru",
          geographyEvidence: {
            applicantRestrictions:
              "Applicants must reside in the United States only",
          },
        }),
      ],
    );
    const restricted = await api
      .post(`/api/jobs/${encodeURIComponent(records[0].id)}/review`)
      .send({
        version: 1,
        decision: "approve",
        eligibility: "peru",
        reason: "Employer has offices in Peru",
      });
    assert.equal(restricted.status, 422);
    assert.equal(restricted.body.code, "ELIGIBILITY_REVIEW_REQUIRED");
    await pool.query(
      'UPDATE job_records SET payload=payload||\'{"eligibility":"peru"}\'::jsonb WHERE id=$1',
      [records[0].id],
    );
    const remote = directRemote(),
      publisher = new JobsPublisher(pool, {
        config: {
          mode: "github",
          repository: "platform-engineering-peru/platform-engineering-web",
          branch: "main",
          remoteWritesEnabled: true,
        },
        transport: remote.view(["jobs"]),
      });
    await assert.rejects(
      publisher.create(COMMUNITY_ID, actor, [records[0].id], randomUUID(), {
        [records[0].id]: 1,
      }),
      { code: "JOB_APPROVAL_REQUIRED" },
    );
    assert.equal(remote.proofs.size, 0);
    const approved = await api
      .post(`/api/jobs/${encodeURIComponent(records[103].id)}/review`)
      .send({ version: 1, decision: "approve" });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.geography.qualified, true);
    assert.equal(approved.body.geography.reason, "explicit-peru");

    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM job_records")).rows[0]
        .n,
      105,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT payload->>'approved' AS approved FROM job_records WHERE id=$1",
          [records[0].id],
        )
      ).rows[0].approved,
      "false",
    );
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
