import { auditEvent } from "../context";
import {
  WebsitePublisher,
  type WebsitePublicationOptions,
} from "../website-publication";
import { JobsService } from "../jobs/service";
import {
  JobsPublisher,
  jobPublicationRevision,
  type JobsPublicationOptions,
} from "../jobs/publication";
import type { Transport } from "./http";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { transaction } from "../db";
import { verifySchedule } from "./schedule";
import { mediaBytes } from "../uploads";
import { verifySeedMedia } from "../media";
import { decryptPrivate } from "../private-data";
import { capabilitiesFor } from "../context";
import {
  encryptSecret,
  decryptSecret,
  hashValue,
  deterministicId,
  IntegrationError,
  verifyWebhook,
} from "./security";
import { GitHub, type ExportFile } from "./github";
import {
  LinkedIn,
  YouTube,
  manualPackage,
  type Connector,
  type VideoState,
} from "./social";
import { enqueue, OutboxWorker } from "../worker/outbox";
import {
  collectSource,
  reconcileJobs,
  publicJobs,
  type JobSource,
} from "../jobs/engine";
export interface IntegrationOptions {
  pool: pg.Pool;
  liveEnabled?: boolean;
  jobsEnabled?: boolean;
  jobsTransport?: Transport;
  jobsNow?: () => Date;
  jobsPublication?: JobsPublicationOptions;
  websitePublication?: WebsitePublicationOptions;
  github?: GitHub;
  secretKey?: Buffer;
  webhookSecret?: string;
  readAsset?: (
    id: string,
    offset: number,
    length: number,
    communityId?: string,
  ) => Promise<Buffer>;
  exportRecords?: (
    db: pg.PoolClient,
    communityId: string,
    ids: string[],
  ) => Promise<{ files: ExportFile[]; revisionHashes: Record<string, string> }>;
  linkedin?: LinkedIn;
  youtube?: YouTube;
}
export class IntegrationService {
  pool: pg.Pool;
  worker: OutboxWorker;
  jobs: JobsService;
  jobsPublisher?: JobsPublisher;
  websitePublisher?: WebsitePublisher;
  constructor(public options: IntegrationOptions) {
    this.pool = options.pool;
    this.worker = new OutboxWorker(this.pool);
    this.jobs = new JobsService(options);
    if (options.websitePublication && options.exportRecords)
      this.websitePublisher = new WebsitePublisher(
        this.pool,
        options.websitePublication,
        options.exportRecords,
      );
    if (options.jobsPublication)
      this.jobsPublisher = new JobsPublisher(
        this.pool,
        options.jobsPublication,
      );
  }
  async actor(id: string, communityId: string, capability: string) {
    const result = await this.pool.query(
      "SELECT * FROM users WHERE id=$1 AND community_id=$2 AND active=true",
      [id, communityId],
    );
    const user = result.rows[0];
    const caps = user
      ? capabilitiesFor(user.roles?.length ? user.roles : [user.role])
      : [];
    if (!user || (!caps.includes("*") && !caps.includes(capability)))
      throw new IntegrationError("ACTOR_REVOKED", 403);
    return user;
  }
  async connect(
    communityId: string,
    provider: string,
    destination: string,
    scopes: string[],
    secret: any,
    config: any,
  ) {
    if (!this.options.secretKey)
      throw new IntegrationError("CONNECTOR_KEY_REQUIRED", 503);
    const encrypted = encryptSecret(secret, this.options.secretKey);
    const result = await this.pool.query(
      `INSERT INTO integration_accounts(id,community_id,provider,destination,scopes,encrypted_secret,config) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(community_id,provider,destination) DO UPDATE SET scopes=EXCLUDED.scopes,encrypted_secret=EXCLUDED.encrypted_secret,config=EXCLUDED.config,health='connected',version=integration_accounts.version+1 RETURNING id,provider,destination,scopes,health,version`,
      [
        randomUUID(),
        communityId,
        provider,
        destination,
        JSON.stringify(scopes),
        encrypted,
        config,
      ],
    );
    return result.rows[0];
  }
  async connector(
    communityId: string,
    provider: string,
    destination: string,
  ): Promise<Connector> {
    if (!this.options.liveEnabled)
      throw new IntegrationError("INTEGRATION_DISABLED", 503);
    if (!this.options.secretKey)
      throw new IntegrationError("CONNECTOR_KEY_REQUIRED", 503);
    const account = (
      await this.pool.query(
        "SELECT * FROM integration_accounts WHERE community_id=$1 AND provider=$2 AND destination=$3",
        [communityId, provider, destination],
      )
    ).rows[0];
    if (!account || account.health !== "connected")
      throw new IntegrationError("NEEDS_RECONNECTION", 503);
    const connector = {
      ...account,
      secret: decryptSecret(account.encrypted_secret, this.options.secretKey),
    } as Connector;
    if (
      connector.secret.expiresAt &&
      Date.parse(connector.secret.expiresAt) < Date.now() + 60000 &&
      connector.secret.refreshToken
    ) {
      try {
        const secret =
          provider === "youtube"
            ? await (this.options.youtube ?? new YouTube()).refresh(connector)
            : await (this.options.linkedin ?? new LinkedIn()).refresh(
                connector,
              );
        await this.pool.query(
          "UPDATE integration_accounts SET encrypted_secret=$2,updated_at=now() WHERE id=$1",
          [account.id, encryptSecret(secret, this.options.secretKey)],
        );
        connector.secret = secret;
      } catch {
        await this.pool.query(
          "UPDATE integration_accounts SET health='needs-reconnection' WHERE id=$1",
          [account.id],
        );
        throw new IntegrationError("NEEDS_RECONNECTION", 503);
      }
    }
    return connector;
  }
  async publication(
    communityId: string,
    id: string,
    db: pg.Pool | pg.PoolClient = this.pool,
  ) {
    const row = (
      await db.query(
        "SELECT * FROM integration_publications WHERE community_id=$1 AND id=$2",
        [communityId, id],
      )
    ).rows[0];
    if (!row) throw new IntegrationError("NOT_FOUND", 404);
    return row;
  }
  async schedule(
    communityId: string,
    actorId: string,
    id: string,
    hash: string,
    date: Date,
    timezone: string,
    localTime: string,
    key: string,
    dependencyId?: string,
  ) {
    verifySchedule(date, timezone, localTime);
    if (!key || key.length > 200)
      throw new IntegrationError("IDEMPOTENCY_KEY_REQUIRED", 428);
    if (!Number.isFinite(date.getTime()))
      throw new IntegrationError("INVALID_SCHEDULE");
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      throw new IntegrationError("INVALID_TIMEZONE");
    }
    return transaction(this.pool, async (db) => {
      await db.query(
        "SELECT id FROM integration_publications WHERE id=$1 AND community_id=$2 FOR UPDATE",
        [id, communityId],
      );
      const row = await this.publication(communityId, id, db);
      if (
        row.revision_hash !== hash ||
        row.approved_hash !== hash ||
        !row.reviewer_id
      )
        throw new IntegrationError("APPROVAL_REQUIRED", 409);
      if (
        !row.schedule_at ||
        new Date(row.schedule_at).toISOString() !== date.toISOString() ||
        row.timezone !== timezone ||
        (row.local_time ?? "") !== localTime ||
        (row.dependency_id ?? null) !== (dependencyId ?? null)
      )
        throw new IntegrationError("SCHEDULE_APPROVAL_REQUIRED", 409);
      const semanticKey = `publication:${row.channel}:${row.destination}:${hash}:${date.toISOString()}`;
      const prior = (
        await db.query(
          "SELECT * FROM worker_outbox WHERE community_id=$1 AND (intent_key=$2 OR semantic_key=$3)",
          [communityId, key, semanticKey],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.payload.revisionHash !== hash ||
          prior.payload.schedule !== date.toISOString() ||
          prior.payload.destination !== row.destination
        )
          throw new IntegrationError("IDEMPOTENCY_CONFLICT", 409);
        return prior;
      }
      if (
        ["sending", "published", "manual-published", "cancelled"].includes(
          row.state,
        ) ||
        (row.state === "unknown" &&
          !(row.channel === "youtube" && row.upload_state.sessionUrl))
      )
        throw new IntegrationError("PUBLICATION_STATE", 409);
      const operation = await enqueue(db, {
        communityId,
        actorId,
        kind: "publication",
        subjectId: id,
        key,
        semanticKey,
        payload: {
          revisionHash: hash,
          destination: row.destination,
          schedule: date.toISOString(),
          timezone,
          dependencyId: dependencyId ?? null,
        },
        availableAt: date,
      });
      await db.query(
        "UPDATE integration_publications SET state='scheduled',schedule_at=$3,timezone=$4,local_time=$5,dependency_id=$6,updated_at=now() WHERE community_id=$1 AND id=$2",
        [communityId, id, date, timezone, localTime, dependencyId ?? null],
      );
      return operation;
    });
  }
  async cancel(
    communityId: string,
    id: string,
    version: number,
    revisionHash: string,
    actorId: string,
    reason: string,
  ) {
    return transaction(this.pool, async (db) => {
      await db.query(
        "SELECT id FROM integration_publications WHERE id=$1 AND community_id=$2 FOR UPDATE",
        [id, communityId],
      );
      const row = await this.publication(communityId, id, db);
      if (row.version !== version || row.revision_hash !== revisionHash)
        throw new IntegrationError("REVISION_CONFLICT", 409);
      if (
        [
          "sending",
          "published",
          "unknown",
          "manual-published",
          "processing",
        ].includes(row.state)
      )
        throw new IntegrationError("ALREADY_SENDING", 409);
      const sending = await db.query(
        "SELECT id,state FROM worker_outbox WHERE subject_id=$1 AND community_id=$2 ORDER BY id FOR UPDATE",
        [id, communityId],
      );
      if (sending.rows.some((r) => ["sending", "unknown"].includes(r.state)))
        throw new IntegrationError("ALREADY_SENDING", 409);
      await db.query(
        "UPDATE worker_outbox SET state='cancelled' WHERE community_id=$1 AND subject_id=$2 AND state='queued'",
        [communityId, id],
      );
      await db.query(
        "UPDATE integration_publications SET state='cancelled',version=version+1,updated_at=now() WHERE community_id=$1 AND id=$2",
        [communityId, id],
      );
      await auditEvent(
        db,
        { id: actorId, communityId },
        id,
        "publication_cancelled",
        { reason, version: row.version, revisionHash },
      );
      return {
        id,
        state: "cancelled",
        version: row.version + 1,
        remoteUnchanged: true,
      };
    });
  }
  private async enqueueChangeset(
    db: pg.PoolClient,
    communityId: string,
    actorId: string,
    key: string,
    kind: "changeset" | "jobs-changeset",
    files: ExportFile[],
    payload: {
      recordIds?: string[];
      jobIds?: string[];
      revisionHashes: Record<string, string>;
    },
  ) {
    if (!key || key.length > 200)
      throw new IntegrationError("IDEMPOTENCY_KEY_REQUIRED", 428);
    const target = this.options.github
      ? `${this.options.github.config.owner}/${this.options.github.config.repo}`.toLowerCase()
      : (process.env.WEBSITE_REPO?.toLowerCase() ?? "unconfigured");
    const boundPayload = { ...payload, targetRepo: target };
    const identity = { communityId, kind, ...boundPayload };
    const requestHash = hashValue(identity);
    // Bind every client key, including aliases of an existing semantic intent.
    // Different keys race safely on the outbox's unique semantic_key constraint.
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      communityId + ":" + key,
    ]);
    const previous = (
      await db.query(
        "SELECT request_hash,response FROM integration_requests WHERE community_id=$1 AND key=$2",
        [communityId, key],
      )
    ).rows[0];
    if (previous) {
      if (previous.request_hash !== requestHash)
        throw new IntegrationError("IDEMPOTENCY_CONFLICT", 409);
      return (
        (
          await db.query(
            "SELECT * FROM worker_outbox WHERE community_id=$1 AND id=$2",
            [communityId, previous.response.id],
          )
        ).rows[0] ?? previous.response
      );
    }
    const id = deterministicId(identity);
    const operation = await enqueue(db, {
      communityId,
      actorId,
      kind,
      subjectId: id,
      key,
      payload: boundPayload,
      semanticKey: `${kind}:${requestHash}`,
    });
    await db.query(
      "INSERT INTO integration_changesets(id,community_id,actor_id,revision_hash,files,result) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING",
      [
        id,
        communityId,
        actorId,
        hashValue(payload.revisionHashes),
        JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path))),
        boundPayload,
      ],
    );
    await db.query(
      "INSERT INTO integration_requests(community_id,key,request_hash,response) VALUES($1,$2,$3,$4)",
      [communityId, key, requestHash, JSON.stringify(operation)],
    );
    return operation;
  }
  async createChangeset(
    communityId: string,
    actorId: string,
    ids: string[],
    key: string,
    expectedRevisions?: unknown,
  ) {
    if (this.websitePublisher)
      return this.websitePublisher.create(
        communityId,
        actorId,
        ids,
        key,
        expectedRevisions,
      );
    if (!this.options.exportRecords)
      throw new IntegrationError("EXPORT_NOT_CONFIGURED", 503);
    const recordIds = [...new Set(ids)].sort();
    return transaction(this.pool, async (db) => {
      const exported = await this.options.exportRecords!(
        db,
        communityId,
        recordIds,
      );
      return this.enqueueChangeset(
        db,
        communityId,
        actorId,
        key,
        "changeset",
        exported.files,
        { recordIds, revisionHashes: exported.revisionHashes },
      );
    });
  }
  async createJobsChangeset(
    communityId: string,
    actorId: string,
    ids: string[],
    key: string,
    expectedVersions?: unknown,
  ) {
    if (this.jobsPublisher)
      return this.jobsPublisher.create(
        communityId,
        actorId,
        ids,
        key,
        expectedVersions,
      );
    if (!key) throw new IntegrationError("IDEMPOTENCY_KEY_REQUIRED", 428);
    return transaction(this.pool, async (db) => {
      const rows = (
        await db.query(
          "SELECT * FROM job_records WHERE community_id=$1 AND id=ANY($2::text[]) ORDER BY id",
          [communityId, ids],
        )
      ).rows;
      if (rows.length !== new Set(ids).size)
        throw new IntegrationError("NOT_FOUND", 404);
      const records = publicJobs(rows.map((r) => r.payload));
      if (records.length !== rows.length)
        throw new IntegrationError("JOB_APPROVAL_REQUIRED", 409);
      const hashes = Object.fromEntries(
          rows.map((r) => [r.id, hashValue(r.payload)]),
        ),
        files = records.map((record) => ({
          path: `content/jobs/${record.id}.json`,
          content: JSON.stringify(record, null, 2) + "\n",
          baseEntityHash:
            rows.find((r) => r.id === record.id)?.payload.baseEntityHash ??
            null,
        })),
        jobIds = [...new Set(ids)].sort();
      return this.enqueueChangeset(
        db,
        communityId,
        actorId,
        key,
        "jobs-changeset",
        files,
        { jobIds, revisionHashes: hashes },
      );
    });
  }

  async validateOperation(operation: any) {
    if (operation.kind === "reconcile") {
      const row = (
        await this.pool.query(
          "SELECT id FROM integration_changesets WHERE id=$1 AND community_id=$2 AND pr_number IS NOT NULL",
          [operation.subject_id, operation.community_id],
        )
      ).rows[0];
      if (!row) throw new IntegrationError("NOT_FOUND", 404);
      return;
    }
    await this.actor(
      operation.actor_id,
      operation.community_id,
      ["publication", "video-process"].includes(operation.kind)
        ? "publishing:write"
        : operation.kind === "jobs"
          ? "jobs:curate"
          : "content:publish",
    );
    if (["publication", "video-process"].includes(operation.kind)) {
      const row = await this.publication(
        operation.community_id,
        operation.subject_id,
      );
      if (row.state === "cancelled")
        throw new IntegrationError("CANCELLED", 409);
      if (
        !(
          operation.kind === "video-process"
            ? ["uploaded-private", "processing", "published"]
            : ["scheduled", "waiting_for_site", "sending"]
        ).includes(row.state)
      )
        throw new IntegrationError("PUBLICATION_STATE", 409);
      if (
        new Date(row.schedule_at).toISOString() !==
          operation.payload.schedule ||
        (row.dependency_id ?? null) !== (operation.payload.dependencyId ?? null)
      )
        throw new IntegrationError("SCHEDULE_CHANGED", 409);
      if (row.payload.sessionId) {
        const session = (
          await this.pool.query(
            "SELECT * FROM records WHERE id=$1 AND community_id=$2 AND type='sessions' AND state='active'",
            [row.payload.sessionId, operation.community_id],
          )
        ).rows[0];
        if (
          !session ||
          decryptPrivate(session.id, session.payload).recordingConsent !== true
        )
          throw new IntegrationError("RECORDING_CONSENT_REVOKED", 409);
      }
      for (const id of [
        ...(row.payload.media ?? []),
        ...(row.payload.thumbnailAssetId ? [row.payload.thumbnailAssetId] : []),
      ]) {
        const media = await mediaBytes(
          this.pool,
          operation.community_id,
          id,
          await verifySeedMedia(),
        );
        if (row.payload.mediaHashes?.[id] !== media.sha256)
          throw new IntegrationError("MEDIA_APPROVAL_CHANGED", 409);
      }
      if (row.channel === "youtube" && row.payload.assetId) {
        const asset = (
          await this.pool.query(
            "SELECT * FROM integration_video_assets WHERE id=$1 AND community_id=$2 AND state='verified'",
            [row.payload.assetId, operation.community_id],
          )
        ).rows[0];
        if (
          !asset ||
          asset.sha256 !== row.payload.sha256 ||
          Number(asset.bytes) !== row.payload.bytes ||
          asset.mime !== row.payload.mime
        )
          throw new IntegrationError("VIDEO_APPROVAL_CHANGED", 409);
      }
      if (
        row.revision_hash !== operation.payload.revisionHash ||
        row.approved_hash !== row.revision_hash ||
        row.destination !== operation.payload.destination
      )
        throw new IntegrationError("APPROVAL_REVOKED", 409);
      await this.actor(
        row.reviewer_id,
        operation.community_id,
        "content:review",
      );
      if (row.reviewer_id === row.author_id)
        throw new IntegrationError("SELF_APPROVAL", 403);
      if (
        operation.kind === "publication" &&
        !row.upload_state.sessionUrl &&
        row.state === "scheduled" &&
        Date.now() - new Date(row.schedule_at).getTime() > 30 * 60000
      )
        throw new IntegrationError("MISSED_SCHEDULE", 409);
      if (row.dependency_id) {
        const dependency = (
          await this.pool.query(
            "SELECT state FROM integration_changesets WHERE id=$1 AND community_id=$2",
            [row.dependency_id, operation.community_id],
          )
        ).rows[0];
        if (dependency?.state !== "deployed") {
          await this.pool.query(
            "UPDATE integration_publications SET state='waiting_for_site' WHERE id=$1",
            [row.id],
          );
          throw new IntegrationError("WAITING_FOR_SITE", 503, false, 60);
        }
      }
    }
    if (
      ["changeset", "jobs-changeset"].includes(operation.kind) &&
      operation.payload?.targetRepo
    ) {
      const target =
        operation.payload.bridge === "website-cli"
          ? this.options.websitePublication?.config.repository
          : operation.payload.bridge === "jobs-cli"
            ? this.options.jobsPublication?.config.repository
            : this.options.github
              ? `${this.options.github.config.owner}/${this.options.github.config.repo}`.toLowerCase()
              : (process.env.WEBSITE_REPO?.toLowerCase() ?? "unconfigured");
      if (operation.payload.targetRepo !== target)
        throw new IntegrationError("TARGET_REPOSITORY_CHANGED", 409);
    }
    if (operation.kind === "jobs-changeset") {
      const row = (
        await this.pool.query(
          "SELECT result FROM integration_changesets WHERE id=$1 AND community_id=$2",
          [operation.subject_id, operation.community_id],
        )
      ).rows[0];
      if (!row) throw new IntegrationError("NOT_FOUND", 404);
      const jobs = (
        await this.pool.query(
          "SELECT * FROM job_records WHERE community_id=$1 AND id=ANY($2::text[])",
          [operation.community_id, row.result.jobIds],
        )
      ).rows;
      if (
        jobs.length !== row.result.jobIds.length ||
        publicJobs(jobs.map((r) => r.payload)).length !== jobs.length ||
        jobs.some(
          (r) =>
            (row.result.bridge === "jobs-cli"
              ? jobPublicationRevision(r.payload)
              : hashValue(r.payload)) !== row.result.revisionHashes[r.id],
        )
      )
        throw new IntegrationError("APPROVAL_REVOKED", 409);
    }
    if (operation.kind === "changeset") {
      const row = (
        await this.pool.query(
          "SELECT result FROM integration_changesets WHERE id=$1 AND community_id=$2",
          [operation.subject_id, operation.community_id],
        )
      ).rows[0];
      if (!row || !this.options.exportRecords)
        throw new IntegrationError("NOT_FOUND", 404);
      await transaction(this.pool, async (db) => {
        const exported = await this.options.exportRecords!(
          db,
          operation.community_id,
          row.result.recordIds,
        );
        if (
          hashValue(exported.revisionHashes) !==
          hashValue(row.result.revisionHashes)
        )
          throw new IntegrationError("APPROVAL_REVOKED", 409);
      });
    }
  }
  async handleOperation(operation: any) {
    if (operation.kind === "video-process") {
      const row = await this.publication(
          operation.community_id,
          operation.subject_id,
        ),
        account = await this.connector(
          row.community_id,
          "youtube",
          row.destination,
        ),
        youtube = this.options.youtube ?? new YouTube();
      const status = await youtube.read(account, row.remote_id);
      if (status.state === "failed")
        throw new IntegrationError("VIDEO_PROCESSING_FAILED");
      if (status.state === "processing") {
        await this.pool.query(
          "UPDATE integration_publications SET state='processing' WHERE id=$1",
          [row.id],
        );
        if (operation.attempts >= 60)
          throw new IntegrationError("VIDEO_PROCESSING_TIMEOUT");
        throw new IntegrationError("PROCESSING_PENDING", 503, false, 30);
      }
      if (row.payload.thumbnailAssetId && !row.upload_state.thumbnailApplied) {
        const asset = await mediaBytes(
          this.pool,
          row.community_id,
          row.payload.thumbnailAssetId,
          await verifySeedMedia(),
        );
        const sharp = (await import("sharp")).default,
          bytes = await sharp(asset.bytes, { limitInputPixels: 40_000_000 })
            .jpeg({ quality: 90 })
            .toBuffer();
        await youtube.thumbnail(account, row.remote_id, bytes, "image/jpeg");
        row.upload_state = { ...row.upload_state, thumbnailApplied: true };
        await this.pool.query(
          "UPDATE integration_publications SET upload_state=$2 WHERE id=$1",
          [row.id, row.upload_state],
        );
      }
      if (row.payload.playlistId && !row.upload_state.playlistApplied) {
        await youtube.playlist(account, row.remote_id, row.payload.playlistId);
        row.upload_state = { ...row.upload_state, playlistApplied: true };
        await this.pool.query(
          "UPDATE integration_publications SET upload_state=$2 WHERE id=$1",
          [row.id, row.upload_state],
        );
      }
      if (
        row.payload.desiredVisibility &&
        row.payload.desiredVisibility !== "private" &&
        status.state !== "published"
      ) {
        if (Date.now() - new Date(row.schedule_at).getTime() > 30 * 60000)
          throw new IntegrationError("MISSED_SCHEDULE", 409);
        await youtube.visibility(
          account,
          row.remote_id,
          row.payload.desiredVisibility,
        );
      }
      return this.reconcilePublication(row.community_id, row.id);
    }
    if (operation.kind === "reconcile")
      return this.reconcileChangeset(
        operation.community_id,
        operation.subject_id,
      );
    if (operation.kind === "jobs")
      return this.jobs.run(
        operation.community_id,
        operation.payload.sourceId,
        operation.actor_id,
        operation.payload.sourceVersion,
      );
    if (
      operation.kind === "changeset" &&
      operation.payload?.bridge === "website-cli"
    ) {
      if (!this.websitePublisher)
        throw new IntegrationError("UNCONFIGURED", 503);
      try {
        return await this.websitePublisher.send(
          operation.community_id,
          operation.actor_id,
          operation.subject_id,
        );
      } catch (e: any) {
        throw e instanceof IntegrationError
          ? e
          : new IntegrationError(
              e.code ?? "REMOTE_UNAVAILABLE",
              e.status ?? 503,
              e.code === "PUBLICATION_UNCERTAIN",
            );
      }
    }
    if (
      operation.kind === "jobs-changeset" &&
      operation.payload?.bridge === "jobs-cli"
    ) {
      if (!this.jobsPublisher)
        throw new IntegrationError("JOBS_PUBLICATION_UNCONFIGURED", 503);
      try {
        return await this.jobsPublisher.publish(
          operation.community_id,
          operation.actor_id,
          operation.subject_id,
        );
      } catch (e: any) {
        throw e instanceof IntegrationError
          ? e
          : new IntegrationError(
              e.code ?? "REMOTE_UNAVAILABLE",
              e.status ?? 503,
              e.code === "PUBLICATION_UNCERTAIN",
            );
      }
    }
    if (["changeset", "jobs-changeset"].includes(operation.kind)) {
      if (!this.options.liveEnabled || !this.options.github)
        throw new IntegrationError("INTEGRATION_DISABLED", 503);
      const row = (
        await this.pool.query(
          "SELECT * FROM integration_changesets WHERE id=$1",
          [operation.subject_id],
        )
      ).rows[0];
      const pr = await this.options.github.createChangeset(row.id, row.files);
      await this.pool.query(
        "UPDATE integration_changesets SET state='pr_open',pr_number=$2,head_sha=$3 WHERE id=$1",
        [row.id, pr.number, pr.head.sha],
      );
      return { prNumber: pr.number, headSha: pr.head.sha };
    }
    if (operation.kind !== "publication")
      throw new IntegrationError("UNKNOWN_OPERATION");
    const row = await this.publication(
      operation.community_id,
      operation.subject_id,
    );
    if (row.channel === "manual") {
      const prepared = await this.pool.query(
        "UPDATE integration_publications SET state='manual-export' WHERE id=$1 AND community_id=$2 AND revision_hash=$3 AND approved_hash=$3 AND state IN('scheduled','waiting_for_site','manual-export') RETURNING id",
        [row.id, row.community_id, operation.payload.revisionHash],
      );
      if (!prepared.rowCount)
        throw new IntegrationError("APPROVAL_REVOKED", 409);
      return manualPackage(row.payload);
    }
    const connector = await this.connector(
      row.community_id,
      row.channel,
      row.destination,
    );
    const locked = await this.pool.query(
      "UPDATE integration_publications SET state='sending' WHERE id=$1 AND revision_hash=$2 AND approved_hash=$2 AND state IN('scheduled','waiting_for_site','sending') RETURNING id",
      [row.id, operation.payload.revisionHash],
    );
    if (!locked.rowCount) throw new IntegrationError("APPROVAL_REVOKED", 409);
    try {
      if (row.channel === "linkedin") {
        const linkedin = this.options.linkedin ?? new LinkedIn();
        let payload = row.payload;
        if (payload.media?.length) {
          if (payload.media.length !== 1)
            throw new IntegrationError("ONE_LINKEDIN_IMAGE_REQUIRED");
          let imageUrn = row.upload_state.linkedinImageUrn;
          if (!imageUrn) {
            const asset = await mediaBytes(
              this.pool,
              row.community_id,
              payload.media[0],
              await verifySeedMedia(),
            );
            imageUrn = await linkedin.uploadImage(
              connector,
              asset.bytes,
              asset.mime,
            );
            await this.pool.query(
              "UPDATE integration_publications SET upload_state=$2 WHERE id=$1",
              [row.id, { linkedinImageUrn: imageUrn }],
            );
          }
          await linkedin.imageReady(connector, imageUrn);
          payload = { ...payload, imageUrn };
        }
        const result = await linkedin.publish(connector, payload);
        await this.persistRemote(row.id, result);
        return result;
      }
      const youtube = this.options.youtube ?? new YouTube();
      if (!this.options.readAsset)
        throw new IntegrationError("VIDEO_STORAGE_NOT_CONFIGURED", 503);
      let state = row.upload_state as VideoState;
      if (!state.total) {
        state = { total: row.payload.bytes, mime: row.payload.mime, offset: 0 };
        if (!Number.isSafeInteger(state.total))
          throw new IntegrationError("INVALID_VIDEO_SIZE");
      }
      if (!state.sessionUrl) {
        state = {
          ...(await youtube.start(connector, row.payload, state)),
          metadataHash: row.revision_hash,
        };
        await this.persistUpload(row.id, state);
      } else if (!state.videoId) {
        state = await youtube.resume(connector, state);
        await this.persistUpload(row.id, state);
      }
      while (!state.videoId && (state.offset ?? 0) < state.total) {
        await this.worker.heartbeat(operation.id);
        await this.validateOperation(operation);
        const bytes = await this.options.readAsset(
          row.payload.assetId,
          state.offset ?? 0,
          Math.min(8 * 1024 * 1024, state.total - (state.offset ?? 0)),
          row.community_id,
        );
        state = await youtube.chunk(connector, state, bytes);
        await this.persistUpload(row.id, state);
      }
      if (!state.videoId)
        throw new IntegrationError("UNKNOWN_REMOTE_RESULT", 503, true);
      if (state.metadataHash !== row.revision_hash) {
        await youtube.metadata(connector, state.videoId, row.payload);
        state.metadataHash = row.revision_hash;
        await this.persistUpload(row.id, state);
      }
      await this.persistRemote(row.id, {
        id: state.videoId,
        state: "uploaded-private",
        url: `https://www.youtube.com/watch?v=${state.videoId}`,
      });
      await enqueue(this.pool, {
        communityId: row.community_id,
        actorId: operation.actor_id,
        kind: "video-process",
        subjectId: row.id,
        key: `video-process:${row.id}:${row.revision_hash}`,
        payload: operation.payload,
        availableAt: new Date(Date.now() + 30000),
      });
      return { id: state.videoId, state: "uploaded-private" };
    } catch (e) {
      const error =
        e instanceof IntegrationError
          ? e
          : new IntegrationError("UNKNOWN_REMOTE_RESULT", 503, true);
      await this.pool.query(
        "UPDATE integration_publications SET state=$2 WHERE id=$1",
        [
          row.id,
          error.ambiguous
            ? "unknown"
            : error.code === "NEEDS_RECONNECTION"
              ? "needs-reconnection"
              : ["RETRY_LATER", "RATE_LIMIT", "PROVIDER_UNAVAILABLE"].includes(
                    error.code,
                  )
                ? "scheduled"
                : "failed",
        ],
      );
      if (error.code === "NEEDS_RECONNECTION")
        await this.pool.query(
          "UPDATE integration_accounts SET health='needs-reconnection' WHERE community_id=$1 AND provider=$2 AND destination=$3",
          [row.community_id, row.channel, row.destination],
        );
      throw error;
    }
  }
  private async persistRemote(id: string, result: any) {
    await this.pool.query(
      "UPDATE integration_publications SET remote_id=$2,remote_url=$3,state=$4,updated_at=now() WHERE id=$1",
      [id, result.id, result.url, result.state],
    );
  }
  private async persistUpload(id: string, state: VideoState) {
    await this.pool.query(
      "UPDATE integration_publications SET upload_state=$2,remote_id=$3,updated_at=now() WHERE id=$1",
      [id, state, state.videoId ?? null],
    );
  }
  async tick() {
    await this.jobs.scheduleDue();
    return this.worker.runOne(
      async (op) => {
        const db = await this.pool.connect();
        const lock = `${op.community_id}:${["publication", "video-process"].includes(op.kind) ? op.payload.destination : op.kind}`;
        let acquired = false;
        try {
          acquired = (
            await db.query(
              "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
              [lock],
            )
          ).rows[0].locked;
          if (!acquired)
            throw new IntegrationError("RETRY_LATER", 503, false, 10);
          await this.validateOperation(op);
          return await this.handleOperation(op);
        } finally {
          if (acquired)
            await db.query("SELECT pg_advisory_unlock(hashtext($1))", [lock]);
          db.release();
        }
      },
      (op) => this.validateOperation(op),
    );
  }
  async reconcilePublication(communityId: string, id: string) {
    const row = await this.publication(communityId, id);
    const account = await this.connector(
      communityId,
      row.channel,
      row.destination,
    );
    if (!row.remote_id) {
      if (row.channel === "youtube" && row.upload_state.sessionUrl) {
        const state = await (this.options.youtube ?? new YouTube()).resume(
          account,
          row.upload_state,
        );
        await this.persistUpload(id, state);
        if (state.videoId) {
          await this.persistRemote(id, {
            id: state.videoId,
            state: "uploaded-private",
            url: `https://www.youtube.com/watch?v=${state.videoId}`,
          });
          return { state: "uploaded-private" };
        }
      }
      throw new IntegrationError("MANUAL_RECONCILIATION_REQUIRED", 409);
    }
    const result =
      row.channel === "linkedin"
        ? await (this.options.linkedin ?? new LinkedIn()).read(
            account,
            row.remote_id,
          )
        : await (this.options.youtube ?? new YouTube()).read(
            account,
            row.remote_id,
          );
    await this.persistRemote(id, result);
    return result;
  }
  private async recordDirectReconciliation(
    community: string,
    id: string,
    result: any,
  ) {
    const complete = [
      "committed",
      "deployed",
      "deployment_failed",
      "superseded",
    ].includes(result.state);
    if (
      complete ||
      result.canRetryExact ||
      result.retrySafe ||
      result.state === "prepared"
    )
      await this.pool.query(
        "UPDATE worker_outbox SET state=$3,last_code=$4,result=$5,updated_at=now() WHERE community_id=$1 AND subject_id=$2 AND state IN('unknown','failed','deadletter')",
        [
          community,
          id,
          complete ? "complete" : "failed",
          complete
            ? "DIRECT_RECONCILED"
            : result.canRetryExact
              ? "EXACT_HEAD_REPLAY_ALLOWED"
              : "NO_REMOTE_OPERATION",
          result,
        ],
      );
  }
  async retryChangeset(communityId: string, actorId: string, id: string) {
    const pending = (
      await this.pool.query(
        "SELECT * FROM worker_outbox WHERE community_id=$1 AND subject_id=$2 AND kind IN('changeset','jobs-changeset')",
        [communityId, id],
      )
    ).rows[0];
    if (!pending) throw new IntegrationError("NOT_FOUND", 404);
    if (
      ["website-cli", "jobs-cli"].includes(pending.payload?.bridge) &&
      pending.actor_id !== actorId
    )
      throw new IntegrationError("ACTOR_MISMATCH", 403);
    await this.validateOperation({ ...pending, actor_id: actorId });
    return transaction(this.pool, async (db) => {
      const operation = (
        await db.query(
          "SELECT * FROM worker_outbox WHERE community_id=$1 AND subject_id=$2 AND kind IN ('changeset','jobs-changeset') FOR UPDATE",
          [communityId, id],
        )
      ).rows[0];
      if (!operation) throw new IntegrationError("NOT_FOUND", 404);
      if (operation.state === "unknown")
        throw new IntegrationError("RECONCILE_REQUIRED", 409);
      if (!["failed", "deadletter"].includes(operation.state))
        throw new IntegrationError("OPERATION_STATE", 409);
      return (
        await db.query(
          "UPDATE worker_outbox SET actor_id=$2,state='queued',attempts=0,last_code=NULL,available_at=now(),updated_at=now() WHERE id=$1 RETURNING *",
          [operation.id, actorId],
        )
      ).rows[0];
    });
  }
  private async reconcileMergedRecords(row: any, mergedSha: string) {
    if (
      !row.result.recordIds?.length ||
      row.result.reconciledMergeSha === mergedSha
    )
      return;
    const github = this.options.github!;
    const records: {
      id: string;
      type: string;
      hash: string;
      archived: boolean;
    }[] = [];
    for (const file of row.files as ExportFile[]) {
      const match = /^content\/([a-z-]+)\/([a-f0-9-]{36})\.json$/.exec(
        file.path,
      );
      if (!match || !row.result.recordIds.includes(match[2])) continue;
      const remote = await github.request(
        "GET",
        `${github.root}/contents/${file.path}?ref=${encodeURIComponent(mergedSha)}`,
      );
      if (remote.encoding !== "base64" || typeof remote.content !== "string")
        throw new IntegrationError("MERGED_CONTENT_UNAVAILABLE", 409);
      const content = JSON.parse(
        Buffer.from(remote.content, "base64").toString("utf8"),
      );
      if (content?.id !== match[2])
        throw new IntegrationError("MERGED_CONTENT_MISMATCH", 409);
      records.push({
        id: match[2],
        type: match[1],
        hash: hashValue(content),
        archived: content.status === "archived",
      });
    }
    if (records.length !== row.result.recordIds.length)
      throw new IntegrationError("MERGED_CONTENT_MISMATCH", 409);
    await transaction(this.pool, async (db) => {
      // Source metadata describes Git, while payload/revision describe the editable draft.
      // Never replace a newer draft with the revision captured by an earlier PR.
      for (const record of records) {
        const updated = await db.query(
          "UPDATE records SET source_hash=$4,source_commit=$5,state=CASE WHEN $6 AND state='approved' AND desired_status='archived' AND revision_hash=$7 THEN 'archived' ELSE state END WHERE community_id=$1 AND id=$2 AND type=$3 AND scope='public' RETURNING id",
          [
            row.community_id,
            record.id,
            record.type,
            record.hash,
            mergedSha,
            record.archived,
            row.result.revisionHashes[record.id],
          ],
        );
        if (updated.rowCount)
          await db.query(
            "UPDATE source_mappings SET source_hash=$2,source_commit=$3,updated_at=now() WHERE record_id=$1",
            [record.id, record.hash, mergedSha],
          );
      }
      await db.query(
        "UPDATE integration_changesets SET result=result || $2::jsonb WHERE id=$1 AND community_id=$3",
        [row.id, { reconciledMergeSha: mergedSha }, row.community_id],
      );
    });
  }
  async reconcileChangeset(communityId: string, id: string, actorId?: string) {
    const row = (
      await this.pool.query(
        "SELECT * FROM integration_changesets WHERE id=$1 AND community_id=$2",
        [id, communityId],
      )
    ).rows[0];
    if (!row) throw new IntegrationError("NOT_FOUND", 404);
    if (row.result.bridge === "website-cli") {
      if (!this.websitePublisher || !actorId)
        throw new IntegrationError("UNCONFIGURED", 503);
      const result = await this.websitePublisher.send(
        communityId,
        actorId,
        id,
        true,
      );
      await this.recordDirectReconciliation(communityId, id, result);
      return result;
    }
    if (row.result.bridge === "jobs-cli") {
      if (!this.jobsPublisher || !actorId)
        throw new IntegrationError("JOBS_PUBLICATION_UNCONFIGURED", 503);
      const result = await this.jobsPublisher.reconcile(
        communityId,
        actorId,
        id,
      );
      if (row.result.publicationMode === "direct")
        await this.recordDirectReconciliation(communityId, id, result);
      return result;
    }
    if (!this.options.liveEnabled || !this.options.github)
      throw new IntegrationError("INTEGRATION_DISABLED", 503);
    const target =
      `${this.options.github.config.owner}/${this.options.github.config.repo}`.toLowerCase();
    if (row.result.targetRepo && row.result.targetRepo !== target)
      throw new IntegrationError("TARGET_REPOSITORY_CHANGED", 409);
    if (!row.pr_number) {
      // A lost create response must only trigger a lookup, never a second POST.
      const github = this.options.github;
      const matches = await github.request(
        "GET",
        `${github.root}/pulls?state=all&head=${encodeURIComponent(github.config.owner + ":content/" + row.id)}&per_page=100`,
      );
      const found = matches.find((pr: any) =>
        pr.body?.includes(`export-hash:${hashValue(row.files)}`),
      );
      if (!found) throw new IntegrationError("RECONCILE_PENDING", 409);
      row.pr_number = found.number;
      await this.pool.query(
        "UPDATE integration_changesets SET pr_number=$2 WHERE id=$1 AND community_id=$3",
        [id, found.number, communityId],
      );
      await this.pool.query(
        "UPDATE worker_outbox SET state='complete',last_code='RECONCILED',result=$3,updated_at=now() WHERE community_id=$1 AND subject_id=$2 AND kind IN ('changeset','jobs-changeset') AND state='unknown'",
        [communityId, id, { prNumber: found.number }],
      );
    }
    const status = await this.options.github.status(row.pr_number);
    if (
      status.mergedSha &&
      ["merged", "deployed", "deploy_failed"].includes(status.state)
    )
      await this.reconcileMergedRecords(row, status.mergedSha);
    await this.pool.query(
      "UPDATE integration_changesets SET state=$2,head_sha=$3,merged_sha=$4,deployed_sha=$5,updated_at=now() WHERE id=$1",
      [id, status.state, status.headSha, status.mergedSha, status.deployedSha],
    );
    if (status.state === "deployed" && row.result.jobIds) {
      for (const file of row.files) {
        if (file.path.startsWith("content/jobs/") && file.content) {
          const record = JSON.parse(file.content);
          await this.pool.query(
            "UPDATE job_records SET payload=jsonb_set(payload,'{baseEntityHash}',to_jsonb($3::text)) WHERE community_id=$1 AND id=$2",
            [communityId, record.id, hashValue(record)],
          );
        }
      }
    }
    return {
      state: status.state,
      headSha: status.headSha,
      mergedSha: status.mergedSha,
      deployedSha: status.deployedSha,
    };
  }
  async runSource(communityId: string, id: string) {
    return this.jobs.run(communityId, id);
  }
  async webhook(delivery: string, signature: string, body: Buffer) {
    if (
      !this.options.webhookSecret ||
      !verifyWebhook(body, signature, this.options.webhookSecret) ||
      !/^[-a-zA-Z0-9]{1,100}$/.test(delivery)
    )
      throw new IntegrationError("INVALID_WEBHOOK", 403);
    const hash = hashValue(body.toString());
    return transaction(this.pool, async (db) => {
      const inserted = await db.query(
        "INSERT INTO integration_webhooks(provider,delivery_id,payload_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING delivery_id",
        ["github", delivery, hash],
      );
      if (!inserted.rowCount) {
        const old = (
          await db.query(
            "SELECT payload_hash FROM integration_webhooks WHERE provider=$1 AND (delivery_id=$2 OR payload_hash=$3)",
            ["github", delivery, hash],
          )
        ).rows[0];
        if (old.payload_hash !== hash)
          throw new IntegrationError("DELIVERY_CONFLICT", 409);
        return { duplicate: true };
      }
      let event: any;
      try {
        event = JSON.parse(body.toString());
      } catch {
        throw new IntegrationError("INVALID_WEBHOOK");
      }
      if (
        !this.options.github ||
        event.repository?.full_name !==
          `${this.options.github.config.owner}/${this.options.github.config.repo}`
      )
        throw new IntegrationError("REPOSITORY_MISMATCH", 403);
      // Never advance state from untrusted ordering: enqueue read-back reconciliation, not event assertions.
      const eventTime = Date.parse(
        event.pull_request?.updated_at ??
          event.check_run?.completed_at ??
          event.deployment_status?.updated_at ??
          event.workflow_run?.updated_at ??
          "",
      );
      if (
        Number.isFinite(eventTime) &&
        Date.now() - eventTime > 7 * 24 * 3600000
      )
        throw new IntegrationError("STALE_WEBHOOK", 409);
      const number = event.pull_request?.number ?? event.number;
      const rows = await db.query(
        "SELECT * FROM integration_changesets WHERE ($1::integer IS NULL OR pr_number=$1) AND pr_number IS NOT NULL",
        [number ?? null],
      );
      for (const row of rows.rows)
        await enqueue(db, {
          communityId: row.community_id,
          actorId: row.actor_id,
          kind: "reconcile",
          subjectId: row.id,
          key: `webhook:${delivery}:${row.id}`,
          payload: {},
        });
      return { duplicate: false };
    });
  }
}
