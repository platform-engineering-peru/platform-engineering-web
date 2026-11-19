import { assertBlogConfirmation } from "./integrations/social-indexing";
import { requirePublicConsent } from "./consent";
import { Temporal } from "@js-temporal/polyfill";
import { validatePublicExport } from "./public-validation";
import type pg from "pg";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { definition, validatePayload } from "./product-schema";
import { canonicalJson } from "../shared/content";
import { listMedia, mediaBytes } from "./uploads";
import { verifySeedMedia } from "./media";
import { ApiError } from "./context";
export async function projectPublicRecord(
  db: pg.Pool | pg.PoolClient,
  communityId: string,
  row: any,
) {
  const def = definition(row.type);
  if (row.type === "blog")
    await assertBlogConfirmation(db, communityId, row.id, row.payload);
  if (def.scope !== "public")
    throw new ApiError(
      403,
      "PRIVATE_EXPORT_DENIED",
      "Los registros privados no se exportan al sitio.",
    );
  if (row.type === "speakers" && row.desired_status !== "archived") {
    const link = (
      await db.query(
        "SELECT * FROM public_projections WHERE public_record_id=$1",
        [row.id],
      )
    ).rows[0];
    if (link)
      await requirePublicConsent(
        db,
        communityId,
        link.person_id,
        link.profile_id,
      );
  }
  const payload = validatePayload(row.type, row.payload, true),
    fields = Object.fromEntries(def.fields.map((f) => [f.key, payload[f.key]]));
  const result: any = {
    schemaVersion: 1,
    id: row.id,
    status:
      row.desired_status ??
      (row.state === "archived" ? "archived" : "published"),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...fields,
  };
  if (row.type === "events") {
    const start = Temporal.ZonedDateTime.from(
      `${payload.date}T${payload.time}[${payload.timeZone}]`,
      { disambiguation: "reject" },
    );
    result.startsAt = start.toInstant().toString();
    result.startDate = start.toString({
      timeZoneName: "never",
      calendarName: "never",
      smallestUnit: "second",
    });
    if (payload.endTime) {
      const end = Temporal.ZonedDateTime.from(
        `${payload.date}T${payload.endTime}[${payload.timeZone}]`,
        { disambiguation: "reject" },
      );
      result.endsAt = end.toInstant().toString();
      result.endDate = end.toString({
        timeZoneName: "never",
        calendarName: "never",
        smallestUnit: "second",
      });
    } else {
      result.endsAt = null;
      result.endDate = null;
    }
  }
  if (row.type === "memories" || row.type === "organizers") {
    const inventory = await listMedia(
      db as pg.Pool,
      communityId,
      await verifySeedMedia(),
    );
    const byId = (id: string) => {
      const asset = inventory.find((a) => a.id === id);
      if (!asset)
        throw new ApiError(
          422,
          "UNKNOWN_MEDIA",
          "La imagen ya no está disponible.",
        );
      return asset;
    };
    if (row.type === "memories")
      result.media = payload.media.map((m: any) => {
        const a = byId(m.assetId),
          h = createHash("sha256")
            .update(row.id + ":" + m.assetId)
            .digest();
        h[6] = (h[6] & 15) | 128;
        h[8] = (h[8] & 63) | 128;
        const s = h.toString("hex").slice(0, 32);
        const original = (row.payload._legacyMedia ?? []).find(
          (x: any) => x.assetId === m.assetId,
        );
        return {
          id:
            original?.id ??
            (a.path.startsWith("memories/")
              ? a.id
              : `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`),
          path: a.path,
          width: a.width,
          height: a.height,
          alt: m.alt,
          fit: m.fit,
          credit: m.credit,
          ...(m.focalPoint ? { focalPoint: m.focalPoint } : {}),
        };
      });
    else {
      result.photo = byId(payload.photoAssetId).path;
      result.figurine = byId(payload.figurineAssetId).path;
    }
  }
  await validatePublicExport(row.type, result);
  return result;
}
export async function publicMediaIds(
  db: pg.Pool | pg.PoolClient,
  communityId: string,
  row: any,
) {
  if (row.type === "memories")
    return row.payload.media.map((m: any) => m.assetId);
  if (row.type === "organizers")
    return [row.payload.photoAssetId, row.payload.figurineAssetId];
  const paths =
    row.type === "speakers"
      ? [row.payload.photo]
      : row.type === "brands"
        ? [row.payload.path, row.payload.previewPath]
        : [];
  const inventory = await listMedia(
    db as pg.Pool,
    communityId,
    await verifySeedMedia(),
  );
  return inventory.filter((a) => paths.includes(a.path)).map((a) => a.id);
}
export async function exportApprovedRecords(
  db: pg.Pool | pg.PoolClient,
  communityId: string,
  ids: string[],
) {
  if (!ids.length || ids.length > 100)
    throw new ApiError(
      422,
      "EXPORT_LIMIT",
      "Selecciona entre uno y cien registros.",
    );
  const files: { path: string; content: string }[] = [],
    assets: { path: string; sha256: string; sourcePath: string }[] = [],
    revisionHashes: Record<string, string> = {};
  for (const id of [...new Set(ids)].sort()) {
    const row = (
      await db.query(
        "SELECT * FROM records WHERE id=$1 AND community_id=$2 FOR SHARE",
        [id, communityId],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND", "Registro no encontrado.");
    if (row.state !== "approved" || row.approved_hash !== row.revision_hash)
      throw new ApiError(
        409,
        "APPROVAL_REQUIRED",
        "La revisión actual no está aprobada.",
      );
    const record = await projectPublicRecord(db, communityId, row);
    files.push({
      path: `content/${row.type}/${id}.json`,
      content: canonicalJson(record) + "\n",
    });
    revisionHashes[id] = row.revision_hash;
    const mediaIds = await publicMediaIds(db, communityId, row);
    for (const mediaId of mediaIds) {
      const data = await mediaBytes(
        db as pg.Pool,
        communityId,
        mediaId,
        await verifySeedMedia(),
      );
      if (!assets.some((a) => a.path === "public/" + data.path)) {
        const sourcePath = resolve(".local/exports", communityId, data.sha256);
        await mkdir(resolve(".local/exports", communityId), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(sourcePath, data.bytes, { mode: 0o600 });
        assets.push({
          path: "public/" + data.path,
          sha256: data.sha256,
          sourcePath,
        });
      }
    }
  }
  return { files, assets, revisionHashes };
}
