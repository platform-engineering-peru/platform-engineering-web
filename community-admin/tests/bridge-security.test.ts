import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool, migrate } from "../src/server/db";
import { VideoAssets } from "../src/server/integrations/video";
import { fullIntegrationOptions } from "../src/server/integration-bridge";
test("actual worker bridge rejects foreign video before local or S3 byte access", async () => {
  const schema = "test_bridge_" + randomUUID().replaceAll("-", "");
  const pool = createPool(process.env.DATABASE_URL!, schema);
  const old = process.env.STORAGE_BACKEND;
  const read = VideoAssets.prototype.read;
  let byteReads = 0;
  VideoAssets.prototype.read = async () => {
    byteReads++;
    throw new Error("BYTE_ACCESS_FORBIDDEN");
  };
  try {
    await migrate(pool, schema);
    const bridge = fullIntegrationOptions(pool);
    const foreignId = randomUUID(),
      foreignCommunity = randomUUID();
    await pool.query(
      "INSERT INTO integration_video_assets(id,community_id,actor_id,storage_key,backend,bytes,mime,sha256,state) VALUES($1,$2,$3,$4,'local',128,'video/mp4',$5,'verified')",
      [
        foreignId,
        foreignCommunity,
        randomUUID(),
        "MUST_NOT_READ_FOREIGN_BYTES",
        "0".repeat(64),
      ],
    );
    for (const backend of ["local", "s3"]) {
      process.env.STORAGE_BACKEND = backend;
      process.env.S3_BUCKET = "synthetic-private-bucket";
      process.env.S3_REGION = "us-east-1";
      process.env.S3_ENDPOINT = "https://s3.example.invalid";
      await assert.rejects(
        bridge.readAsset(foreignId, 0, 128, randomUUID()),
        /VIDEO_NOT_FOUND/,
      );
      await assert.rejects(
        bridge.readAsset(randomUUID(), 0, 128, undefined),
        /VIDEO_COMMUNITY_REQUIRED/,
      );
    }
    assert.equal(
      byteReads,
      0,
      "Foreign IDs must be denied before either storage reader",
    );
  } finally {
    VideoAssets.prototype.read = read;
    if (old === undefined) delete process.env.STORAGE_BACKEND;
    else process.env.STORAGE_BACKEND = old;
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
