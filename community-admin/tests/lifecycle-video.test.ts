import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import { VideoAssets } from "../src/server/integrations/video";
import { hashValue } from "../src/server/integrations/security";
test("owned unused video disposal is distinct from image removal, fences version/leases/references and preserves provenance", async () => {
  const schema = "test_lifecycle_video_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema);
  try {
    await migrate(pool, schema);
    const actor = (await pool.query("SELECT id FROM users WHERE role='owner'"))
      .rows[0].id;
    const videos: any = new VideoAssets(pool),
      body = Buffer.from("synthetic-video-part"),
      sha = createHash("sha256").update(body).digest("hex");
    const upload = await videos.begin(
        COMMUNITY_ID,
        actor,
        body.length,
        "video/mp4",
        sha,
      ),
      row = await videos.get(COMMUNITY_ID, upload.id);
    const version = (r: any) =>
      hashValue({
        id: r.id,
        sha256: r.sha256,
        state: r.state,
        parts: r.parts,
        updatedAt: new Date(r.updated_at).toISOString(),
      });
    await videos.localPart(COMMUNITY_ID, upload.id, 1, body);
    await assert.rejects(
      videos.remove(
        COMMUNITY_ID,
        actor,
        upload.id,
        "stale",
        "Dispose synthetic video",
      ),
      { code: "REVISION_CONFLICT" },
    );
    const pub = randomUUID();
    await pool.query(
      "INSERT INTO integration_publications(id,community_id,author_id,channel,destination,payload,revision_hash,state) VALUES($1,$2,$3,'youtube','synthetic',$4,'hash','unknown')",
      [pub, COMMUNITY_ID, actor, { assetId: upload.id }],
    );
    await assert.rejects(
      videos.remove(
        COMMUNITY_ID,
        actor,
        upload.id,
        version(row),
        "Dispose synthetic video",
      ),
      { code: "VIDEO_REFERENCED" },
    );
    await pool.query("DELETE FROM integration_publications WHERE id=$1", [pub]);
    const removed = await videos.remove(
      COMMUNITY_ID,
      actor,
      upload.id,
      version(row),
      "Dispose synthetic video",
    );
    assert.equal(removed.state, "removed");
    assert.equal(removed.remoteUnchanged, true);
    assert.equal(removed.bytesRemoved, true);
    const retained = (
      await pool.query(
        "SELECT state,sha256 FROM integration_video_assets WHERE community_id=$1 AND id=$2",
        [COMMUNITY_ID, upload.id],
      )
    ).rows[0];
    assert.equal(retained.state, "removed");
    assert.equal(retained.sha256, sha);
    await assert.rejects(videos.localPart(COMMUNITY_ID, upload.id, 1, body), {
      code: "UPLOAD_REMOVED",
    });
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});

test("private multipart disposal uses exact existing abort capability, rejects foreign ownership and works with a one-connection pool", async () => {
  const schema =
      "test_lifecycle_video_single_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema);
  (pool as any).options.max = 1;
  try {
    await migrate(pool, schema);
    const actor = (await pool.query("SELECT id FROM users WHERE role='owner'"))
        .rows[0].id,
      aborts: any[] = [];
    const backend: any = {
      name: "s3",
      begin: async () => "synthetic-upload",
      signPart: async () => "https://storage.invalid/part",
      complete: async () => {},
      read: async () => Buffer.alloc(0),
      digest: async () => ({
        bytes: 1,
        sha256: "f".repeat(64),
        signature: Buffer.alloc(32),
      }),
      abort: async (key: string, id: string) => {
        aborts.push({ key, id });
      },
    };
    const videos: any = new VideoAssets(pool, backend),
      upload = await videos.begin(
        COMMUNITY_ID,
        actor,
        1,
        "video/mp4",
        "f".repeat(64),
      );
    await assert.rejects(
      videos.remove(
        COMMUNITY_ID,
        randomUUID(),
        upload.id,
        upload.version,
        "Remove synthetic multipart",
      ),
      { code: "VIDEO_NOT_OWNED" },
    );
    assert.equal(aborts.length, 0);
    const removed = await videos.remove(
      COMMUNITY_ID,
      actor,
      upload.id,
      upload.version,
      "Remove synthetic multipart",
    );
    assert.equal(removed.bytesRemoved, true);
    assert.equal(aborts.length, 1);
    assert.equal(aborts[0].id, "synthetic-upload");
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});

test("video cleanup failure keeps a versioned retry and attachment/removal races join the same cross-connection lock", async () => {
  const schema =
      "test_lifecycle_video_races_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema);
  try {
    await migrate(pool, schema);
    const actor = (await pool.query("SELECT id FROM users WHERE role='owner'"))
      .rows[0].id;
    let fail = true,
      aborts = 0,
      entered: () => void = () => {},
      release: () => void = () => {},
      pause = false;
    const backend: any = {
      name: "s3",
      begin: async () => "synthetic",
      signPart: async () => "",
      complete: async () => {},
      read: async () => Buffer.alloc(0),
      digest: async () => ({
        bytes: 1,
        sha256: "a".repeat(64),
        signature: Buffer.alloc(32),
      }),
      abort: async () => {
        aborts++;
        if (fail) throw Error("synthetic partial abort/delete failure");
        if (pause) {
          entered();
          await new Promise<void>((r) => {
            release = r;
          });
        }
      },
    };
    const videos: any = new VideoAssets(pool, backend),
      upload = await videos.begin(
        COMMUNITY_ID,
        actor,
        1,
        "video/mp4",
        "a".repeat(64),
      );
    const first = await videos.remove(
      COMMUNITY_ID,
      actor,
      upload.id,
      upload.version,
      "Remove synthetic multipart",
    );
    assert.equal(first.cleanupPending, true);
    assert.equal(first.bytesRemoved, false);
    assert.equal(first.state, "cleanup-pending");
    assert.notEqual(first.version, upload.version);
    await assert.rejects(
      videos.remove(
        COMMUNITY_ID,
        actor,
        upload.id,
        upload.version,
        "Retry synthetic multipart",
      ),
      { code: "REVISION_CONFLICT" },
    );
    assert.equal(aborts, 1);
    fail = false;
    const retried = await videos.remove(
      COMMUNITY_ID,
      actor,
      upload.id,
      first.version,
      "Retry synthetic multipart",
    );
    assert.equal(retried.bytesRemoved, true);
    assert.equal(aborts, 2);
    const again = await videos.remove(
      COMMUNITY_ID,
      actor,
      upload.id,
      retried.version,
      "Repeat exact completed cleanup",
    );
    assert.equal(again.state, "removed");
    assert.equal(aborts, 2);
    const { videoReferenceFence } = await import("../src/server/lifecycle"),
      { videoVersion } = await import("../src/server/integrations/video"),
      { transaction } = await import("../src/server/db");
    const another = await videos.begin(
      COMMUNITY_ID,
      actor,
      1,
      "video/mp4",
      "a".repeat(64),
    );
    await pool.query(
      "UPDATE integration_video_assets SET state='verified',updated_at=now() WHERE id=$1",
      [another.id],
    );
    const current = await videos.get(COMMUNITY_ID, another.id),
      db = await pool.connect();
    await db.query("BEGIN");
    await videoReferenceFence(db, COMMUNITY_ID, {
      assetId: another.id,
      sha256: current.sha256,
    });
    await assert.rejects(
      videos.remove(
        COMMUNITY_ID,
        actor,
        another.id,
        videoVersion(current),
        "Remove while attachment owns lock",
      ),
      { code: "VIDEO_IN_PROGRESS" },
    );
    await db.query("ROLLBACK");
    db.release();
    pause = true;
    const atAbort = new Promise<void>((r) => {
      entered = r;
    });
    const removal = videos.remove(
      COMMUNITY_ID,
      actor,
      another.id,
      videoVersion(current),
      "Remove before late attachment",
    );
    await atAbort;
    const attached = transaction(pool, (db) =>
      videoReferenceFence(db, COMMUNITY_ID, {
        assetId: another.id,
        sha256: current.sha256,
      }),
    ).then(
      () => null,
      (e) => e,
    );
    release();
    assert.equal((await removal).bytesRemoved, true);
    assert.equal((await attached)?.code, "VIDEO_NOT_VERIFIED");
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});

test("HTTP video inventory and lifecycle expose only owned snapshots and use a distinct strict versioned disposal route", async () => {
  const schema =
      "test_lifecycle_video_http_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema),
    origin = "http://127.0.0.1:4455";
  try {
    await migrate(pool, schema);
    const { createApp } = await import("../src/server/app"),
      request = (await import("supertest")).default,
      app = createApp({
        pool,
        media: [],
        origin,
        fixtureAuthEnabled: true,
        environment: "test",
      }),
      owner = request.agent(app);
    const login = await owner
        .post("/api/dev/login")
        .set("Origin", origin)
        .send({ persona: "owner" }),
      headers = { Origin: origin, "X-CSRF-Token": login.body.csrfToken };
    const created = await owner
      .post("/api/video/uploads")
      .set(headers)
      .send({ bytes: 8, mime: "video/mp4", sha256: "b".repeat(64) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.version, /^[a-f0-9]{64}$/);
    const list = await owner.get("/api/video/uploads");
    assert.equal(list.body.items[0].version, created.body.version);
    assert.equal("storage_key" in list.body.items[0], false);
    const descriptor = await owner.get(
      `/api/lifecycle/video-assets/${created.body.id}`,
    );
    assert.equal(descriptor.body.version, created.body.version);
    assert.equal(descriptor.body.actions[0].allowed, true);
    await pool.query(
      "UPDATE users SET roles=ARRAY['owner']::text[] WHERE role='editor'",
    );
    const other = request.agent(app),
      otherLogin = await other
        .post("/api/dev/login")
        .set("Origin", origin)
        .send({ persona: "editor" });
    assert.equal(
      (await other.get(`/api/lifecycle/video-assets/${created.body.id}`))
        .status,
      404,
    );
    assert.equal((await other.get("/api/video/uploads")).body.items.length, 0);
    const denied = await other
      .post(`/api/video/uploads/${created.body.id}/parts`)
      .set("Origin", origin)
      .set("X-CSRF-Token", otherLogin.body.csrfToken)
      .send({ partNumber: 1 });
    assert.equal(denied.status, 404);
    const remove = (tag: string) =>
      owner
        .delete(`/api/video/uploads/${created.body.id}`)
        .set(headers)
        .set("If-Match", tag)
        .send({ reason: "Dispose synthetic HTTP video" });
    assert.equal((await remove('"1"')).status, 422);
    assert.equal((await remove(`"${"b".repeat(64)}"`)).status, 409);
    const removed = await remove(`"${created.body.version}"`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.bytesRemoved, true);
    assert.equal((await owner.get("/api/video/uploads")).body.items.length, 0);
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});

for (const storage of ["local", "multipart"]) {
  test(`${storage} cleanup intent survives interruption after commit and recovers with a fresh captured token`, async () => {
    const schema = "test_video_crash_" + randomUUID().replaceAll("-", ""),
      pool = createPool(process.env.DATABASE_URL!, schema);
    let uploadId: string | undefined;
    try {
      await migrate(pool, schema);
      const actor = (
        await pool.query("SELECT id FROM users WHERE role='owner'")
      ).rows[0].id;
      let aborts = 0;
      const backend: any =
        storage === "multipart"
          ? {
              name: "s3",
              begin: async () => "synthetic-crash-upload",
              abort: async () => {
                aborts++;
              },
            }
          : undefined;
      const videos = new VideoAssets(pool, backend),
        upload = await videos.begin(
          COMMUNITY_ID,
          actor,
          1,
          "video/mp4",
          "d".repeat(64),
        );
      uploadId = upload.id;
      const { access, rm } = await import("node:fs/promises"),
        { resolve } = await import("node:path"),
        { videoVersion } = await import("../src/server/integrations/video"),
        localDirectory = resolve(".local/video", upload.id);
      let interrupt = true;
      // Simulate process interruption immediately after durable intent commit,
      // before either local deletion or backend abort is entered.
      const interruptedPool: any = new Proxy(pool, {
        get(target, property) {
          if (property === "connect")
            return async () => {
              const client = await target.connect();
              return new Proxy(client, {
                get(connection, key) {
                  if (key === "query")
                    return async (...args: any[]) => {
                      const result = await (connection.query as any)(...args);
                      if (args[0] === "COMMIT" && interrupt) {
                        interrupt = false;
                        throw Error(
                          "synthetic process interrupted after durable intent",
                        );
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
      await assert.rejects(
        new VideoAssets(interruptedPool, backend).remove(
          COMMUNITY_ID,
          actor,
          upload.id,
          upload.version,
          "Dispose interrupted synthetic upload",
        ),
        /synthetic process interrupted/,
      );
      assert.equal(aborts, 0);
      if (storage === "local") await access(localDirectory);
      const pending = (
        await pool.query("SELECT * FROM integration_video_assets WHERE id=$1", [
          upload.id,
        ])
      ).rows[0];
      assert.equal(pending.state, "cleanup-pending");
      const recovered = new VideoAssets(pool, backend),
        currentToken = videoVersion(pending);
      await assert.rejects(recovered.get(COMMUNITY_ID, upload.id), {
        code: "UPLOAD_REMOVED",
      });
      const inventory = await pool.query(
        "SELECT id FROM integration_video_assets WHERE community_id=$1 AND actor_id=$2 AND state<>'removed'",
        [COMMUNITY_ID, actor],
      );
      assert.equal(
        inventory.rows.some((row) => row.id === upload.id),
        true,
      );
      await assert.rejects(
        recovered.remove(
          COMMUNITY_ID,
          actor,
          upload.id,
          upload.version,
          "Retry stale cleanup",
        ),
        { code: "REVISION_CONFLICT" },
      );
      const result = await recovered.remove(
        COMMUNITY_ID,
        actor,
        upload.id,
        currentToken,
        "Recover interrupted cleanup",
      );
      assert.equal(result.state, "removed");
      assert.equal(result.bytesRemoved, true);
      if (storage === "local")
        await assert.rejects(access(localDirectory), { code: "ENOENT" });
      else assert.equal(aborts, 1);
      const repeated = await recovered.remove(
        COMMUNITY_ID,
        actor,
        upload.id,
        result.version,
        "Repeat completed cleanup",
      );
      assert.equal(repeated.bytesRemoved, true);
      assert.equal(aborts, storage === "multipart" ? 1 : 0);
      await rm(localDirectory, { recursive: true, force: true });
    } finally {
      if (uploadId) {
        const { rm } = await import("node:fs/promises");
        await rm(".local/video/" + uploadId, { recursive: true, force: true });
      }
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    }
  });
}
