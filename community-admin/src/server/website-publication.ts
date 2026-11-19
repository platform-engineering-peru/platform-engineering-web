import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";
import { hashRevision } from "../shared/content";
import { capabilitiesFor, auditEvent } from "./context";
import { transaction } from "./db";
import { enqueue } from "./worker/outbox";
import {
  hashValue,
  deterministicId,
  IntegrationError,
} from "./integrations/security";
import type { ExportFile } from "./integrations/github";
import { GhEditorialTransport } from "./editorial-sync/github";
import {
  publishDirect,
  publicationDeployment,
  pgDirectStore,
  type DirectInput,
  expectedRevisionMap,
} from "./editorial-sync/direct";
import type {
  EditorialConfig,
  EditorialTransport,
  ProposalFile,
} from "./editorial-sync/types";
import { validateSnapshot, publicTypes } from "./editorial-sync/validation";
export interface WebsitePublicationOptions {
  config: EditorialConfig;
  transport?: EditorialTransport<any>;
  eventsAuthority?: "local" | "github";
}
export class WebsitePublisher {
  readonly transport: EditorialTransport<any>;
  private connections = new AsyncLocalStorage<pg.PoolClient>();
  private get db() {
    return this.connections.getStore() ?? this.pool;
  }
  constructor(
    readonly pool: pg.Pool,
    readonly options: WebsitePublicationOptions,
    readonly exporter: (
      db: pg.PoolClient,
      community: string,
      ids: string[],
    ) => Promise<{
      files: ExportFile[];
      revisionHashes: Record<string, string>;
    }>,
  ) {
    this.transport =
      options.transport ??
      new GhEditorialTransport(options.config, undefined, undefined, "public");
  }
  get configured() {
    return Boolean(this.options.config.repository);
  }
  async identity(community: string, actor: string, db: any = this.db) {
    const u = (
      await db.query("SELECT * FROM users WHERE community_id=$1 AND id=$2", [
        community,
        actor,
      ])
    ).rows[0];
    if (
      !u?.active ||
      !capabilitiesFor(u.roles?.length ? u.roles : [u.role]).some(
        (c) => c === "*" || c === "content:publish",
      )
    )
      throw new IntegrationError("ACTOR_REVOKED", 403);
    const identity = await this.transport.identity();
    if (u.provider_subject !== identity.subject)
      throw new IntegrationError("AUTH_IDENTITY_MISMATCH", 403);
    return identity;
  }
  async status(
    community: string,
    actor: string,
    selectedTypes: string[] = publicTypes,
  ) {
    if (selectedTypes.some((type) => !publicTypes.includes(type)))
      throw new IntegrationError("PATH_NOT_ALLOWED", 422);
    const reasons: string[] = [];
    if (!this.configured) reasons.push("UNCONFIGURED");
    if (!this.options.config.remoteWritesEnabled)
      reasons.push("REMOTE_WRITES_DISABLED");
    let identity: any = null;
    try {
      if (this.configured) identity = await this.identity(community, actor);
    } catch (e: any) {
      reasons.push(e.code ?? "AUTH_UNAVAILABLE");
    }
    let types: Record<string, { rendererReady: boolean; reason?: string }> = {};
    if (this.configured && identity) {
      try {
        const head = this.transport.headCommit
          ? await this.transport.headCommit()
          : (await this.transport.snapshot()).commit;
        if (this.transport.rendererReadiness)
          types = await this.transport.rendererReadiness(head, selectedTypes);
        else
          for (const type of selectedTypes) {
            try {
              await this.transport.verifyWebsite?.(head, [type]);
              types[type] = { rendererReady: true };
            } catch (e: any) {
              types[type] = {
                rendererReady: false,
                reason: e.code ?? "REMOTE_UNAVAILABLE",
              };
            }
          }
        for (const value of Object.values(types))
          if (
            !value.rendererReady &&
            value.reason &&
            !reasons.includes(value.reason)
          )
            reasons.push(value.reason);
      } catch (e: any) {
        reasons.push(e.code ?? "REMOTE_UNAVAILABLE");
      }
    }
    return {
      types,
      ready: reasons.length === 0,
      reasons,
      publicationMode: "direct",
      protocol: "direct-main",
      repository: this.options.config.repository,
      branch: this.options.config.branch,
      remoteWritesEnabled: this.options.config.remoteWritesEnabled,
      identity,
      supportedTypes: publicTypes,
      publishingIndependentOfSocial: true,
    };
  }
  private files(files: ExportFile[]): ProposalFile<any>[] {
    return files.map((f) => {
      if (typeof f.content !== "string")
        throw new IntegrationError("INVALID_EXPORT", 422);
      const record =
        f.encoding === "base64"
          ? { id: f.path, bytes: f.content }
          : JSON.parse(f.content);
      return {
        path: f.path,
        record,
        hash: hashRevision(record),
        ...(f.encoding === "base64" ? { contentBase64: f.content } : {}),
      };
    });
  }
  async create(
    community: string,
    actor: string,
    ids: string[],
    key: string,
    expected?: unknown,
  ) {
    const expectedRevisions = expectedRevisionMap(ids, expected, "revisions");
    if (!key || key.length > 200)
      throw new IntegrationError("IDEMPOTENCY_KEY_REQUIRED", 428);
    if (!this.configured) throw new IntegrationError("UNCONFIGURED", 503);
    if (!this.options.config.remoteWritesEnabled)
      throw new IntegrationError("REMOTE_WRITES_DISABLED", 403);
    const identity = await this.identity(community, actor);
    return transaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "website-prepare:" + community + ":" + actor,
      ]);
      const requestKey = "website-direct:" + actor + ":" + key;
      const requestHash = hashValue({
        community,
        actor,
        repository: this.options.config.repository,
        branch: this.options.config.branch,
        ids: ids.slice().sort(),
        expectedRevisions,
      });
      const replay = (
        await db.query(
          "SELECT * FROM integration_requests WHERE community_id=$1 AND key=$2",
          [community, requestKey],
        )
      ).rows[0];
      if (replay) {
        if (replay.request_hash !== requestHash)
          throw new IntegrationError("IDEMPOTENCY_CONFLICT", 409);
        return replay.response;
      }
      const rows = (
        await db.query(
          "SELECT * FROM records WHERE community_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
          [community, ids],
        )
      ).rows;
      if (
        !rows.length ||
        rows.length !== new Set(ids).size ||
        rows.some((r) => r.scope !== "public" || !publicTypes.includes(r.type))
      )
        throw new IntegrationError("PRIVATE_RECORD_NOT_EXPORTABLE", 422);
      if (
        (this.options.eventsAuthority ?? process.env.EDITORIAL_MODE) ===
          "github" &&
        rows.some((r) => r.type === "events")
      )
        throw new IntegrationError("EDITORIAL_AUTHORITY_REQUIRED", 409);
      if (rows.some((row) => row.revision !== expectedRevisions[row.id]))
        throw new IntegrationError("DRAFT_VERSION_CONFLICT", 409);
      // The administrator's explicit publish action approves exactly this locked revision; validation/consent failures roll the transaction back.
      for (const r of rows) {
        await db.query(
          "UPDATE records SET state='approved',approved_hash=revision_hash,reviewer_id=$3 WHERE community_id=$1 AND id=$2",
          [community, r.id, actor],
        );
        await auditEvent(
          db,
          { id: actor, communityId: community },
          r.id,
          "administrator_publication_reviewed",
          { revisionHash: r.revision_hash },
        );
      }
      const exported = await this.exporter(db, community, ids);
      const files = this.files(exported.files);
      if (files.length > 25)
        throw new IntegrationError("PUBLICATION_LIMIT", 422);
      const snapshot = await this.transport.snapshot();
      await this.transport.verifyWebsite?.(
        snapshot.commit,
        rows.map((r) => r.type),
      );
      const hashes = await this.transport.hashesDirect?.(
        files,
        snapshot.commit,
      );
      const baseHashes: Record<string, string | null> = {};
      for (const file of files) {
        const actual =
          hashes?.[file.path] ??
          snapshot.records.find(
            (r) => `content/${r.type}/${r.record.id}.json` === file.path,
          )?.record;
        const current =
          typeof actual === "string"
            ? actual
            : actual
              ? hashRevision(actual)
              : null;
        const local = rows.find((r) => r.id === file.record.id);
        const expected =
          file.contentBase64 !== undefined
            ? current === file.hash
              ? current
              : null
            : (local?.source_hash ?? null);
        if (current !== expected)
          throw new IntegrationError("REMOTE_RECORD_CONFLICT", 409);
        baseHashes[file.path] = current;
      }
      await this.validate(snapshot, files);
      const intent = {
        community,
        actor,
        requestHash,
        submissionKey: key,
        subject: identity.subject,
      };
      const operationId = hashValue(intent),
        id = deterministicId(intent);
      const result = {
        bridge: "website-cli",
        publicationMode: "direct",
        operationId,
        subject: identity.subject,
        recordIds: rows.map((r) => r.id),
        revisionHashes: exported.revisionHashes,
        expectedRevisions,
        targetRepo: this.options.config.repository,
        baseBranch: this.options.config.branch,
        baseCommit: snapshot.commit,
        baseHashes,
      };
      const operation = await enqueue(db, {
        communityId: community,
        actorId: actor,
        kind: "changeset",
        subjectId: id,
        key: requestKey,
        payload: result,
        semanticKey: "website-direct:" + requestHash,
      });
      await db.query(
        "INSERT INTO integration_changesets(id,community_id,actor_id,revision_hash,files,result,state) VALUES($1,$2,$3,$4,$5,$6,'prepared') ON CONFLICT(id) DO NOTHING",
        [
          id,
          community,
          actor,
          hashValue(exported.revisionHashes),
          JSON.stringify(exported.files),
          result,
        ],
      );
      await db.query(
        "INSERT INTO integration_requests(community_id,key,request_hash,response) VALUES($1,$2,$3,$4)",
        [community, requestKey, requestHash, operation],
      );
      return {
        ...operation,
        publication: {
          protocol: "direct-main",
          state: "prepared",
          operationId: id,
          repository: result.targetRepo,
          branch: result.baseBranch,
        },
      };
    });
  }
  private async validate(snapshot: any, files: ProposalFile<any>[]) {
    await this.transport.verifyWebsite?.(
      snapshot.commit,
      files.filter((f) => !f.contentBase64).map((f) => f.path.split("/")[1]),
    );
    const records = snapshot.records.filter(
      (r: any) =>
        !files.some((f) => f.path === `content/${r.type}/${r.record.id}.json`),
    );
    for (const f of files.filter((f) => !f.contentBase64))
      records.push({ type: f.path.split("/")[1], record: f.record });
    await validateSnapshot(records);
  }
  private async locked<T>(community: string, id: string, fn: () => Promise<T>) {
    const db = await this.pool.connect();
    let lock = false;
    try {
      lock = (
        await db.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [
          "website-operation:" + community + ":" + id,
        ])
      ).rows[0].locked;
      if (!lock) throw new IntegrationError("OPERATION_IN_PROGRESS", 409);
      return await this.connections.run(db, fn);
    } finally {
      try {
        if (lock)
          await db.query("SELECT pg_advisory_unlock(hashtext($1))", [
            "website-operation:" + community + ":" + id,
          ]);
      } finally {
        db.release();
      }
    }
  }
  async send(community: string, actor: string, id: string, reconcile = false) {
    return this.locked(community, id, async () => {
      const row = (
        await this.db.query(
          "SELECT * FROM integration_changesets WHERE community_id=$1 AND id=$2",
          [community, id],
        )
      ).rows[0];
      if (!row || row.result.bridge !== "website-cli")
        throw new IntegrationError("NOT_FOUND", 404);
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
      const files = this.files(row.files);
      const input: DirectInput = {
        id: row.result.operationId,
        subject: identity.subject,
        repository: row.result.targetRepo,
        branch: row.result.baseBranch,
        baseCommit: row.result.baseCommit,
        baseHashes: row.result.baseHashes,
        files,
      };
      const store = pgDirectStore(this.db, input);
      const check = async () => {
        const versions = (
          await this.db.query(
            "SELECT id,revision FROM records WHERE community_id=$1 AND id=ANY($2::uuid[])",
            [community, row.result.recordIds],
          )
        ).rows;
        if (
          versions.some(
            (v) => v.revision !== row.result.expectedRevisions[v.id],
          )
        )
          throw Object.assign(
            new IntegrationError("DRAFT_VERSION_CONFLICT", 409),
            { remoteMutationAttempted: false },
          );
        await this.identity(community, actor);
        const current = await this.exporter(
          this.db as pg.PoolClient,
          community,
          row.result.recordIds,
        );
        if (
          hashValue(current.revisionHashes) !==
            hashValue(row.result.revisionHashes) ||
          hashValue(this.files(current.files)) !== hashValue(files)
        )
          throw Object.assign(new IntegrationError("APPROVAL_REVOKED", 409), {
            remoteMutationAttempted: false,
          });
      };
      let proof: any;
      if (reconcile) {
        const attempt = await store.latest();
        if (!attempt)
          return {
            state: "prepared",
            publicationMode: "direct",
            changesetId: id,
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
                community,
                id,
                { canRetryExact: true, errorCode: "PUBLICATION_UNCERTAIN" },
              ],
            );
            return {
              state: "uncertain",
              publicationMode: "direct",
              changesetId: id,
              canReconcile: true,
              canRetryExact: true,
            };
          }
          await store.save({ ...attempt, state: "absent" });
          await this.db.query(
            "UPDATE integration_changesets SET state='prepared' WHERE community_id=$1 AND id=$2",
            [community, id],
          );
          return {
            state: "prepared",
            publicationMode: "direct",
            changesetId: id,
            retrySafe: true,
          };
        }
        proof = inspected.commit;
        await store.save({ ...attempt, state: "committed", proof });
      } else {
        const transport = Object.create(
          this.transport,
        ) as EditorialTransport<any>;
        transport.commitDirect = async (i, a) => {
          const db = this.db as pg.PoolClient;
          await db.query("BEGIN");
          try {
            await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
              actor,
            ]);
            await db.query(
              "SELECT id FROM records WHERE community_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
              [community, row.result.recordIds],
            );
            await check();
            const result = await this.transport.commitDirect!(i, a);
            await db.query("COMMIT");
            return result;
          } catch (e) {
            await db.query("ROLLBACK");
            throw e;
          }
        };
        try {
          proof = await publishDirect(
            transport,
            input,
            store,
            check,
            (snapshot) => this.validate(snapshot, files),
          );
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
      await this.db.query(
        "UPDATE integration_changesets SET state='committed',head_sha=$3,result=result||$4::jsonb WHERE community_id=$1 AND id=$2",
        [
          community,
          id,
          proof.commitSha,
          {
            commitSha: proof.commitSha,
            commitUrl: proof.commitUrl,
            expectedHeadOid: proof.parent,
          },
        ],
      );
      const deployment = await publicationDeployment(
        this.transport,
        proof,
        files,
      );
      const state =
        deployment.state === "deployed"
          ? "deployed"
          : deployment.state === "failed"
            ? "deployment_failed"
            : deployment.state === "superseded"
              ? "superseded"
              : "committed";
      await (this.db as pg.PoolClient).query("BEGIN");
      try {
        await this.db.query(
          "SELECT id FROM records WHERE community_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
          [community, row.result.recordIds],
        );
        const latest = await this.transport.snapshot();
        for (const f of files.filter((f) => !f.contentBase64)) {
          const current = latest.records.find(
            (r) => `content/${r.type}/${r.record.id}.json` === f.path,
          )?.record;
          if (current && hashRevision(current) === f.hash)
            await this.db.query(
              "UPDATE records SET source_hash=$3,source_commit=$4 WHERE community_id=$1 AND id=$2",
              [community, f.record.id, f.hash, latest.commit],
            );
        }
        const result = {
          protocol: "direct-main",
          publicationMode: "direct",
          operationId: row.result.operationId,
          changesetId: id,
          commitSha: proof.commitSha,
          commitUrl: proof.commitUrl,
          expectedHeadOid: proof.parent,
          deployment: { ...deployment, sha: deployment.sha ?? proof.commitSha },
          state,
        };
        await this.db.query(
          "UPDATE integration_changesets SET state=$3,head_sha=$4,deployed_sha=$5,result=result||$6::jsonb,updated_at=now() WHERE community_id=$1 AND id=$2",
          [
            community,
            id,
            state,
            proof.commitSha,
            state === "deployed" ? (deployment.sha ?? proof.commitSha) : null,
            result,
          ],
        );
        await this.db.query("COMMIT");
        return result;
      } catch (e) {
        await this.db.query("ROLLBACK");
        throw e;
      }
    });
  }
}
