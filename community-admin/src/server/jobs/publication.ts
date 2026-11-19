import {
  publishDirect,
  publicationDeployment,
  pgDirectStore,
  type DirectInput,
  expectedRevisionMap,
} from "../editorial-sync/direct";
import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";
import { readFile } from "node:fs/promises";
import { transaction } from "../db";
import { capabilitiesFor, auditEvent } from "../context";
import { enqueue } from "../worker/outbox";
import { hashRevision } from "../../shared/content";
import {
  hashValue,
  deterministicId,
  IntegrationError,
} from "../integrations/security";
import { GhEditorialTransport } from "../editorial-sync/github";
import type {
  EditorialConfig,
  EditorialTransport,
  ProposalFile,
  ProposalInput,
} from "../editorial-sync/types";
import { validatePublicExport } from "../public-validation";
import { publicJobs, classifyRole } from "./engine";
import { strongVacancyDuplicates } from "./intake";
import { jobGeography, isClosedGeographicWithdrawal } from "./geography";
import { jobRecordPath, type PublicJobRecord } from "./publication-contract";
export function jobPublicationRevision(payload: any) {
  const { baseEntityHash, publicationBaseline, ...content } = payload;
  return hashValue(content);
}
export interface JobsRemote extends EditorialTransport<PublicJobRecord> {
  deployment?(sha: string): Promise<{ state: string; url?: string }>;
  verifyWebsite?(sha: string): Promise<void>;
}
export interface JobsPublicationOptions {
  config: EditorialConfig;
  transport?: JobsRemote;
}
/** Independent website-vacancy scope. Enabling it never changes Events or social flags. */
export function jobsPublicationEnvironment(): JobsPublicationOptions {
  const repository = process.env.JOBS_WEBSITE_REPOSITORY || null,
    branch = process.env.JOBS_WEBSITE_BRANCH || "main";
  if (
    repository &&
    repository !== "platform-engineering-peru/platform-engineering-web"
  )
    throw new Error("Invalid jobs website repository");
  if (branch !== "main") throw new Error("Invalid jobs website base branch");
  if (
    process.env.JOBS_WEBSITE_WRITES &&
    !["0", "1"].includes(process.env.JOBS_WEBSITE_WRITES)
  )
    throw new Error("Invalid jobs website writes flag");
  return {
    config: {
      mode: "github",
      repository,
      branch,
      remoteWritesEnabled: process.env.JOBS_WEBSITE_WRITES === "1",
    },
  };
}
class CliJobsTransport extends GhEditorialTransport<PublicJobRecord> {
  constructor(config: EditorialConfig) {
    super(config, undefined, undefined, "jobs");
  }
  async verifyWebsite(commit: string) {
    if (!/^[a-f0-9]{40}$/.test(commit))
      throw new IntegrationError("REMOTE_RESPONSE_INVALID");
    try {
      const schema = await this.api(
          "GET",
          `${this.root}/contents/content/schemas/jobs-v1.schema.json?ref=${commit}`,
        ),
        renderer = await this.api(
          "GET",
          `${this.root}/contents/src/data/opportunities-contract.ts?ref=${commit}`,
        );
      if (
        schema.type !== "file" ||
        schema.encoding !== "base64" ||
        typeof schema.content !== "string" ||
        schema.size > 500000 ||
        renderer.type !== "file" ||
        renderer.size < 1
      )
        throw Error("missing");
      const expected = JSON.parse(
          await readFile("contracts/jobs-v1.schema.json", "utf8"),
        ),
        actual = JSON.parse(
          Buffer.from(schema.content, "base64").toString("utf8"),
        );
      if (hashValue(actual) !== hashValue(expected))
        throw Error("schema mismatch");
    } catch {
      throw new IntegrationError("WEBSITE_RENDERER_NOT_READY", 409);
    }
  }
}
export class JobsPublisher {
  private connections = new AsyncLocalStorage<pg.PoolClient>();
  private get db(): pg.Pool | pg.PoolClient {
    return this.connections.getStore() ?? this.pool;
  }
  private async locked<T>(
    community: string,
    id: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.connect();
    let locked = false;
    try {
      locked = Boolean(
        (
          await connection.query(
            "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
            ["jobs-cli-operation:" + community + ":" + id],
          )
        ).rows[0].locked,
      );
      if (!locked) throw new IntegrationError("OPERATION_IN_PROGRESS", 409);
      return await this.connections.run(connection, fn);
    } finally {
      if (locked)
        await connection.query("SELECT pg_advisory_unlock(hashtext($1))", [
          "jobs-cli-operation:" + community + ":" + id,
        ]);
      connection.release();
    }
  }
  readonly transport: JobsRemote;
  constructor(
    readonly pool: pg.Pool,
    readonly options: JobsPublicationOptions,
  ) {
    this.transport = options.transport ?? new CliJobsTransport(options.config);
  }
  get configured() {
    return Boolean(this.options.config.repository);
  }
  private assertConfigured() {
    if (!this.configured)
      throw new IntegrationError("JOBS_PUBLICATION_UNCONFIGURED", 503);
    if (!this.options.config.remoteWritesEnabled)
      throw new IntegrationError("JOBS_PUBLICATION_WRITES_DISABLED", 403);
  }
  async identity(
    community: string,
    actor: string,
    db: pg.Pool | pg.PoolClient = this.db,
  ) {
    const row = (
      await db.query(
        "SELECT provider_subject,active,role,roles FROM users WHERE community_id=$1 AND id=$2",
        [community, actor],
      )
    ).rows[0];
    const identity = await this.transport.identity();
    if (
      !row?.active ||
      !capabilitiesFor(row.roles?.length ? row.roles : [row.role]).some(
        (c) => c === "*" || c === "content:publish",
      ) ||
      !row.provider_subject ||
      row.provider_subject !== identity.subject
    )
      throw new IntegrationError("AUTH_IDENTITY_MISMATCH", 403);
    return identity;
  }
  async status(community: string, actor: string) {
    const reasons: string[] = [];
    let identity: null | { subject: string; login: string } = null;
    if (!this.configured) reasons.push("JOBS_PUBLICATION_UNCONFIGURED");
    if (!this.options.config.remoteWritesEnabled)
      reasons.push("JOBS_PUBLICATION_WRITES_DISABLED");
    if (this.configured)
      try {
        identity = await this.identity(community, actor);
        const snapshot = await this.transport.snapshot();
        await this.transport.verifyWebsite?.(snapshot.commit);
      } catch (error: any) {
        reasons.push(error.code ?? "AUTH_IDENTITY_MISMATCH");
      }
    return {
      ready: reasons.length === 0,
      reasons,
      mode: "website-gh-cli",
      publicationMode: this.transport.commitDirect ? "direct" : "pull-request",
      repository: this.options.config.repository,
      branch: this.options.config.branch,
      remoteWritesEnabled: this.options.config.remoteWritesEnabled,
      identity,
      mergeAutomatic: false,
      publishingIndependentOfSocial: true,
    };
  }
  private async records(
    db: pg.Pool | pg.PoolClient,
    community: string,
    ids: string[],
    lock = false,
  ) {
    const rows = (
      await db.query(
        `SELECT * FROM job_records WHERE community_id=$1 AND id=ANY($2::text[]) ORDER BY id${lock ? " FOR UPDATE" : ""}`,
        [community, ids],
      )
    ).rows;
    if (rows.length !== ids.length)
      throw new IntegrationError("NOT_FOUND", 404);
    const records = publicJobs(rows.map((r) => r.payload)) as PublicJobRecord[];
    if (records.length !== rows.length)
      throw new IntegrationError("JOB_APPROVAL_REQUIRED", 409);
    for (const record of records) {
      jobRecordPath(record.id);
      await validatePublicExport("jobs", record);
    }
    return {
      rows,
      records,
      hashes: Object.fromEntries(
        rows.map((r) => [r.id, jobPublicationRevision(r.payload)]),
      ),
    };
  }
  async create(
    community: string,
    actor: string,
    ids: string[],
    key: string,
    expected?: unknown,
  ) {
    const expectedVersions = this.transport.commitDirect
      ? expectedRevisionMap(ids, expected, "versions")
      : null;
    this.assertConfigured();
    if (!key || key.length > 160)
      throw new IntegrationError("IDEMPOTENCY_KEY_REQUIRED", 428);
    const jobIds = [...new Set(ids)].sort();
    if (!jobIds.length || jobIds.length > 25)
      throw new IntegrationError("PUBLICATION_LIMIT");
    return transaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "jobs-publish-create:" + community + ":" + actor,
      ]);
      const directRequestHash = expectedVersions
        ? hashValue({
            community,
            actor,
            ids: jobIds,
            expectedVersions,
            repository: this.options.config.repository,
            branch: this.options.config.branch,
          })
        : null;
      if (directRequestHash) {
        const replay = (
          await db.query(
            "SELECT * FROM integration_requests WHERE community_id=$1 AND key=$2",
            [community, "jobs-cli:" + key],
          )
        ).rows[0];
        if (replay) {
          if (replay.request_hash !== directRequestHash)
            throw new IntegrationError("IDEMPOTENCY_CONFLICT", 409);
          return (
            (
              await db.query(
                "SELECT * FROM worker_outbox WHERE community_id=$1 AND id=$2",
                [community, replay.response.id],
              )
            ).rows[0] ?? replay.response
          );
        }
      }
      if (this.transport.commitDirect) {
        const selected = (
          await db.query(
            "SELECT * FROM job_records WHERE community_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",
            [community, jobIds],
          )
        ).rows;
        if (selected.length !== jobIds.length)
          throw new IntegrationError("NOT_FOUND", 404);
        if (selected.some((row) => row.version !== expectedVersions![row.id]))
          throw new IntegrationError("JOB_VERSION_CONFLICT", 409);
        const all = (
          await db.query(
            "SELECT payload FROM job_records WHERE community_id=$1 AND payload->>'status'<>'excluded'",
            [community],
          )
        ).rows.map((r) => r.payload);
        if (
          strongVacancyDuplicates(all).some((group) =>
            group.ids.some((id) =>
              selected.some(
                (row) => row.id === id && row.payload.status !== "closed",
              ),
            ),
          )
        )
          throw new IntegrationError("DUPLICATE_VACANCY_REVIEW_REQUIRED", 409);
        for (const row of selected) {
          const p = row.payload;
          const withdrawing =
            p.status === "closed" &&
            p.editorialWithdrawal?.publicRecord &&
            isClosedGeographicWithdrawal(p);
          const reviewed = withdrawing ? p.editorialWithdrawal.publicRecord : p;
          if (
            (!withdrawing &&
              !classifyRole(p.title) &&
              !(
                p.intake?.kind === "single-detail" &&
                ["devops", "platform", "sre", "fde", "infrastructure"].includes(
                  p.intake?.curator?.roleFamily,
                ) &&
                p.roleFamily === p.intake.curator.roleFamily
              )) ||
            (!jobGeography(p).qualified && !isClosedGeographicWithdrawal(p)) ||
            !["remote", "hybrid", "onsite", "unknown"].includes(
              reviewed.workplace,
            ) ||
            p.status === "excluded" ||
            !reviewed.summary?.["es-pe"] ||
            !reviewed.summary?.en ||
            /^(Resumen editorial pendiente\.|Editorial summary pending\.)$/.test(
              reviewed.summary.en,
            ) ||
            /^(Resumen editorial pendiente\.|Editorial summary pending\.)$/.test(
              reviewed.summary["es-pe"],
            )
          )
            throw new IntegrationError("JOB_APPROVAL_REQUIRED", 409);
          if (
            p.status !== "closed" &&
            (p.sourceClosed ||
              p.editorialClosure ||
              (p.expiresAt && Date.parse(p.expiresAt) <= Date.now()))
          )
            throw new IntegrationError("JOB_NOT_ACTIVE", 409);
          const payload = {
            ...p,
            approved: true,
            status:
              p.status === "closed"
                ? "closed"
                : p.status === "stale"
                  ? "stale"
                  : "active",
          };
          if (hashValue(payload) !== hashValue(p)) {
            await db.query(
              "UPDATE job_records SET payload=$3,version=version+1,updated_at=now() WHERE community_id=$1 AND id=$2",
              [community, row.id, payload],
            );
            await auditEvent(
              db,
              { id: actor, communityId: community },
              deterministicId({ job: row.id }),
              "administrator_vacancy_publication_reviewed",
              { jobId: row.id },
            );
          }
        }
      }
      const exported = await this.records(db, community, jobIds, true),
        identity = await this.identity(community, actor, db);
      const intent = {
          community,
          actor,
          ...(this.transport.commitDirect
            ? { submissionKey: key, subject: identity.subject }
            : {}),
          jobIds,
          revisionHashes: exported.hashes,
          targetRepo: this.options.config.repository,
          branch: this.options.config.branch,
        },
        requestHash = directRequestHash ?? hashValue(intent),
        id = deterministicId({ kind: "jobs-cli", ...intent }),
        requestKey = "jobs-cli:" + key;
      const previous = (
        await db.query(
          "SELECT * FROM integration_requests WHERE community_id=$1 AND key=$2",
          [community, requestKey],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash)
          throw new IntegrationError("IDEMPOTENCY_CONFLICT", 409);
        return (
          await db.query(
            "SELECT * FROM worker_outbox WHERE id=$1 AND community_id=$2",
            [previous.response.id, community],
          )
        ).rows[0];
      }
      const existing = (
        await db.query(
          "SELECT * FROM worker_outbox WHERE community_id=$1 AND subject_id=$2 AND kind='jobs-changeset'",
          [community, id],
        )
      ).rows[0];
      if (existing) {
        await db.query(
          "INSERT INTO integration_requests(community_id,key,request_hash,response) VALUES($1,$2,$3,$4)",
          [community, requestKey, requestHash, existing],
        );
        return existing;
      }
      const remote = await this.transport.snapshot();
      await this.transport.verifyWebsite?.(remote.commit);
      const files: ProposalFile<PublicJobRecord>[] = exported.records.map(
          (record) => ({
            path: jobRecordPath(record.id),
            record,
            hash: hashRevision(record),
          }),
        ),
        baseHashes: Record<string, string | null> = {};
      for (const row of exported.rows) {
        const current =
            remote.records.find((r) => r.record.id === row.id)?.record ?? null,
          actual = current ? hashRevision(current) : null,
          expected = row.payload.baseEntityHash ?? null;
        if (
          actual !== expected &&
          (!current ||
            hashRevision(current) !==
              hashRevision(files.find((f) => f.record.id === row.id)!.record))
        )
          throw new IntegrationError("REMOTE_JOB_CONFLICT", 409);
        baseHashes[row.id] = actual;
      }
      const result = {
        bridge: "jobs-cli",
        publicationMode: this.transport.commitDirect
          ? "direct"
          : "pull-request",
        jobIds,
        revisionHashes: exported.hashes,
        expectedVersions,
        submittedVersions: Object.fromEntries(
          exported.rows.map((row) => [row.id, row.version]),
        ),
        targetRepo: this.options.config.repository,
        baseBranch: this.options.config.branch,
        baseCommit: remote.commit,
        baseHashes,
        subject: identity.subject,
        proposalId: hashValue({ kind: "jobs-cli", ...intent }),
        deployment: null,
      };
      const operation = await enqueue(db, {
        communityId: community,
        actorId: actor,
        kind: "jobs-changeset",
        subjectId: id,
        key: requestKey,
        payload: result,
        semanticKey: "jobs-cli:" + requestHash,
      });
      await db.query(
        "INSERT INTO integration_changesets(id,community_id,actor_id,revision_hash,files,result,state) VALUES($1,$2,$3,$4,$5,$6,'prepared')",
        [
          id,
          community,
          actor,
          hashValue(exported.hashes),
          JSON.stringify(
            files.map((f) => ({
              path: f.path,
              content: JSON.stringify(f.record, null, 2) + "\n",
            })),
          ),
          result,
        ],
      );
      await db.query(
        "INSERT INTO integration_requests(community_id,key,request_hash,response) VALUES($1,$2,$3,$4)",
        [community, requestKey, requestHash, operation],
      );
      await auditEvent(
        db,
        { id: actor, communityId: community },
        id,
        "website_vacancies_prepared",
        { jobIds, repository: this.options.config.repository },
      );
      return {
        ...operation,
        publication: {
          state: "prepared",
          repository: this.options.config.repository,
          automaticMerge: false,
        },
      };
    });
  }
  private input(
    row: any,
    subject: string,
    baseCommit = row.result.baseCommit,
  ): ProposalInput<PublicJobRecord> {
    return {
      subject,
      id: row.result.proposalId,
      branch: `editorial/${row.result.proposalId}`,
      baseCommit,
      title: "Publish reviewed Peru community vacancies",
      files: row.files.map((f: any) => {
        const record = JSON.parse(f.content);
        return { path: f.path, record, hash: hashRevision(record) };
      }),
    };
  }
  private async row(community: string, id: string) {
    const row = (
      await this.db.query(
        "SELECT * FROM integration_changesets WHERE community_id=$1 AND id=$2",
        [community, id],
      )
    ).rows[0];
    if (!row || row.result.bridge !== "jobs-cli")
      throw new IntegrationError("NOT_FOUND", 404);
    return row;
  }
  async publish(community: string, actor: string, id: string) {
    this.assertConfigured();
    return this.locked(community, id, () => this.send(community, actor, id));
  }
  private async send(community: string, actor: string, id: string) {
    const connection = this.db as pg.PoolClient;
    let attempted = false;
    try {
      const row = await this.row(community, id);
      if (row.state === "cancelled")
        throw new IntegrationError("CANCELLED", 409);
      if (row.actor_id !== actor)
        throw new IntegrationError("ACTOR_MISMATCH", 403);
      if (
        row.result.targetRepo !== this.options.config.repository ||
        row.result.baseBranch !== this.options.config.branch
      )
        throw new IntegrationError("TARGET_REPOSITORY_CHANGED", 409);
      const identity = await this.identity(community, actor);
      if (identity.subject !== row.result.subject)
        throw new IntegrationError("AUTH_IDENTITY_MISMATCH", 403);
      if (row.result.publicationMode === "direct") {
        try {
          return await this.sendDirect(row, identity.subject);
        } catch (e: any) {
          await this.db.query(
            "UPDATE integration_changesets SET state=$3,result=result||$4::jsonb WHERE community_id=$1 AND id=$2",
            [
              community,
              id,
              e.code === "PUBLICATION_UNCERTAIN"
                ? "uncertain"
                : e.code === "REMOTE_RECORD_CONFLICT"
                  ? "conflict"
                  : "blocked",
              { errorCode: e.code, conflicts: e.conflicts ?? null },
            ],
          );
          throw e;
        }
      }
      const input = this.input(row, identity.subject),
        existing = await this.transport.findProposal(input.branch);
      if (existing) return await this.persistRemote(row, existing);
      const inspection = await this.transport.inspectProposal(input);
      {
        const snapshot = await this.transport.snapshot();
        await this.transport.verifyWebsite?.(snapshot.commit);
        for (const [jobId, expected] of Object.entries(row.result.baseHashes)) {
          const current =
            snapshot.records.find((r) => r.record.id === jobId)?.record ?? null;
          if ((current ? hashRevision(current) : null) !== expected)
            throw new IntegrationError("REMOTE_JOB_CONFLICT", 409);
        }
        if (inspection.state === "absent") {
          input.baseCommit = snapshot.commit;
          await this.db.query(
            "UPDATE integration_changesets SET result=jsonb_set(result,'{baseCommit}',$3::jsonb) WHERE community_id=$1 AND id=$2",
            [community, id, JSON.stringify(snapshot.commit)],
          );
        }
      }
      await connection.query("BEGIN");
      const current = await this.records(
        connection,
        community,
        row.result.jobIds,
        true,
      );
      if (
        (row.result.submittedVersions &&
          current.rows.some(
            (r) => r.version !== row.result.submittedVersions[r.id],
          )) ||
        hashValue(current.hashes) !== hashValue(row.result.revisionHashes)
      )
        throw new IntegrationError("APPROVAL_REVOKED", 409);
      // Hold record locks through bounded remote mutations: concurrent reviews cannot invalidate the sent revision mid-flight.
      attempted = true;
      const remote = await this.transport.createProposal(input);
      await connection.query("COMMIT");
      const fresh = await this.row(community, id);
      return await this.persistRemote(fresh, remote);
    } catch (error: any) {
      await connection.query("ROLLBACK").catch(() => {});
      if (attempted && error.remoteMutationAttempted !== false) {
        await this.db.query(
          "UPDATE integration_changesets SET state='unknown',result=result||$3::jsonb WHERE community_id=$1 AND id=$2",
          [community, id, { errorCode: error.code ?? "PROPOSAL_UNCERTAIN" }],
        );
        throw new IntegrationError("PROPOSAL_UNCERTAIN", 503, true);
      }
      throw error;
    }
  }
  private directInput(row: any): DirectInput<PublicJobRecord> {
    return {
      id: row.result.proposalId,
      subject: row.result.subject,
      repository: row.result.targetRepo,
      branch: row.result.baseBranch,
      baseCommit: row.result.baseCommit,
      baseHashes: Object.fromEntries(
        row.files.map((f: any) => [
          f.path,
          row.result.baseHashes[JSON.parse(f.content).id] ?? null,
        ]),
      ),
      files: row.files.map((f: any) => {
        const record = JSON.parse(f.content);
        return { path: f.path, record, hash: hashRevision(record) };
      }),
    };
  }
  private async sendDirect(row: any, subject: string, reconcileOnly = false) {
    const input = this.directInput(row);
    if (input.subject !== subject)
      throw new IntegrationError("AUTH_IDENTITY_MISMATCH", 403);
    const store = pgDirectStore(this.db, input);
    const before = async () => {
      await this.identity(row.community_id, row.actor_id);
      const current = await this.records(
        this.db,
        row.community_id,
        row.result.jobIds,
        false,
      );
      if (
        (row.result.submittedVersions &&
          current.rows.some(
            (r) => r.version !== row.result.submittedVersions[r.id],
          )) ||
        hashValue(current.hashes) !== hashValue(row.result.revisionHashes)
      )
        throw new IntegrationError("APPROVAL_REVOKED", 409);
    };
    let proof: any;
    if (reconcileOnly) {
      const attempt = await store.latest();
      if (!attempt)
        return {
          state: "prepared",
          publicationMode: "direct",
          changesetId: row.id,
          retrySafe: true,
        };
      const inspected = await this.transport.inspectDirect!(input, attempt);
      if (inspected.state !== "committed") {
        if (
          inspected.state === "head-unchanged" ||
          attempt.state === "committed"
        ) {
          await this.db.query(
            "UPDATE integration_changesets SET state='uncertain',result=result||$3::jsonb WHERE community_id=$1 AND id=$2",
            [
              row.community_id,
              row.id,
              { canRetryExact: true, errorCode: "PUBLICATION_UNCERTAIN" },
            ],
          );
          return {
            state: "uncertain",
            publicationMode: "direct",
            changesetId: row.id,
            canRetryExact: true,
            canReconcile: true,
          };
        }
        await store.save({ ...attempt, state: "absent" });
        await this.db.query(
          "UPDATE integration_changesets SET state='prepared' WHERE community_id=$1 AND id=$2",
          [row.community_id, row.id],
        );
        return {
          state: "prepared",
          publicationMode: "direct",
          changesetId: row.id,
          retrySafe: true,
        };
      }
      proof = inspected.commit;
      await store.save({ ...attempt, state: "committed", proof });
    } else {
      const transport = Object.create(this.transport) as JobsRemote;
      transport.commitDirect = async (i, a) => {
        const db = this.db as pg.PoolClient;
        await db.query("BEGIN");
        try {
          await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
            row.actor_id,
          ]);
          await this.identity(row.community_id, row.actor_id);
          const current = await this.records(
            db,
            row.community_id,
            row.result.jobIds,
            true,
          );
          if (
            hashValue(current.hashes) !== hashValue(row.result.revisionHashes)
          )
            throw Object.assign(new IntegrationError("APPROVAL_REVOKED", 409), {
              remoteMutationAttempted: false,
            });
          const result = await this.transport.commitDirect!(i, a);
          await db.query("COMMIT");
          return result;
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        }
      };
      proof = await publishDirect(
        transport,
        input,
        store,
        before,
        async (snapshot) => {
          await this.transport.verifyWebsite?.(snapshot.commit);
        },
      );
    }
    const remote = {
      publicationMode: "direct",
      number: null,
      url: proof.commitUrl,
      headCommit: proof.commitSha,
      state: "merged",
      mergeCommit: proof.commitSha,
      files: input.files,
      marker: input.id,
      branch: `editorial/${input.id}`,
      baseBranch: "main",
      authorSubject: input.subject,
      commitSha: proof.commitSha,
      commitUrl: proof.commitUrl,
      parent: proof.parent,
    };
    await this.db.query(
      "UPDATE integration_changesets SET state='committed',head_sha=$3,result=result||$4::jsonb WHERE community_id=$1 AND id=$2",
      [
        row.community_id,
        row.id,
        proof.commitSha,
        {
          publicationMode: "direct",
          commitSha: proof.commitSha,
          commitUrl: proof.commitUrl,
        },
      ],
    );
    const result = await this.persistRemote(row, remote);
    const directDeployment = await publicationDeployment(
      this.transport,
      proof,
      input.files,
    );
    result.deployment = directDeployment;
    const state =
      result.deployment?.state === "deployed"
        ? "deployed"
        : result.deployment?.state === "failed"
          ? "deployment_failed"
          : result.deployment?.state === "superseded"
            ? "superseded"
            : "committed";
    await this.db.query(
      "UPDATE integration_changesets SET state=$3,result=result||$4::jsonb,deployed_sha=$5 WHERE community_id=$1 AND id=$2",
      [
        row.community_id,
        row.id,
        state,
        {
          publicationMode: "direct",
          commitSha: proof.commitSha,
          commitUrl: proof.commitUrl,
          deployment: directDeployment,
        },
        state === "deployed" ? (directDeployment.sha ?? proof.commitSha) : null,
      ],
    );
    return {
      state,
      publicationMode: "direct",
      changesetId: row.id,
      operationId: row.id,
      commitSha: proof.commitSha,
      commitUrl: proof.commitUrl,
      expectedHeadOid: proof.parent,
      deployment: result.deployment,
    };
  }
  private async persistRemote(row: any, remote: any) {
    const input = this.input(row, row.result.subject);
    if (
      remote.branch !== input.branch ||
      remote.baseBranch !== this.options.config.branch ||
      remote.marker !== input.id ||
      remote.authorSubject !== row.result.subject ||
      hashRevision(
        remote.files
          .map((f: any) => ({ path: f.path, record: f.record }))
          .sort((a: any, b: any) => a.path.localeCompare(b.path)),
      ) !==
        hashRevision(
          input.files
            .map((f) => ({ path: f.path, record: f.record }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        )
    )
      throw new IntegrationError("PROPOSAL_CONTENT_MISMATCH", 409);
    let state =
        remote.state === "open"
          ? "pr_open"
          : remote.state === "closed"
            ? "closed"
            : "merged",
      deployment: any = null;
    if (state === "merged") {
      if (!remote.mergeCommit)
        throw new IntegrationError("MERGE_NOT_VERIFIED", 409);
      const snapshot = await this.transport.snapshot(remote.mergeCommit);
      for (const file of input.files)
        if (
          hashRevision(
            snapshot.records.find((r) => r.record.id === file.record.id)
              ?.record ?? null,
          ) !== file.hash
        )
          throw new IntegrationError("MERGE_NOT_VERIFIED", 409);
      deployment = (await this.transport
        .deployment?.(remote.mergeCommit)
        .catch(() => ({ state: "pending" }))) ?? {
        state: "merged",
      };
      if (deployment.state === "deployed") state = "deployed";
      await this.db.query("BEGIN");
      try {
        const locals = (
          await this.db.query(
            "SELECT id,payload FROM job_records WHERE community_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",
            [row.community_id, input.files.map((f) => f.record.id)],
          )
        ).rows;
        // The CURRENT canonical head is read while baseline rows are locked. Replaying an older merged PR cannot restore its older content hash.
        const latest = await this.transport.snapshot();
        for (const file of input.files) {
          const current =
              latest.records.find((r) => r.record.id === file.record.id)
                ?.record ?? null,
            local = locals.find((r) => r.id === file.record.id);
          if (
            !local ||
            hashRevision(current) !== file.hash ||
            local.payload.baseEntityHash === file.hash
          )
            continue;
          await this.db.query(
            "UPDATE job_records SET payload=payload||$3::jsonb,version=version+1,updated_at=now() WHERE community_id=$1 AND id=$2",
            [
              row.community_id,
              file.record.id,
              {
                baseEntityHash: file.hash,
                publicationBaseline: {
                  publicRecord: file.record,
                  commit: latest.commit,
                  operationId: row.id,
                },
              },
            ],
          );
          await auditEvent(
            this.db as pg.PoolClient,
            { id: row.actor_id, communityId: row.community_id },
            deterministicId({ job: file.record.id }),
            "website_vacancy_baseline_updated",
            {
              jobId: file.record.id,
              operationId: row.id,
              commit: latest.commit,
            },
          );
        }
        await this.db.query("COMMIT");
      } catch (error) {
        await this.db.query("ROLLBACK");
        throw error;
      }
    }
    await this.db.query(
      "UPDATE integration_changesets SET state=$3,pr_number=$4,head_sha=$5,merged_sha=$6,deployed_sha=$7,result=result||$8::jsonb,updated_at=now() WHERE community_id=$1 AND id=$2",
      [
        row.community_id,
        row.id,
        state,
        remote.number,
        remote.headCommit,
        remote.mergeCommit ?? null,
        state === "deployed" ? remote.mergeCommit : null,
        { remote, prUrl: remote.url, deployment },
      ],
    );
    return {
      state,
      changesetId: row.id,
      prNumber: remote.number,
      prUrl: remote.url,
      headSha: remote.headCommit,
      mergedSha: remote.mergeCommit ?? null,
      deployedSha: state === "deployed" ? remote.mergeCommit : null,
      deployment,
      checks: remote.checks,
      reviewDecision: remote.reviewDecision,
    };
  }
  async reconcile(community: string, actor: string, id: string) {
    return this.locked(community, id, () =>
      this.reconcileLocked(community, actor, id),
    );
  }
  private async reconcileLocked(community: string, actor: string, id: string) {
    const row = await this.row(community, id);
    if (row.state === "cancelled")
      return { state: "cancelled", remoteUnchanged: true };
    if (row.actor_id !== actor)
      throw new IntegrationError("ACTOR_MISMATCH", 403);
    if (
      row.result.targetRepo !== this.options.config.repository ||
      row.result.baseBranch !== this.options.config.branch
    )
      throw new IntegrationError("TARGET_REPOSITORY_CHANGED", 409);
    const identity = await this.identity(community, actor);
    if (identity.subject !== row.result.subject)
      throw new IntegrationError("AUTH_IDENTITY_MISMATCH", 403);
    if (row.result.publicationMode === "direct")
      return this.sendDirect(row, identity.subject, true);
    const input = this.input(row, identity.subject),
      remote = await this.transport.findProposal(input.branch);
    if (remote) {
      const result = await this.persistRemote(row, remote);
      await this.db.query(
        "UPDATE worker_outbox SET state='complete',result=$3,last_code='RECONCILED',updated_at=now() WHERE community_id=$1 AND subject_id=$2 AND kind='jobs-changeset'",
        [community, id, result],
      );
      return result;
    }
    const inspection = await this.transport.inspectProposal(input);
    await this.db.query(
      "UPDATE integration_changesets SET state='prepared' WHERE community_id=$1 AND id=$2",
      [community, id],
    );
    await this.db.query(
      "UPDATE worker_outbox SET state='failed',last_code=$3 WHERE community_id=$1 AND subject_id=$2 AND kind='jobs-changeset' AND state='unknown'",
      [
        community,
        id,
        inspection.state === "absent"
          ? "NO_REMOTE_OPERATION"
          : "BRANCH_VERIFIED",
      ],
    );
    return {
      state: inspection.state === "absent" ? "prepared" : "branch_pending",
      changesetId: id,
      retrySafe: true,
    };
  }
}
