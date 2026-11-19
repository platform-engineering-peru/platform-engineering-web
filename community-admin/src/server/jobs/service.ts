import type pg from "pg";
import { randomUUID } from "node:crypto";
import { transaction } from "../db";
import { capabilitiesFor, auditEvent } from "../context";
import { enqueue } from "../worker/outbox";
import {
  hashValue,
  deterministicId,
  IntegrationError,
} from "../integrations/security";
import type { Transport } from "../integrations/http";
import {
  collectSource,
  reconcileJobs,
  publicJobs,
  type JobSource,
} from "./engine";

const processStates = new WeakMap<
  pg.Pool,
  { running: boolean; lastTickAt: string | null }
>();
export function jobsWorkerState(pool: pg.Pool, running: boolean) {
  processStates.set(pool, {
    running,
    lastTickAt: processStates.get(pool)?.lastTickAt ?? null,
  });
}
export interface JobsOptions {
  pool: pg.Pool;
  jobsEnabled?: boolean;
  jobsTransport?: Transport;
  jobsNow?: () => Date;
  liveEnabled?: boolean;
}
export function sourceDTO(row: any) {
  const { _runtime, ...config } = row.config;
  return {
    ...row,
    config,
    retired: Boolean(config._retired),
    runtime: {
      nextDueAt: _runtime?.nextDueAt ?? null,
      lastAttemptAt: _runtime?.lastAttemptAt ?? null,
      lastSuccessfulFetchAt: _runtime?.lastSuccessfulFetchAt ?? null,
      lastRunId: _runtime?.lastRunId ?? null,
      lastStatus: _runtime?.lastStatus ?? null,
      lastErrorCode: _runtime?.lastErrorCode ?? null,
      lastOperation: row.last_operation ?? null,
    },
  };
}
export class JobsService {
  constructor(public options: JobsOptions) {}
  get pool() {
    return this.options.pool;
  }
  now() {
    return this.options.jobsNow?.() ?? new Date();
  }
  assertEnabled() {
    if (this.options.jobsEnabled === false)
      throw new IntegrationError("COLLECTION_DISABLED", 503);
  }
  async actor(db: pg.Pool | pg.PoolClient, id: string, community: string) {
    const u = (
      await db.query(
        "SELECT role,roles,active FROM users WHERE id=$1 AND community_id=$2",
        [id, community],
      )
    ).rows[0];
    const caps = u ? capabilitiesFor(u.roles?.length ? u.roles : [u.role]) : [];
    if (!u?.active || (!caps.includes("*") && !caps.includes("jobs:curate")))
      throw new IntegrationError("ACTOR_REVOKED", 403);
  }
  async save(
    community: string,
    actor: string,
    id: string,
    config: JobSource,
    version = 1,
  ) {
    return transaction(this.pool, async (db) => {
      const board = config.boardIdentifier.toLowerCase();
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `jobs-source-config:${community}:${id}`,
      ]);
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `jobs-board:${community}:${config.adapter}:${board}`,
      ]);
      const duplicate = (
        await db.query(
          "SELECT id FROM job_sources WHERE community_id=$1 AND id<>$2 AND config->>'adapter'=$3 AND lower(config->>'boardIdentifier')=$4 LIMIT 1",
          [community, id, config.adapter, board],
        )
      ).rows[0];
      if (duplicate)
        throw Object.assign(
          new IntegrationError("SOURCE_ALREADY_EXISTS", 409),
          { existingSourceId: duplicate.id },
        );
      const old = (
        await db.query(
          "SELECT * FROM job_sources WHERE community_id=$1 AND id=$2 FOR UPDATE",
          [community, id],
        )
      ).rows[0];
      if (old?.config?._retired)
        throw new IntegrationError("SOURCE_RETIRED", 409);
      if (old && old.version !== version)
        throw new IntegrationError("REVISION_CONFLICT", 409);
      if (
        old &&
        (old.config.adapter !== config.adapter ||
          old.config.boardIdentifier.toLowerCase() !== board)
      )
        throw new IntegrationError("SOURCE_IDENTITY_IMMUTABLE", 409);
      const runtime = {
        ...old?.config?._runtime,
        actorId: actor,
        nextDueAt:
          config.enabled && config.schedule?.enabled
            ? old?.config.schedule?.enabled
              ? (old.config._runtime?.nextDueAt ?? this.now().toISOString())
              : this.now().toISOString()
            : null,
      };
      const next = { ...config, _runtime: runtime };
      const value = await db.query(
        "INSERT INTO job_sources(id,community_id,config) VALUES($1,$2,$3) ON CONFLICT(community_id,id) DO UPDATE SET config=EXCLUDED.config,version=job_sources.version+1,updated_at=now() RETURNING *",
        [id, community, next],
      );
      await auditEvent(
        db,
        { id: actor, communityId: community },
        deterministicId({ community, source: id }),
        "job_source_updated",
        {
          sourceId: id,
          adapter: config.adapter,
          boardIdentifier: config.boardIdentifier,
          enabled: config.enabled,
          version: value.rows[0].version,
          schedule: config.schedule ?? null,
        },
      );
      return sourceDTO(value.rows[0]);
    });
  }
  async retire(
    community: string,
    actor: string,
    id: string,
    version: number,
    reason: string,
  ) {
    return transaction(this.pool, async (db) => {
      const locked = (
        await db.query(
          "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
          [`jobs-source:${community}:${id}`],
        )
      ).rows[0].locked;
      if (!locked) throw new IntegrationError("SOURCE_IN_PROGRESS", 409);
      await this.actor(db, actor, community);
      const row = (
        await db.query(
          "SELECT * FROM job_sources WHERE community_id=$1 AND id=$2 FOR UPDATE",
          [community, id],
        )
      ).rows[0];
      if (!row) throw new IntegrationError("NOT_FOUND", 404);
      if (row.version !== version)
        throw new IntegrationError("REVISION_CONFLICT", 409);
      const pending = (
        await db.query(
          "SELECT * FROM worker_outbox WHERE community_id=$1 AND kind='jobs' AND payload->>'sourceId'=$2 ORDER BY id FOR UPDATE",
          [community, id],
        )
      ).rows;
      if (pending.some((o) => ["sending", "unknown"].includes(o.state)))
        throw new IntegrationError("SOURCE_IN_PROGRESS", 409);
      await db.query(
        "UPDATE worker_outbox SET state='cancelled',updated_at=now() WHERE community_id=$1 AND kind='jobs' AND payload->>'sourceId'=$2 AND state='queued'",
        [community, id],
      );
      const config = {
        ...row.config,
        enabled: false,
        schedule: { ...row.config.schedule, enabled: false },
        _retired: { at: this.now().toISOString(), actorId: actor, reason },
        _runtime: { ...row.config._runtime, nextDueAt: null },
      };
      const updated = (
        await db.query(
          "UPDATE job_sources SET config=$3,version=version+1,updated_at=now() WHERE community_id=$1 AND id=$2 RETURNING *",
          [community, id, config],
        )
      ).rows[0];
      await auditEvent(
        db,
        { id: actor, communityId: community },
        deterministicId({ community, source: id }),
        "job_source_retired",
        { sourceId: id, reason, version: updated.version },
      );
      return { ...sourceDTO(updated), jobsRetained: true, runsRetained: true };
    });
  }
  async enqueueRun(community: string, actor: string, id: string, key: string) {
    this.assertEnabled();
    if (!key) throw new IntegrationError("IDEMPOTENCY_KEY_REQUIRED", 428);
    return transaction(this.pool, async (db) => {
      const source = (
        await db.query(
          "SELECT * FROM job_sources WHERE community_id=$1 AND id=$2 FOR UPDATE",
          [community, id],
        )
      ).rows[0];
      if (!source) throw new IntegrationError("NOT_FOUND", 404);
      if (!source.config.enabled)
        throw new IntegrationError("SOURCE_NOT_ENABLED", 409);
      const operation = await enqueue(db, {
        communityId: community,
        actorId: actor,
        kind: "jobs",
        subjectId: deterministicId({ community, id, key }),
        key,
        payload: { sourceId: id, sourceVersion: source.version },
      });
      return {
        ...operation,
        operationUrl: `/api/operations/${operation.id}`,
        runUrl: "/api/jobs/runs",
      };
    });
  }
  async expireKnown() {
    const now = this.now();
    const rows = (
      await this.pool.query(
        "SELECT id,community_id,payload,version FROM job_records WHERE payload->>'status' NOT IN('closed','excluded') AND payload->>'expiresAt' IS NOT NULL AND payload->>'expiresAt'<=$1 LIMIT 1000",
        [now.toISOString()],
      )
    ).rows;
    for (const row of rows) {
      const time = Date.parse(row.payload.expiresAt);
      if (!Number.isFinite(time) || time > now.getTime()) continue;
      await this.pool.query(
        "UPDATE job_records SET payload=jsonb_set(jsonb_set(payload,'{status}','\"closed\"'),'{closureReason}','\"expired\"'),version=version+1,updated_at=now() WHERE community_id=$1 AND id=$2 AND version=$3",
        [row.community_id, row.id, row.version],
      );
    }
  }
  async scheduleDue() {
    await this.expireKnown();
    const now = this.now();
    const process = processStates.get(this.pool);
    if (process) process.lastTickAt = now.toISOString();
    if (this.options.jobsEnabled === false) return 0;
    return transaction(this.pool, async (db) => {
      const rows = (
        await db.query(
          "SELECT * FROM job_sources WHERE config->>'enabled'='true' AND config->'schedule'->>'enabled'='true' AND COALESCE(config#>>'{_runtime,nextDueAt}','') <= $1 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100",
          [now.toISOString()],
        )
      ).rows;
      let count = 0;
      for (const source of rows) {
        const runtime = source.config._runtime ?? {};
        if (runtime.nextDueAt && Date.parse(runtime.nextDueAt) > now.getTime())
          continue;
        try {
          await this.actor(db, runtime.actorId, source.community_id);
        } catch {
          await db.query(
            "UPDATE job_sources SET config=jsonb_set(config,'{_runtime}', $3::jsonb) WHERE community_id=$1 AND id=$2",
            [
              source.community_id,
              source.id,
              {
                ...runtime,
                lastStatus: "actor-revoked",
                nextDueAt: new Date(now.getTime() + 3600000).toISOString(),
              },
            ],
          );
          continue;
        }
        const pending = (
          await db.query(
            "SELECT id FROM worker_outbox WHERE community_id=$1 AND kind='jobs' AND payload->>'sourceId'=$2 AND state IN('queued','sending') LIMIT 1",
            [source.community_id, source.id],
          )
        ).rowCount;
        if (!pending) {
          const slot = runtime.nextDueAt ?? now.toISOString();
          const key = `jobs-schedule:${hashValue({ community: source.community_id, id: source.id, version: source.version, slot })}`;
          await enqueue(db, {
            communityId: source.community_id,
            actorId: runtime.actorId,
            kind: "jobs",
            subjectId: deterministicId({ key }),
            key,
            semanticKey: key,
            payload: {
              sourceId: source.id,
              sourceVersion: source.version,
              scheduled: true,
            },
          });
          count++;
        }
        const hours = Math.max(
          1,
          Math.min(168, Number(source.config.schedule.intervalHours) || 12),
        );
        await db.query(
          "UPDATE job_sources SET config=jsonb_set(config,'{_runtime}', $3::jsonb) WHERE community_id=$1 AND id=$2",
          [
            source.community_id,
            source.id,
            {
              ...runtime,
              nextDueAt: new Date(
                now.getTime() + hours * 3600000,
              ).toISOString(),
            },
          ],
        );
      }
      return count;
    });
  }
  async run(
    community: string,
    id: string,
    actor?: string,
    expectedVersion?: number,
  ) {
    this.assertEnabled();
    const db = await this.pool.connect();
    const lock = `jobs-source:${community}:${id}`;
    let acquired = false;
    const attemptAt = this.now().toISOString();
    try {
      acquired = (
        await db.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [
          lock,
        ])
      ).rows[0].locked;
      if (!acquired) throw new IntegrationError("RETRY_LATER", 503, false, 5);
      const source = (
        await db.query(
          "SELECT * FROM job_sources WHERE community_id=$1 AND id=$2",
          [community, id],
        )
      ).rows[0];
      if (!source) throw new IntegrationError("NOT_FOUND", 404);
      if (!source.config.enabled)
        throw new IntegrationError("SOURCE_NOT_ENABLED", 409);
      if (expectedVersion !== undefined && source.version !== expectedVersion)
        throw new IntegrationError("SOURCE_CHANGED", 409);
      await this.actor(db, actor ?? source.config._runtime?.actorId, community);
      const started = this.now();
      const result = await collectSource(
        source.config,
        this.options.jobsTransport,
        started,
      );
      const now = this.now(),
        runId = randomUUID();
      result.runId = runId;
      result.finishedAt = now.toISOString();
      await db.query("BEGIN");
      try {
        const current = (
          await db.query(
            "SELECT * FROM job_sources WHERE community_id=$1 AND id=$2 FOR UPDATE",
            [community, id],
          )
        ).rows[0];
        if (!current?.config.enabled || current.version !== source.version)
          throw new IntegrationError("SOURCE_CHANGED", 409);
        await this.actor(
          db,
          actor ?? source.config._runtime?.actorId,
          community,
        );
        const previous = (
          await db.query(
            "SELECT payload FROM job_records WHERE community_id=$1 AND source_id=$2 ORDER BY id FOR UPDATE",
            [community, id],
          )
        ).rows.map((r) => r.payload);
        const reconciled = reconcileJobs(previous, result, now);
        const old = new Map(previous.map((j) => [j.id, j]));
        for (const job of reconciled.jobs)
          await db.query(
            "INSERT INTO job_records(id,community_id,source_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT(community_id,id) DO UPDATE SET payload=EXCLUDED.payload,version=job_records.version+1,updated_at=now() WHERE job_records.payload IS DISTINCT FROM EXCLUDED.payload",
            [job.id, community, id, job],
          );
        const summary = {
          runId,
          sourceId: id,
          status: reconciled.status,
          startedAt: started.toISOString(),
          finishedAt: now.toISOString(),
          recordsFetched: result.recordsFetched,
          relevantRecords: result.records.length,
          pagesFetched: result.pagesFetched,
          errorCode: result.errorCode ?? null,
          newRecords: reconciled.jobs.filter((j) => !old.has(j.id)).length,
          changedRecords: reconciled.jobs.filter(
            (j) => old.has(j.id) && hashValue(old.get(j.id)) !== hashValue(j),
          ).length,
          closedRecords: reconciled.jobs.filter(
            (j) => j.status === "closed" && old.get(j.id)?.status !== "closed",
          ).length,
          publicCount: publicJobs(reconciled.jobs).length,
          evidence: {
            adapter: source.config.adapter,
            boardIdentifier: source.config.boardIdentifier,
            sourceVersion: source.version,
            careersUrl: source.config.careersUrl ?? null,
            complete:
              result.status === "complete" &&
              result.completeSourceSnapshot !== false,
            scope: result.scope ?? "board",
            observedCount: result.observedIds?.length ?? result.recordsFetched,
            hash: hashValue(
              result.records.map((j: any) => ({
                id: j.id,
                title: j.title,
                applyUrl: j.applyUrl,
                expiresAt: j.expiresAt,
              })),
            ),
          },
        };
        await db.query(
          "INSERT INTO job_runs(id,community_id,source_id,status,summary) VALUES($1,$2,$3,$4,$5)",
          [runId, community, id, reconciled.status, summary],
        );
        const runtime = {
          ...current.config._runtime,
          lastAttemptAt: started.toISOString(),
          lastRunId: runId,
          lastStatus: reconciled.status,
          lastErrorCode: result.errorCode ?? null,
          ...(reconciled.status === "complete"
            ? { lastSuccessfulFetchAt: now.toISOString() }
            : {}),
        };
        await db.query(
          "UPDATE job_sources SET config=jsonb_set(config,'{_runtime}',$3::jsonb) WHERE community_id=$1 AND id=$2",
          [community, id, runtime],
        );
        await db.query("COMMIT");
        return summary;
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      }
    } catch (error) {
      if (acquired) {
        const code =
          error instanceof IntegrationError ? error.code : "UNEXPECTED";
        const attemptId = randomUUID();
        const source = (
          await db.query(
            "SELECT id FROM job_sources WHERE community_id=$1 AND id=$2",
            [community, id],
          )
        ).rows[0];
        if (source) {
          const summary = {
            runId: attemptId,
            sourceId: id,
            status: "rejected",
            startedAt: attemptAt,
            finishedAt: this.now().toISOString(),
            errorCode: code,
            recordsFetched: 0,
            relevantRecords: 0,
            pagesFetched: 0,
            evidence: {
              sourceVersion: expectedVersion ?? null,
              complete: false,
            },
          };
          await db.query(
            "INSERT INTO job_runs(id,community_id,source_id,status,summary) VALUES($1,$2,$3,'rejected',$4)",
            [attemptId, community, id, summary],
          );
          await db.query(
            "UPDATE job_sources SET config=jsonb_set(config,'{_runtime}',COALESCE(config->'_runtime','{}'::jsonb)||$3::jsonb) WHERE community_id=$1 AND id=$2",
            [
              community,
              id,
              {
                lastAttemptAt: attemptAt,
                lastRunId: attemptId,
                lastStatus: "rejected",
                lastErrorCode: code,
              },
            ],
          );
        }
      }
      throw error;
    } finally {
      try {
        if (acquired)
          await db.query("SELECT pg_advisory_unlock(hashtext($1))", [lock]);
      } finally {
        db.release();
      }
    }
  }
  async listSources(community: string, limit = 100, offset = 0) {
    return (
      await this.pool.query(
        `SELECT s.*, (SELECT jsonb_build_object('id',o.id,'state',o.state,'lastCode',o.last_code,'updatedAt',o.updated_at,'outcome',o.result->>'status') FROM worker_outbox o WHERE o.community_id=s.community_id AND o.kind='jobs' AND o.payload->>'sourceId'=s.id ORDER BY o.created_at DESC LIMIT 1) AS last_operation FROM job_sources s WHERE s.community_id=$1 ORDER BY s.id LIMIT $2 OFFSET $3`,
        [community, Math.min(1000, Math.max(1, limit)), Math.max(0, offset)],
      )
    ).rows.map(sourceDTO);
  }
  async status(community: string) {
    const sources = await this.listSources(community, 1000);
    const counts = (
      await this.pool.query(
        "SELECT state,count(*)::int AS count FROM worker_outbox WHERE community_id=$1 AND kind='jobs' GROUP BY state",
        [community],
      )
    ).rows;
    const process = processStates.get(this.pool);
    return {
      collectionEnabled: this.options.jobsEnabled !== false,
      publishingEnabled: this.options.liveEnabled === true,
      execution: "local-process",
      processRunning: process?.running === true,
      lastTickAt: process?.lastTickAt ?? null,
      sources,
      queued: counts.find((r) => r.state === "queued")?.count ?? 0,
      running: counts.find((r) => r.state === "sending")?.count ?? 0,
      lastSuccessfulFetchAt:
        sources
          .map((s) => s.runtime.lastSuccessfulFetchAt)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null,
      failed: counts
        .filter((r) => ["failed", "deadletter", "unknown"].includes(r.state))
        .reduce((sum, r) => sum + r.count, 0),
      scheduleBasis: "enqueue-interval",
      registry: "local-admin-db",
      actionsRegistryLinked: false,
      note: "La recolección programada funciona mientras esta aplicación local esté abierta. El registro de Actions es independiente.",
    };
  }
}
