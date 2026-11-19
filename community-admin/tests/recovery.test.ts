import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import request from "supertest";
import { createPool, migrate } from "../src/server/db";
import { createApp } from "../src/server/app";
import { verifySeedMedia } from "../src/server/media";
import { backupSnapshot, restoreSnapshot } from "../src/server/recovery";
import { decryptPrivate } from "../src/server/private-data";
import { entityDefinitions } from "../src/shared/product-contract";
test("encrypted backup restores to a new schema and replays post-backup deletion tombstones", async () => {
  const suffix = randomUUID().replaceAll("-", ""),
    sourceName = `test_backup_${suffix}`,
    targetName = `test_restore_${suffix}`,
    url = process.env.DATABASE_URL!;
  const source = createPool(url, sourceName),
    target = createPool(url, targetName),
    key = randomBytes(32),
    origin = "http://127.0.0.1:4455";
  const started = performance.now();
  try {
    await migrate(source, sourceName);
    const app = createApp({
        pool: source,
        media: await verifySeedMedia(),
        origin,
        fixtureAuthEnabled: true,
        environment: "test",
      }),
      agent = request.agent(app);
    const login = await agent
        .post("/api/dev/login")
        .set("Origin", origin)
        .send({ persona: "owner" }),
      csrf = login.body.csrfToken;
    const mutate = (path: string, body: any, revision?: number) => {
      let r = agent
        .post(path)
        .set("Origin", origin)
        .set("X-CSRF-Token", csrf)
        .set("Idempotency-Key", randomUUID());
      if (revision) r = r.set("If-Match", `"${revision}"`);
      return r.send(body);
    };
    const defaults = entityDefinitions.find(
      (d) => d.type === "people",
    )!.defaults;
    const kept = (
      await mutate("/api/records", {
        type: "people",
        payload: {
          ...defaults,
          name: "Synthetic recovery survivor",
          notes: "PRIVATE_RECOVERY_SENTINEL",
          provenance: "synthetic",
          permissionBasis: "test",
        },
      })
    ).body;
    const removed = (
      await mutate("/api/records", {
        type: "people",
        payload: {
          ...defaults,
          name: "Synthetic deleted contact",
          email: "deleted@example.invalid",
          provenance: "synthetic",
          permissionBasis: "test",
        },
      })
    ).body;
    assert.ok(kept.id && removed.id);
    const raw = (
      await source.query("SELECT payload FROM records WHERE id=$1", [kept.id])
    ).rows[0].payload;
    assert.equal(raw.encrypted, true);
    assert.ok(!JSON.stringify(raw).includes("PRIVATE_RECOVERY_SENTINEL"));
    await source.query(
      "INSERT INTO integration_oauth_states(state_hash,community_id,actor_id,provider,destination,verifier,expires_at) VALUES($1,$2,$3,'youtube','synthetic','MUST_NOT_RESTORE',now()+interval '10 minutes')",
      [
        randomUUID(),
        "00000000-0000-4000-8000-000000000001",
        login.body.id ??
          (await source.query("SELECT id FROM users WHERE role='owner'"))
            .rows[0].id,
      ],
    );
    const backup = await backupSnapshot(source, sourceName, key);
    assert.ok(!backup.includes(Buffer.from("PRIVATE_RECOVERY_SENTINEL")));
    const archive = await mutate(
      `/api/records/${removed.id}/archive`,
      {},
      removed.revision,
    );
    assert.equal(archive.status, 200, JSON.stringify(archive.body));
    const deletion = await mutate(
      `/api/records/${removed.id}/delete`,
      { reason: "Synthetic deletion after backup" },
      archive.body.revision,
    );
    assert.equal(deletion.status, 200, JSON.stringify(deletion.body));
    const report = await restoreSnapshot(target, targetName, backup, key);
    assert.ok(report.tombstonesReapplied >= 1);
    const survivor = (
      await target.query("SELECT * FROM records WHERE id=$1", [kept.id])
    ).rows[0];
    assert.equal(
      decryptPrivate(kept.id, survivor.payload).notes,
      "PRIVATE_RECOVERY_SENTINEL",
    );
    assert.equal(
      (
        await target.query("SELECT state FROM records WHERE id=$1", [
          removed.id,
        ])
      ).rows[0].state,
      "deleted",
    );
    assert.equal(
      (await target.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n,
      0,
    );
    assert.equal(
      (
        await target.query(
          "SELECT count(*)::int AS n FROM integration_oauth_states",
        )
      ).rows[0].n,
      0,
      "Restore must discard unfinished provider OAuth grants",
    );
    await assert.rejects(
      restoreSnapshot(target, targetName, backup, key),
      /RESTORE_TARGET_MUST_BE_NEW_SCHEMA/,
    );
    const measured = {
      ...report,
      elapsedMs: Math.round(performance.now() - started),
      synthetic: true,
      verifiedAt: new Date().toISOString(),
      measuredRecoveryScope:
        "isolated synthetic PostgreSQL schemas; not production RPO/RTO",
    };
    await mkdir(".local/qa", { recursive: true });
    await writeFile(
      ".local/qa/restore-drill.json",
      JSON.stringify(measured, null, 2),
    );
    console.log("Measured synthetic restore drill:", JSON.stringify(measured));
  } finally {
    await source.query(`DROP SCHEMA IF EXISTS "${sourceName}" CASCADE`);
    await target.query(`DROP SCHEMA IF EXISTS "${targetName}" CASCADE`);
    await source.end();
    await target.end();
  }
});
