import type pg from "pg";
import { ApiError } from "./context";
import { entityDefinitions } from "../shared/product-contract";
import { decryptPrivate } from "./private-data";
export type LifecycleAction =
  | "archive"
  | "erase"
  | "discard"
  | "withdraw"
  | "exclude"
  | "reopen"
  | "retire"
  | "cancel"
  | "remove";
export type LifecycleEffect =
  | "local-archive"
  | "private-erasure"
  | "local-discard"
  | "public-withdrawal"
  | "local-exclusion"
  | "review-required"
  | "source-retirement"
  | "unsent-cancellation"
  | "owned-upload-removal";
export interface LifecycleBlocker {
  code: string;
  module: string;
  id: string;
}
export function containsReference(value: any, targets: string[]): boolean {
  if (typeof value === "string")
    return targets.some(
      (t) => value === t || (t.includes("/") && value.includes(t)),
    );
  if (Array.isArray(value))
    return value.some((v) => containsReference(v, targets));
  return (
    !!value &&
    typeof value === "object" &&
    Object.values(value).some((v) => containsReference(v, targets))
  );
}
export async function recordReferences(
  db: pg.Pool | pg.PoolClient,
  community: string,
  id: string,
) {
  const rows = (
    await db.query(
      "SELECT * FROM records WHERE community_id=$1 AND id<>$2 AND state NOT IN('archived','deleted') ORDER BY id",
      [community, id],
    )
  ).rows;
  const refs: LifecycleBlocker[] = [];
  for (const row of rows) {
    const payload =
      row.scope === "private"
        ? decryptPrivate(row.id, row.payload)
        : row.payload;
    const def = entityDefinitions.find((d) => d.type === row.type);
    if (
      def?.fields.some(
        (f) =>
          f.kind === "reference" && containsReference(payload[f.key], [id]),
      )
    )
      refs.push({ code: "RECORD_REFERENCED", module: "records", id: row.id });
  }
  return refs;
}
/** Take the sender's same operation lock, then inspect durable attempts. A local label never proves absence. */
export const operationIdentity = (row: any) =>
  row.result?.bridge === "jobs-cli"
    ? (row.result.proposalId ?? row.id)
    : (row.result?.operationId ?? row.id);
export async function publicationBlockers(
  db: pg.Pool | pg.PoolClient,
  community: string,
  id: string,
  lock = false,
): Promise<LifecycleBlocker[]> {
  const rows = (
    await db.query(
      "SELECT * FROM integration_changesets WHERE community_id=$1 AND (result->'recordIds' ? $2 OR result->'jobIds' ? $2 OR files @> $3::jsonb OR files::text LIKE '%'||$2||'%')",
      [community, id, JSON.stringify([{ record: { id } }])],
    )
  ).rows;
  const blockers: LifecycleBlocker[] = [];
  for (const row of rows) {
    if (lock) {
      const key =
        (row.result?.bridge === "jobs-cli"
          ? "jobs-cli-operation:"
          : "website-operation:") +
        community +
        ":" +
        row.id;
      const held = (
        await db.query(
          "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS held",
          [key],
        )
      ).rows[0].held;
      if (!held) {
        blockers.push({
          code: "PUBLICATION_PENDING",
          module: "changesets",
          id: row.id,
        });
        continue;
      }
    }
    const attempts = (
      await db.query(
        "SELECT attempt FROM website_publication_attempts WHERE operation_id=$1 ORDER BY sequence",
        [operationIdentity(row)],
      )
    ).rows;
    const last = attempts.at(-1)?.attempt;
    if (
      [
        "prepared",
        "approved",
        "queued",
        "preparing",
        "publishing",
        "sending",
        "unknown",
        "uncertain",
        "pr_open",
      ].includes(row.state) ||
      ["sending", "uncertain"].includes(last?.state)
    )
      blockers.push({
        code: "PUBLICATION_PENDING",
        module: "changesets",
        id: row.id,
      });
  }
  return blockers;
}
export async function assertLifecyclePublication(
  db: pg.PoolClient,
  community: string,
  id: string,
) {
  if ((await publicationBlockers(db, community, id, true)).length)
    throw new ApiError(
      409,
      "PUBLICATION_PENDING",
      "Consulta o cancela la operación pendiente antes de cambiar su contenido.",
    );
}
export async function assertRecordReferences(
  db: pg.PoolClient,
  community: string,
  id: string,
) {
  if ((await recordReferences(db, community, id)).length)
    throw new ApiError(
      409,
      "RECORD_REFERENCED",
      "Otro registro activo usa esta identidad.",
    );
}
/** All record writers share this with upload removal, including stale prevalidated requests. */
export async function mediaReferenceFence(
  db: pg.PoolClient,
  community: string,
  payload: any,
) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    community + ":storage",
  ]);
  const removed = (
    await db.query(
      "SELECT entity_id FROM audit_events WHERE community_id=$1 AND action='media_removed'",
      [community],
    )
  ).rows;
  if (removed.some((r) => containsReference(payload, [r.entity_id])))
    throw new ApiError(
      422,
      "MEDIA_REMOVED",
      "La imagen se eliminó de esta biblioteca.",
    );
}

export async function videoRemovalBlockers(
  db: pg.Pool | pg.PoolClient,
  community: string,
  row: any,
): Promise<LifecycleBlocker[]> {
  const blockers: LifecycleBlocker[] = [];
  const publications = (
    await db.query(
      "SELECT id,payload FROM integration_publications WHERE community_id=$1",
      [community],
    )
  ).rows;
  for (const p of publications)
    if (containsReference(p.payload, [row.id, row.storage_key]))
      blockers.push({
        code: "VIDEO_REFERENCED",
        module: "publications",
        id: p.id,
      });
  const operations = (
    await db.query(
      "SELECT id,payload FROM worker_outbox WHERE community_id=$1",
      [community],
    )
  ).rows;
  for (const p of operations)
    if (containsReference(p.payload, [row.id, row.storage_key]))
      blockers.push({
        code: "VIDEO_REFERENCED",
        module: "operations",
        id: p.id,
      });
  const shared = (
    await db.query(
      "SELECT id FROM integration_video_assets WHERE storage_key=$1 AND id<>$2 AND state NOT IN('removed','expired')",
      [row.storage_key, row.id],
    )
  ).rows;
  if (shared.length)
    blockers.push({ code: "VIDEO_SHARED", module: "video-assets", id: row.id });
  return blockers;
}

export async function videoReferenceFence(
  db: pg.PoolClient,
  community: string,
  payload: any,
) {
  if (!payload.assetId) return;
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `video-asset:${community}:${payload.assetId}`,
  ]);
  const row = (
    await db.query(
      "SELECT * FROM integration_video_assets WHERE community_id=$1 AND id=$2 AND state='verified' AND expires_at>now() FOR KEY SHARE",
      [community, payload.assetId],
    )
  ).rows[0];
  if (!row || row.sha256 !== payload.sha256)
    throw new ApiError(
      422,
      "VIDEO_NOT_VERIFIED",
      "La carga de video ya no está disponible.",
    );
}
