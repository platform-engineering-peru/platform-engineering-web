import type pg from "pg";
import { transaction } from "../db";
import { hashValue, IntegrationError } from "./security";
export async function idempotent<T>(
  pool: pg.Pool,
  communityId: string,
  key: string,
  payload: unknown,
  operation: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!key || key.length > 200)
    throw new IntegrationError("IDEMPOTENCY_KEY_REQUIRED", 428);
  const hash = hashValue(payload);
  return transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      communityId + ":" + key,
    ]);
    const row = (
      await db.query(
        "SELECT * FROM integration_requests WHERE community_id=$1 AND key=$2",
        [communityId, key],
      )
    ).rows[0];
    if (row) {
      if (row.request_hash !== hash)
        throw new IntegrationError("IDEMPOTENCY_CONFLICT", 409);
      return row.response as T;
    }
    const result = await operation(db);
    await db.query(
      "INSERT INTO integration_requests(community_id,key,request_hash,response) VALUES($1,$2,$3,$4)",
      [communityId, key, hash, JSON.stringify(result)],
    );
    return result;
  });
}
