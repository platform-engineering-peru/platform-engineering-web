import type { Request } from "express";
import type pg from "pg";
import { hashRevision } from "../shared/content";
import { ApiError, type Session } from "./context";
export async function replay(db: pg.PoolClient, user: Session, req: Request) {
  const key = req.get("Idempotency-Key");
  if (!key || key.length > 200)
    throw new ApiError(
      428,
      "IDEMPOTENCY_KEY_REQUIRED",
      "La solicitud necesita una clave de reintento.",
    );
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    user.communityId + ":" + key,
  ]);
  const hash = hashRevision({
    method: req.method,
    path: req.path,
    body: req.body,
    revision: req.get("If-Match") ?? null,
  });
  const row = (
    await db.query(
      "SELECT * FROM core_idempotency WHERE community_id=$1 AND key=$2 AND expires_at>now()",
      [user.communityId, key],
    )
  ).rows[0];
  if (row && row.request_hash !== hash)
    throw new ApiError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "La clave ya se usó con otros datos.",
    );
  return { key, hash, cached: row?.response };
}
export async function remember(
  db: pg.PoolClient,
  user: Session,
  entry: { key: string; hash: string },
  response: unknown,
) {
  await db.query(
    "INSERT INTO core_idempotency(community_id,key,request_hash,response,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days') ON CONFLICT(community_id,key) DO UPDATE SET request_hash=EXCLUDED.request_hash,response=EXCLUDED.response,expires_at=EXCLUDED.expires_at",
    [user.communityId, entry.key, entry.hash, response],
  );
}
