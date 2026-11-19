import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import request from "supertest";
import { createPool, migrate } from "../src/server/db";
import { createApp } from "../src/server/app";
import { entityDefinitions } from "../src/shared/product-contract";
import { backupSnapshot, restoreSnapshot } from "../src/server/recovery";
import { exportPrivateKey } from "../src/server/private-data";

test("erase persists recovery intent before DB deletion, retries key cleanup and prevents backup resurrection", async () => {
  const cwd = process.cwd(),
    dir = await mkdtemp(resolve(tmpdir(), "erase-recovery-")),
    previousKeys = process.env.PRIVATE_KEY_DIR,
    suffix = randomUUID().replaceAll("-", ""),
    sourceName = "test_erase_source_" + suffix,
    targetName = "test_erase_restore_" + suffix,
    pool = createPool(process.env.DATABASE_URL!, sourceName),
    target = createPool(process.env.DATABASE_URL!, targetName),
    origin = "http://127.0.0.1:4455",
    key = randomBytes(32);
  try {
    await symlink(resolve(cwd, "migrations"), resolve(dir, "migrations"));
    process.env.PRIVATE_KEY_DIR = resolve(dir, "keys");
    process.chdir(dir);
    await migrate(pool, sourceName);
    let failKeyAfterCommit = false,
      failDeletedWrite = false,
      keyPath = "";
    const faultPool: any = new Proxy(pool, {
      get(target, property) {
        if (property === "connect")
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, key) {
                if (key === "query")
                  return async (...args: any[]) => {
                    const result = await (connection.query as any)(...args);
                    if (
                      typeof args[0] === "string" &&
                      args[0].startsWith(
                        "UPDATE records SET state='deleted'",
                      ) &&
                      failDeletedWrite
                    ) {
                      failDeletedWrite = false;
                      throw Error(
                        "synthetic DB interruption after durable ledger",
                      );
                    }
                    if (args[0] === "COMMIT" && failKeyAfterCommit) {
                      failKeyAfterCommit = false;
                      await rm(keyPath);
                      await mkdir(keyPath);
                    }
                    return result;
                  };
                const value = Reflect.get(connection, key);
                return typeof value === "function"
                  ? value.bind(connection)
                  : value;
              },
            });
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const api = request.agent(
        createApp({
          pool: faultPool,
          media: [],
          origin,
          environment: "test",
          fixtureAuthEnabled: true,
        }),
      ),
      login = await api
        .post("/api/dev/login")
        .set("Origin", origin)
        .send({ persona: "owner" });
    const post = (path: string, body: any, revision?: number) => {
      let req = api
        .post(path)
        .set("Origin", origin)
        .set("X-CSRF-Token", login.body.csrfToken)
        .set("Idempotency-Key", randomUUID());
      if (revision) req = req.set("If-Match", `"${revision}"`);
      return req.send(body);
    };
    const created = await post("/api/records", {
      type: "people",
      payload: {
        ...entityDefinitions.find((d) => d.type === "people")!.defaults,
        name: "Synthetic cleanup recovery",
        notes: "SYNTHETIC_ERASE_ONLY",
        provenance: "synthetic",
        permissionBasis: "test",
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id,
      backup = await backupSnapshot(pool, sourceName, key),
      archived = await post(
        `/api/records/${id}/archive`,
        {},
        created.body.revision,
      ),
      version = archived.body.revision;
    assert.equal(archived.status, 200);
    const ledger = resolve(dir, ".local/deletion-ledger");
    await mkdir(resolve(dir, ".local"), { recursive: true });
    await writeFile(ledger, "synthetic obstruction");
    const failed = await post(
      `/api/records/${id}/delete`,
      { reason: "Erase synthetic failure fixture" },
      version,
    );
    assert.equal(failed.status, 503);
    assert.equal(
      (await pool.query("SELECT state FROM records WHERE id=$1", [id])).rows[0]
        .state,
      "archived",
    );
    assert.notEqual(exportPrivateKey(id), null);
    await rm(ledger);
    failDeletedWrite = true;
    const interrupted = await post(
      `/api/records/${id}/delete`,
      { reason: "Erase synthetic failure fixture" },
      version,
    );
    assert.equal(interrupted.status, 503);
    assert.equal(
      (await pool.query("SELECT state FROM records WHERE id=$1", [id])).rows[0]
        .state,
      "archived",
    );
    assert.notEqual(exportPrivateKey(id), null);
    const originalIntent = await readFile(
      resolve(ledger, id + ".json"),
      "utf8",
    );
    assert.equal(JSON.parse(originalIntent).recordId, id);
    // A key cleanup failure after the DB tombstone must retain an exact retry.
    keyPath = resolve(dir, "keys", id + ".key");
    failKeyAfterCommit = true;
    const pending = await post(
      `/api/records/${id}/delete`,
      { reason: "Erase synthetic failure fixture" },
      version,
    );
    assert.equal(pending.status, 503);
    assert.equal(
      (await pool.query("SELECT state FROM records WHERE id=$1", [id])).rows[0]
        .state,
      "deleted",
    );
    assert.equal(
      JSON.parse(await readFile(resolve(ledger, id + ".json"), "utf8"))
        .recordId,
      id,
    );
    await rm(keyPath, { recursive: true });
    const retry = await post(
      `/api/records/${id}/delete`,
      { reason: "Erase synthetic failure fixture" },
      version,
    );
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.cryptoErased, true);
    assert.equal(
      await readFile(resolve(ledger, id + ".json"), "utf8"),
      originalIntent,
    );
    const exactAgain = await post(
      `/api/records/${id}/delete`,
      { reason: "Erase synthetic failure fixture" },
      version,
    );
    assert.equal(exactAgain.status, 200);
    assert.equal(exactAgain.body.cryptoErased, true);
    assert.equal(exportPrivateKey(id), null);
    assert.equal(
      (
        await post(
          `/api/records/${id}/delete`,
          { reason: "Erase synthetic failure fixture" },
          version + 1,
        )
      ).status,
      409,
    );
    const report = await restoreSnapshot(target, targetName, backup, key);
    assert.equal(report.tombstonesReapplied, 1);
    const restored = (
      await target.query("SELECT state,payload FROM records WHERE id=$1", [id])
    ).rows[0];
    assert.equal(restored.state, "deleted");
    assert.deepEqual(restored.payload, {});
    assert.equal(exportPrivateKey(id), null);
  } finally {
    process.chdir(cwd);
    if (previousKeys === undefined) delete process.env.PRIVATE_KEY_DIR;
    else process.env.PRIVATE_KEY_DIR = previousKeys;
    await pool.query(`DROP SCHEMA IF EXISTS "${sourceName}" CASCADE`);
    await target.query(`DROP SCHEMA IF EXISTS "${targetName}" CASCADE`);
    await pool.end();
    await target.end();
    await rm(dir, { recursive: true, force: true });
  }
});
