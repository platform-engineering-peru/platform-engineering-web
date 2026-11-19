import type pg from "pg";
import { randomUUID } from "node:crypto";
import { transaction } from "../db";
import { hashValue, IntegrationError } from "../integrations/security";
export interface Intent {
  communityId: string;
  actorId: string;
  kind: string;
  subjectId: string;
  key: string;
  payload: unknown;
  availableAt?: Date;
  semanticKey?: string;
}
export async function enqueue(db: pg.Pool | pg.PoolClient, intent: Intent) {
  const hash = hashValue({
    kind: intent.kind,
    subjectId: intent.subjectId,
    payload: intent.payload,
  });
  const result = await db.query(
    `INSERT INTO worker_outbox(id,community_id,actor_id,kind,subject_id,intent_key,request_hash,payload,available_at,semantic_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING *`,
    [
      randomUUID(),
      intent.communityId,
      intent.actorId,
      intent.kind,
      intent.subjectId,
      intent.key,
      hash,
      intent.payload,
      intent.availableAt ?? new Date(),
      intent.semanticKey ?? null,
    ],
  );
  const row =
    result.rows[0] ??
    (
      await db.query(
        "SELECT * FROM worker_outbox WHERE community_id=$1 AND (intent_key=$2 OR semantic_key=$3)",
        [intent.communityId, intent.key, intent.semanticKey ?? null],
      )
    ).rows[0];
  if (row.request_hash !== hash)
    throw new IntegrationError("IDEMPOTENCY_CONFLICT", 409);
  return row;
}
export class OutboxWorker {
  constructor(
    public pool: pg.Pool,
    public owner = randomUUID(),
  ) {}
  async claim() {
    return transaction(this.pool, async (db) => {
      // A crashed sender may have succeeded remotely. Never automatically resend expired sending leases.
      const expired = await db.query(
        "UPDATE worker_outbox SET state='unknown',last_code='LEASE_EXPIRED_RECONCILE',lease_owner=NULL,lease_until=NULL WHERE state='sending' AND lease_until<now() RETURNING kind,subject_id,community_id,payload",
      );
      for (const op of expired.rows)
        if (op.kind === "publication")
          await db.query(
            "UPDATE integration_publications SET state='unknown' WHERE id=$1 AND state='sending'",
            [op.subject_id],
          );
      for (const op of expired.rows)
        if (
          ["changeset", "jobs-changeset"].includes(op.kind) &&
          op.payload?.publicationMode === "direct"
        )
          await db.query(
            "UPDATE integration_changesets SET state='uncertain',result=result||$3::jsonb WHERE community_id=$1 AND id=$2 AND state NOT IN('committed','deployed','deployment_failed','superseded')",
            [
              op.community_id,
              op.subject_id,
              { errorCode: "LEASE_EXPIRED_RECONCILE" },
            ],
          );
      const result = await db.query(
        `WITH ready AS (SELECT id FROM worker_outbox WHERE state='queued' AND available_at<=now() ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE worker_outbox SET state='sending',lease_owner=$1,lease_until=now()+interval '60 seconds',attempts=attempts+1,updated_at=now() WHERE id IN(SELECT id FROM ready) RETURNING *`,
        [this.owner],
      );
      return result.rows[0];
    });
  }
  async heartbeat(id: string) {
    const result = await this.pool.query(
      "UPDATE worker_outbox SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND state='sending' AND lease_owner=$2 RETURNING id",
      [id, this.owner],
    );
    if (!result.rowCount) throw new IntegrationError("LEASE_LOST", 409);
  }
  async runOne(
    handler: (operation: any) => Promise<unknown>,
    validate: (operation: any) => Promise<void>,
  ) {
    const row = await this.claim();
    if (!row) return false;
    const timer = setInterval(
      () => void this.heartbeat(row.id).catch(() => {}),
      15000,
    );
    timer.unref();
    let handlerStarted = false;
    try {
      await validate(row);
      await this.heartbeat(row.id);
      handlerStarted = true;
      const result = await handler(row);
      await this.finish(row, "complete", "OK", result);
    } catch (error) {
      const e =
        error instanceof IntegrationError
          ? error
          : new IntegrationError(
              (error as any)?.code ?? "UNEXPECTED",
              (error as any)?.status ?? 503,
              handlerStarted,
            );
      const state = e.ambiguous
        ? "unknown"
        : ["WAITING_FOR_SITE", "PROCESSING_PENDING"].includes(e.code)
          ? "queued"
          : ["RATE_LIMIT", "PROVIDER_UNAVAILABLE", "RETRY_LATER"].includes(
                e.code,
              ) && row.attempts < 3
            ? "queued"
            : row.attempts >= 3
              ? "deadletter"
              : "failed";
      await this.finish(
        row,
        state,
        e.code,
        {},
        e.retryAfter || Math.min(3600, 30 * 2 ** row.attempts),
      );
    } finally {
      clearInterval(timer);
    }
    return true;
  }
  private async finish(
    row: any,
    state: string,
    code: string,
    result: unknown = {},
    delay = 0,
  ) {
    await transaction(this.pool, async (db) => {
      const updated = await db.query(
        "UPDATE worker_outbox SET state=$3,last_code=$4,result=$5,available_at=now()+$6*interval '1 second',lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_owner=$2 AND state='sending' RETURNING id",
        [row.id, this.owner, state, code, result, delay],
      );
      if (!updated.rowCount) throw new IntegrationError("LEASE_LOST", 409);
      if (
        ["publication", "video-process"].includes(row.kind) &&
        ["unknown", "failed", "deadletter"].includes(state)
      )
        await db.query(
          "UPDATE integration_publications SET state=$2 WHERE id=$1 AND state NOT IN('published','manual-published','cancelled')",
          [row.subject_id, state === "unknown" ? "unknown" : "failed"],
        );
      if (
        ["changeset", "jobs-changeset"].includes(row.kind) &&
        row.payload?.publicationMode === "direct" &&
        ["unknown", "failed", "deadletter"].includes(state)
      )
        await db.query(
          "UPDATE integration_changesets SET state=$3,result=result||$4::jsonb,updated_at=now() WHERE community_id=$1 AND id=$2 AND state NOT IN('committed','deployed','deployment_failed','superseded')",
          [
            row.community_id,
            row.subject_id,
            state === "unknown"
              ? "uncertain"
              : code === "REMOTE_RECORD_CONFLICT"
                ? "conflict"
                : "blocked",
            { errorCode: code },
          ],
        );
      await db.query(
        "INSERT INTO integration_attempts(id,operation_id,attempt,code) VALUES($1,$2,$3,$4)",
        [randomUUID(), row.id, row.attempts, code],
      );
    });
  }
}
