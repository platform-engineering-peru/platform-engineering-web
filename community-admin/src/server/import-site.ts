import { mediaReferenceFence } from "./lifecycle";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type pg from "pg";
import { entityDefinitions } from "../shared/product-contract";
import { definition, validatePayload } from "./product-schema";
import { hashRevision } from "../shared/content";
import { privateStorage } from "./storage";
import { transaction } from "./db";
import { ApiError, auditEvent, type Session } from "./context";
export function stableUuid(key: string) {
  const b = createHash("sha256")
    .update("platform-engineering-peru:" + key)
    .digest();
  b[6] = (b[6] & 15) | 128;
  b[8] = (b[8] & 63) | 128;
  const s = b.toString("hex").slice(0, 32);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export function websiteRoot() {
  return resolve(
    process.env.WEBSITE_CHECKOUT ?? "../platform-engineering-peru",
  );
}
async function registerMedia(
  db: pg.PoolClient,
  user: Session,
  path: string,
  root: string,
  forcedId?: string,
) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9/_ .-]+$/.test(path) ||
    path.split("/").includes("..")
  )
    throw new ApiError(422, "UNSAFE_ASSET", "Ruta de imagen no válida.");
  const bytes = await readFile(resolve(root, "public", path)),
    metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
  await sharp(bytes, { limitInputPixels: 40_000_000 }).raw().toBuffer();
  const id = forcedId ?? stableUuid("asset:" + path),
    sha256 = createHash("sha256").update(bytes).digest("hex"),
    key = `${user.communityId}/imported/${sha256}`,
    storage = privateStorage();
  await storage.put(
    key,
    bytes,
    metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`,
  );
  await db.query(
    "INSERT INTO media_assets(id,community_id,path,sha256,width,height,mime,bytes,storage_key,storage_backend,original_name,rights) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING",
    [
      id,
      user.communityId,
      path,
      sha256,
      metadata.width,
      metadata.height,
      metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`,
      bytes.length,
      key,
      storage.backend,
      path,
      {
        source: "existing approved website asset",
        permissionBasis:
          "preserved existing public source; no new rights asserted",
      },
    ],
  );
  return id;
}
export async function importSite(pool: pg.Pool, user: Session, dryRun = true) {
  const root = websiteRoot();
  await stat(resolve(root, "astro.config.mjs"));
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const inputs: {
      type: string;
      id: string;
      payload: any;
      sourceHash: string;
      sourceKey: string;
    }[] = [],
    warnings: string[] = [];
  for (const def of entityDefinitions.filter((d) => d.scope === "public")) {
    let names: string[];
    try {
      names = await readdir(resolve(root, "content", def.type));
    } catch {
      warnings.push(`No content directory: ${def.type}`);
      continue;
    }
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
      const text = await readFile(
          resolve(root, "content", def.type, name),
          "utf8",
        ),
        record = JSON.parse(text),
        payload: any = {
          ...structuredClone(def.defaults),
          ...Object.fromEntries(
            def.fields
              .filter((f) => record[f.key] !== undefined)
              .map((f) => [f.key, record[f.key]]),
          ),
        };
      if (def.type === "memories")
        payload.media = record.media.map((m: any) => ({
          assetId: m.id,
          alt: m.alt,
          fit: m.fit,
          credit: m.credit,
        }));
      if (def.type === "organizers") {
        payload.photoAssetId = stableUuid("asset:" + record.photo);
        payload.figurineAssetId = stableUuid("asset:" + record.figurine);
      }
      validatePayload(def.type, payload);
      inputs.push({
        type: def.type,
        id: record.id,
        payload,
        sourceHash: hashRevision(record),
        sourceKey: `content/${def.type}/${name}`,
      });
    }
  }
  const report = {
    dryRun,
    sourceCommit,
    counts: Object.fromEntries(
      entityDefinitions
        .filter((d) => d.scope === "public")
        .map((d) => [d.type, inputs.filter((i) => i.type === d.type).length]),
    ),
    idMap: inputs.map((i) => ({ source: i.sourceKey, id: i.id })),
    warnings,
    imported: 0,
    unchanged: 0,
    conflicts: [] as string[],
  };
  if (dryRun) return report;
  await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      user.communityId + ":record-lifecycle",
    ]);
    for (const item of inputs) {
      const existing = (
        await db.query(
          "SELECT * FROM records WHERE id=$1 AND community_id=$2 FOR UPDATE",
          [item.id, user.communityId],
        )
      ).rows[0];
      if (existing) {
        if (existing.source_hash === item.sourceHash) {
          report.unchanged++;
          continue;
        }
        report.conflicts.push(item.id);
        continue;
      }
      let unavailable = false;
      for (const field of definition(item.type).fields.filter(
        (f) => f.kind === "reference" && f.target !== "media",
      )) {
        const values = field.multiple
          ? (item.payload[field.key] ?? [])
          : item.payload[field.key]
            ? [item.payload[field.key]]
            : [];
        for (const id of values) {
          const target = (
            await db.query(
              "SELECT type,state,desired_status FROM records WHERE community_id=$1 AND id=$2",
              [user.communityId, id],
            )
          ).rows[0];
          if (
            target
              ? target.type !== field.target ||
                ["archived", "deleted"].includes(target.state) ||
                target.desired_status === "archived"
              : !inputs.some((i) => i.id === id && i.type === field.target)
          )
            unavailable = true;
        }
      }
      if (unavailable) {
        report.conflicts.push(item.id);
        continue;
      }
      await mediaReferenceFence(db, user.communityId, item.payload);
      const source = JSON.parse(
        await readFile(resolve(root, item.sourceKey), "utf8"),
      );
      if (item.type === "memories")
        for (const m of source.media)
          await registerMedia(db, user, m.path, root, m.id);
      if (item.type === "organizers") {
        await registerMedia(db, user, source.photo, root);
        await registerMedia(db, user, source.figurine, root);
      }
      const updatedAt = new Date().toISOString(),
        revisionHash = hashRevision({
          id: item.id,
          revision: 1,
          payload: item.payload,
          updatedAt,
        });
      await db.query(
        "INSERT INTO records(id,community_id,type,scope,author_id,payload,revision,state,revision_hash,source_hash,source_commit,updated_at) VALUES($1,$2,$3,'public',$4,$5,1,'draft',$6,$7,$8,$9)",
        [
          item.id,
          user.communityId,
          item.type,
          user.id,
          item.payload,
          revisionHash,
          item.sourceHash,
          sourceCommit,
          updatedAt,
        ],
      );
      await db.query(
        "INSERT INTO record_revisions(record_id,revision,payload,revision_hash,updated_at) VALUES($1,1,$2,$3,$4)",
        [item.id, item.payload, revisionHash, updatedAt],
      );
      await db.query(
        "INSERT INTO source_mappings(source_key,record_id,source_hash,source_commit) VALUES($1,$2,$3,$4) ON CONFLICT(source_key) DO NOTHING",
        [item.sourceKey, item.id, item.sourceHash, sourceCommit],
      );
      report.imported++;
      await auditEvent(db, user, item.id, "site_record_imported", {
        source: item.sourceKey,
        sourceCommit,
      });
    }
  });
  return report;
}
