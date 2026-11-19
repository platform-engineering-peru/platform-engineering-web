import {
  publishDirect,
  publicationDeployment,
  pgDirectStore,
  type DirectInput,
} from "./direct";
import { capabilitiesFor } from "../context";
import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";
import { hashRevision } from "../../shared/content";
import { ApiError, auditEvent, type Session } from "../context";
import { transaction } from "../db";
import {
  compareDraft,
  eventPayload,
  eventProjection,
  recordPath,
  validateSnapshot,
} from "./validation";
import type {
  EditorialConfig,
  EditorialTransport,
  Identity,
  RemoteProposal,
  RemoteSnapshot,
  ProposalFile,
} from "./types";
const fail = (status: number, code: string, message: string) =>
  new ApiError(status, code, message);
export class EditorialService {
  constructor(
    readonly pool: pg.Pool,
    readonly config: EditorialConfig,
    readonly transport: EditorialTransport,
    readonly testTransport = false,
  ) {}
  private connections = new AsyncLocalStorage<pg.PoolClient>();
  private get db(): pg.Pool | pg.PoolClient {
    return this.connections.getStore() ?? this.pool;
  }
  private async atomic<T>(
    operation: (db: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const db = this.connections.getStore();
    if (!db) return transaction(this.pool, operation);
    await db.query("BEGIN");
    try {
      const result = await operation(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }
  private async withSubmissionLock<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect();
    let locked = false;
    try {
      locked = (
        await db.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [
          `editorial-operation:${id}`,
        ])
      ).rows[0].locked;
      if (!locked)
        throw fail(
          409,
          "SUBMISSION_PENDING",
          "Otra solicitud está verificando este envío. No se inició otra operación.",
        );
      return await this.connections.run(db, operation);
    } finally {
      try {
        if (locked)
          await db.query("SELECT pg_advisory_unlock(hashtext($1))", [
            `editorial-operation:${id}`,
          ]);
      } finally {
        db.release();
      }
    }
  }
  guard() {
    if (this.config.mode !== "github" || !this.config.repository)
      throw fail(
        503,
        "UNCONFIGURED",
        "Configura el repositorio editorial de GitHub en este equipo.",
      );
  }
  scope(user: Session) {
    return [user.communityId, this.config.repository, this.config.branch];
  }
  async identity(
    user: Session,
    db: pg.Pool | pg.PoolClient = this.db,
  ): Promise<Identity> {
    const identity = await this.transport.identity();
    const subject = (
      await db.query(
        "SELECT provider_subject FROM users WHERE id=$1 AND community_id=$2 AND active=true",
        [user.id, user.communityId],
      )
    ).rows[0]?.provider_subject;
    if (
      !(this.testTransport && user.isFixture) &&
      (!subject || subject !== identity.subject)
    )
      throw fail(
        403,
        "AUTH_IDENTITY_MISMATCH",
        "La cuenta de GitHub CLI no coincide con esta sesión. Vuelve a verificar tu cuenta.",
      );
    return identity;
  }
  async status(user: Session) {
    const cache = await this.cache(user),
      configured =
        this.config.mode === "github" && Boolean(this.config.repository);
    let identity: Identity | null = null,
      connection = "unconfigured";
    if (configured)
      try {
        identity = await this.identity(user);
        connection = cache?.connection ?? "online";
      } catch {
        connection = cache ? "offline" : "error";
      }
    let rendererReady = true,
      rendererReason: string | null = null;
    if (configured && this.transport.commitDirect) {
      try {
        const head = this.transport.headCommit
          ? await this.transport.headCommit()
          : (await this.transport.snapshot()).commit;
        await this.transport.verifyWebsite?.(head, ["events"]);
      } catch (e: any) {
        rendererReady = false;
        rendererReason = e.code ?? "REMOTE_UNAVAILABLE";
      }
    }
    return {
      rendererReady,
      mode: this.config.mode,
      publicationMode: this.transport.commitDirect ? "direct" : "pull-request",
      ready:
        configured &&
        this.config.remoteWritesEnabled &&
        Boolean(identity) &&
        rendererReady,
      reasons: !configured
        ? ["UNCONFIGURED"]
        : !this.config.remoteWritesEnabled
          ? ["REMOTE_WRITES_DISABLED"]
          : !identity
            ? ["AUTH_UNAVAILABLE"]
            : !rendererReady
              ? [rendererReason ?? "WEBSITE_RENDERER_NOT_READY"]
              : [],
      configured,
      remoteWritesEnabled: configured && this.config.remoteWritesEnabled,
      repository: this.config.repository,
      branch: this.config.branch,
      supportedTypes: ["events"],
      identity,
      headCommit: cache?.commit_sha ?? null,
      lastFetchedAt: cache?.fetched_at ?? null,
      connection,
    };
  }
  async cache(user: Session, db: pg.Pool | pg.PoolClient = this.db) {
    return (
      await db.query(
        "SELECT * FROM editorial_snapshots WHERE community_id=$1 AND repository=$2 AND branch=$3",
        this.scope(user),
      )
    ).rows[0];
  }
  snapshotDTO(cache: any) {
    return {
      commit: cache.commit_sha,
      fetchedAt: new Date(cache.fetched_at).toISOString(),
      records: cache.records
        .filter((r: any) => r.type === "events")
        .map((r: any) => r.record),
      recordHashes: Object.fromEntries(
        cache.records
          .filter((r: any) => r.type === "events")
          .map((r: any) => [r.record.id, hashRevision(r.record)]),
      ),
      references: {
        speakers: cache.records
          .filter(
            (r: any) => r.type === "speakers" && r.record.status !== "archived",
          )
          .map((r: any) => ({ id: r.record.id, name: r.record.name })),
      },
      stale: cache.connection !== "online",
    };
  }
  async events(user: Session) {
    this.guard();
    const cache = await this.cache(user);
    if (!cache)
      throw fail(
        503,
        "CACHE_EMPTY",
        "Actualiza desde GitHub para obtener el contenido aprobado.",
      );
    return this.snapshotDTO(cache);
  }
  async fetch(
    user: Session,
    db: pg.Pool | pg.PoolClient = this.db,
  ): Promise<RemoteSnapshot> {
    this.guard();
    try {
      await this.identity(user, db);
      const remote = await this.transport.snapshot();
      await validateSnapshot(remote.records);
      await this.identity(user, db);
      return remote;
    } catch (error) {
      await db.query(
        "UPDATE editorial_snapshots SET connection='offline' WHERE community_id=$1 AND repository=$2 AND branch=$3",
        this.scope(user),
      );
      throw error;
    }
  }
  async pull(user: Session) {
    try {
      await this.atomic(async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `editorial-pull:${this.scope(user).join(":")}`,
        ]);
        const remote = await this.fetch(user, db);
        await db.query(
          "INSERT INTO editorial_snapshots(community_id,repository,branch,commit_sha,records) VALUES($1,$2,$3,$4,$5) ON CONFLICT(community_id,repository,branch) DO UPDATE SET commit_sha=excluded.commit_sha,records=excluded.records,fetched_at=now(),connection='online'",
          [...this.scope(user), remote.commit, JSON.stringify(remote.records)],
        );
      });
    } catch (error) {
      await this.db.query(
        "UPDATE editorial_snapshots SET connection='offline' WHERE community_id=$1 AND repository=$2 AND branch=$3",
        this.scope(user),
      );
      throw error;
    }
    return this.events(user);
  }
  async draftRow(
    user: Session,
    id: string,
    db: pg.Pool | pg.PoolClient = this.db,
    lock = false,
  ) {
    const row = (
      await db.query(
        `SELECT * FROM editorial_drafts WHERE id=$1 AND community_id=$2 AND actor_id=$3 AND repository=$4 AND branch=$5${lock ? " FOR UPDATE" : ""}`,
        [
          id,
          user.communityId,
          user.id,
          this.config.repository,
          this.config.branch,
        ],
      )
    ).rows[0];
    if (!row) throw fail(404, "NOT_FOUND", "Borrador local no encontrado.");
    return row;
  }
  async draftDTO(row: any) {
    const proposal = row.proposal_id
      ? (
          await this.db.query("SELECT * FROM editorial_proposals WHERE id=$1", [
            row.proposal_id,
          ])
        ).rows[0]
      : null;
    return {
      id: row.id,
      type: "events",
      recordId: row.record_id,
      baseCommit: row.base_commit,
      baseRecordHash: row.base_record_hash,
      version: row.version,
      payload: row.payload,
      desiredStatus: row.desired_status,
      updatedAt: new Date(row.updated_at).toISOString(),
      state:
        proposal &&
        ["preparing", "sending", "unknown", "retryable"].includes(
          proposal.state,
        )
          ? proposal.state
          : row.state,
      ...(proposal ? { submission: this.submissionDTO(proposal) } : {}),
      submissionHistory: (
        await this.db.query(
          "SELECT DISTINCT p.* FROM editorial_submission_drafts d JOIN editorial_proposals p ON p.id=d.proposal_id WHERE d.draft_id=$1 AND p.actor_id=$2 AND p.community_id=$3 ORDER BY p.created_at DESC",
          [row.id, row.actor_id, row.community_id],
        )
      ).rows.map((p) => this.submissionDTO(p)),
      ...(row.conflict ? { conflict: row.conflict } : {}),
      ...(proposal?.remote && proposal.publication_mode !== "direct"
        ? {
            proposal: {
              number: proposal.remote.number,
              url: proposal.remote.url,
              headCommit: proposal.remote.headCommit,
              state: proposal.state,
              mergeCommit: proposal.remote.mergeCommit,
              reviewDecision: proposal.remote.reviewDecision,
              checks: proposal.remote.checks,
            },
          }
        : {}),
    };
  }
  async drafts(user: Session) {
    this.guard();
    const rows = (
      await this.db.query(
        "SELECT * FROM editorial_drafts WHERE community_id=$1 AND actor_id=$2 AND repository=$3 AND branch=$4 ORDER BY updated_at DESC",
        [user.communityId, user.id, this.config.repository, this.config.branch],
      )
    ).rows;
    return { items: await Promise.all(rows.map((row) => this.draftDTO(row))) };
  }
  async save(
    user: Session,
    id: string,
    input: {
      recordId: string;
      baseCommit: string;
      baseRecordHash: string | null;
      payload: unknown;
      desiredStatus: "published" | "archived";
    },
    expected?: number,
  ) {
    this.guard();
    const payload = eventPayload(input.payload);
    await this.atomic(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `editorial-draft:${id}`,
      ]);
      const existing = (
        await db.query(
          "SELECT * FROM editorial_drafts WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.actor_id !== user.id ||
          existing.community_id !== user.communityId ||
          existing.repository !== this.config.repository ||
          existing.branch !== this.config.branch
        )
          throw fail(404, "NOT_FOUND", "Borrador local no encontrado.");
        if (!expected)
          throw fail(
            428,
            "PRECONDITION_REQUIRED",
            "Envía If-Match con la versión del borrador local.",
          );
        if (existing.version !== expected)
          throw fail(
            409,
            "DRAFT_VERSION_CONFLICT",
            "El borrador cambió en este equipo. Conserva tu copia y recarga.",
          );
        if (
          existing.record_id !== input.recordId ||
          existing.base_commit !== input.baseCommit ||
          existing.base_record_hash !== input.baseRecordHash
        )
          throw fail(
            409,
            "DRAFT_BASE_IMMUTABLE",
            "La base original se conserva. Resuelve el conflicto en un nuevo borrador.",
          );
        await this.guardPending(existing, db);
        await db.query(
          "UPDATE editorial_drafts SET payload=$2,desired_status=$3,version=version+1,state='local',conflict=NULL,proposal_id=NULL,updated_at=now() WHERE id=$1",
          [id, JSON.stringify(payload), input.desiredStatus],
        );
      } else {
        if (expected)
          throw fail(
            409,
            "DRAFT_VERSION_CONFLICT",
            "El borrador ya no existe. Conserva tu copia local.",
          );
        const cache = await this.cache(user, db);
        if (!cache || cache.commit_sha !== input.baseCommit)
          throw fail(
            409,
            "BASE_COMMIT_UNKNOWN",
            "Actualiza el contenido aprobado antes de crear un borrador con esta base.",
          );
        const base =
          cache.records.find(
            (r: any) => r.type === "events" && r.record.id === input.recordId,
          )?.record ?? null;
        if ((base ? hashRevision(base) : null) !== input.baseRecordHash)
          throw fail(
            409,
            "BASE_HASH_MISMATCH",
            "La revisión aprobada no coincide con la base indicada.",
          );
        await db.query(
          "INSERT INTO editorial_drafts(id,community_id,actor_id,repository,branch,type,record_id,base_commit,base_record_hash,base_record,payload,desired_status) VALUES($1,$2,$3,$4,$5,'events',$6,$7,$8,$9,$10,$11)",
          [
            id,
            user.communityId,
            user.id,
            this.config.repository,
            this.config.branch,
            input.recordId,
            input.baseCommit,
            input.baseRecordHash,
            base ? JSON.stringify(base) : null,
            JSON.stringify(payload),
            input.desiredStatus,
          ],
        );
      }
      await auditEvent(db, user, input.recordId, "editorial_draft_saved", {
        draftId: id,
        version: existing ? existing.version + 1 : 1,
        baseCommit: input.baseCommit,
      });
    });
    return this.draftDTO(await this.draftRow(user, id));
  }
  async guardPending(draft: any, db: pg.Pool | pg.PoolClient = this.db) {
    if (!draft.proposal_id) return;
    const p = (
      await db.query("SELECT state FROM editorial_proposals WHERE id=$1", [
        draft.proposal_id,
      ])
    ).rows[0];
    if (p && ["preparing", "sending", "unknown"].includes(p.state))
      throw fail(
        409,
        "SUBMISSION_PENDING",
        "Hay un envío pendiente de verificación. Conserva tu texto y concilia antes de cambiar o descartar este borrador.",
      );
  }
  submissionDTO(p: any) {
    return {
      id: p.id,
      state: p.state,
      publicationMode: p.publication_mode ?? "pull-request",
      protocol: p.publication_mode === "direct" ? "direct-main" : "legacy-pr",
      branch: p.publication_mode === "direct" ? p.branch : `editorial/${p.id}`,
      ...(p.publication_mode === "direct" && p.remote
        ? {
            commitSha: p.remote.commitSha,
            commitUrl: p.remote.commitUrl,
            deployment: p.remote.deployment,
          }
        : {}),
      errorCode: p.error_code ?? null,
      reconcileRequired: ["preparing", "sending", "unknown"].includes(p.state),
      canEdit: !["preparing", "sending", "unknown"].includes(p.state),
      canRetryExact:
        p.publication_mode === "direct" &&
        p.state === "unknown" &&
        p.recovery?.canRetryExact === true,
      ...(p.remote && p.publication_mode !== "direct"
        ? {
            proposal: {
              number: p.remote.number,
              url: p.remote.url,
              headCommit: p.remote.headCommit,
              state: p.state,
              mergeCommit: p.remote.mergeCommit,
              reviewDecision: p.remote.reviewDecision,
              checks: p.remote.checks,
            },
          }
        : {}),
    };
  }
  async submissions(user: Session) {
    this.guard();
    return {
      items: (
        await this.db.query(
          "SELECT * FROM editorial_proposals WHERE community_id=$1 AND actor_id=$2 AND repository=$3 AND branch=$4 ORDER BY created_at DESC",
          [
            user.communityId,
            user.id,
            this.config.repository,
            this.config.branch,
          ],
        )
      ).rows.map((p) => this.submissionDTO(p)),
    };
  }
  async submissionRow(user: Session, id: string) {
    const p = (
      await this.db.query(
        "SELECT * FROM editorial_proposals WHERE id=$1 AND community_id=$2 AND actor_id=$3 AND repository=$4 AND branch=$5",
        [
          id,
          user.communityId,
          user.id,
          this.config.repository,
          this.config.branch,
        ],
      )
    ).rows[0];
    if (!p) throw fail(404, "NOT_FOUND", "Envío local no encontrado.");
    return p;
  }
  async reconcileSubmission(user: Session, id: string) {
    this.guard();
    await this.reconcileProposal(user, await this.submissionRow(user, id));
    return this.submissionDTO(await this.submissionRow(user, id));
  }
  async discard(user: Session, id: string, expected: number) {
    this.guard();
    await this.atomic(async (db) => {
      const draft = await this.draftRow(user, id, db, true);
      if (draft.version !== expected)
        throw fail(
          409,
          "DRAFT_VERSION_CONFLICT",
          "No se descartó: recarga la versión local.",
        );
      await this.guardPending(draft, db);
      await db.query("DELETE FROM editorial_drafts WHERE id=$1", [id]);
    });
    return { discarded: true, remoteUnchanged: true };
  }
  verifyProposal(remote: RemoteProposal, proposal: any) {
    const files: ProposalFile[] = proposal.manifest.map((m: any) => ({
      path: m.path,
      record: m.record,
      hash: m.hash,
    }));
    const signature = (f: ProposalFile[]) =>
      hashRevision(
        f
          .map((x) => ({ path: x.path, record: x.record }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      );
    if (
      remote.authorSubject !== proposal.actor_subject ||
      remote.branch !== `editorial/${proposal.id}` ||
      remote.baseBranch !== this.config.branch ||
      remote.marker !== proposal.id ||
      signature(remote.files) !== signature(files)
    )
      throw fail(
        409,
        "PROPOSAL_CONTENT_MISMATCH",
        "La rama o el contenido remoto no coincide con esta propuesta. No se reutilizó.",
      );
  }
  async recordProposal(proposal: any, remote: RemoteProposal) {
    this.verifyProposal(remote, proposal);
    let state =
      remote.state === "closed"
        ? "closed"
        : remote.state === "merged"
          ? "merged"
          : "proposed";
    if (state === "merged") {
      if (!remote.mergeCommit)
        throw fail(
          409,
          "PROPOSAL_MERGE_UNVERIFIED",
          "GitHub todavía no confirmó el commit integrado.",
        );
      const merged = await this.transport.snapshot(remote.mergeCommit);
      await validateSnapshot(merged.records);
      if (merged.commit !== remote.mergeCommit)
        throw fail(
          409,
          "PROPOSAL_MERGE_UNVERIFIED",
          "No se verificó el commit integrado indicado por GitHub.",
        );
      for (const f of proposal.manifest) {
        const found = merged.records.find(
          (r) => recordPath(r.type, r.record.id) === f.path,
        );
        if (!found || hashRevision(found.record) !== f.hash)
          throw fail(
            409,
            "PROPOSAL_MERGE_UNVERIFIED",
            "La integración no contiene la revisión propuesta. El borrador se conserva.",
          );
      }
    }
    await this.atomic(async (db) => {
      await db.query(
        "UPDATE editorial_proposals SET state=$2,remote=$3,error_code=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
        [proposal.id, state, JSON.stringify(remote)],
      );
      await db.query(
        "UPDATE editorial_drafts SET state=$2,conflict=NULL WHERE proposal_id=$1",
        [proposal.id, state],
      );
    });
    return remote;
  }
  async propose(
    user: Session,
    selections: { id: string; expectedVersion: number }[],
    key: string,
  ) {
    this.guard();
    if (!this.config.remoteWritesEnabled)
      throw fail(
        403,
        "REMOTE_WRITES_DISABLED",
        "Las propuestas remotas están deshabilitadas. Habilítalas solo con autorización.",
      );
    const identity = await this.identity(user),
      inputHash = hashRevision(
        selections.slice().sort((a, b) => a.id.localeCompare(b.id)),
      );
    const previous = (
      await this.db.query(
        "SELECT p.*,r.request_hash AS key_hash FROM editorial_requests r JOIN editorial_proposals p ON p.id=r.proposal_id WHERE r.community_id=$1 AND r.actor_id=$2 AND r.key=$3",
        [user.communityId, user.id, key],
      )
    ).rows[0];
    if (previous) {
      if (
        previous.repository !== this.config.repository ||
        previous.branch !== this.config.branch
      )
        throw fail(
          409,
          "IDEMPOTENCY_SCOPE_CONFLICT",
          "Esta clave pertenece a otro repositorio editorial.",
        );
      if (previous.key_hash !== inputHash)
        throw fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Esta clave ya corresponde a otra revisión.",
        );
      if (
        previous.publication_mode === "direct" &&
        previous.state === "unknown"
      ) {
        return this.withSubmissionLock(previous.id, async () => {
          try {
            await this.publishSubmissionDirect(
              user,
              await this.submissionRow(user, previous.id),
              false,
            );
          } catch (e: any) {
            if (e.code === "REMOTE_RECORD_CONFLICT")
              await this.db.query(
                "UPDATE editorial_proposals SET state='conflict',error_code=$2,lease_until=NULL,updated_at=now() WHERE id=$1",
                [previous.id, e.code],
              );
            throw e;
          }
          return this.batchDTO(user, selections, previous.id);
        });
      }
      if (!["preparing", "retryable"].includes(previous.state)) {
        await this.reconcileProposal(user, previous);
        return this.batchDTO(user, selections, previous.id);
      }
    }
    const remote = await this.fetch(user);
    if (this.transport.commitDirect)
      await this.transport.verifyWebsite?.(remote.commit, ["events"]);
    const prepared = await this.atomic(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `editorial-submit:${user.communityId}:${user.id}`,
      ]);
      const drafts = [];
      const seen = new Set<string>();
      for (const selected of selections
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))) {
        const draft = await this.draftRow(user, selected.id, db, true);
        if (draft.version !== selected.expectedVersion)
          throw fail(
            409,
            "DRAFT_VERSION_CONFLICT",
            "La revisión local cambió antes de proponer.",
          );
        if (seen.has(draft.record_id))
          throw fail(
            409,
            "DUPLICATE_RECORD",
            "Selecciona un solo borrador por evento.",
          );
        seen.add(draft.record_id);
        drafts.push(draft);
      }
      let conflict = false;
      for (const draft of drafts) {
        const current =
          remote.records.find(
            (r) => r.type === "events" && r.record.id === draft.record_id,
          )?.record ?? null;
        if (compareDraft(draft.base_record, current)) {
          conflict = true;
          await db.query(
            "UPDATE editorial_drafts SET state='conflict',conflict=$2 WHERE id=$1",
            [
              draft.id,
              JSON.stringify({
                base: draft.base_record,
                remote: current,
                local: draft.payload,
                remoteCommit: remote.commit,
              }),
            ],
          );
        }
      }
      if (conflict) return { conflict: true } as const;
      const manifest: any[] = [];
      for (const draft of drafts) {
        const record = await eventProjection(
          draft.record_id,
          draft.payload,
          draft.desired_status,
        );
        manifest.push({
          draftId: draft.id,
          version: draft.version,
          recordId: draft.record_id,
          path: recordPath("events", draft.record_id),
          record,
          hash: hashRevision(record),
          baseRecordHash: draft.base_record_hash,
          baseCommit: draft.base_commit,
        });
      }
      const candidate = remote.records.filter(
        (r) =>
          !manifest.some(
            (m) => r.type === "events" && r.record.id === m.recordId,
          ),
      );
      candidate.push(
        ...manifest.map((m) => ({ type: "events", record: m.record })),
      );
      await validateSnapshot(candidate);
      const id = hashRevision({
        communityId: user.communityId,
        publicationMode: this.transport.commitDirect
          ? "direct"
          : "pull-request",
        ...(this.transport.commitDirect ? { submissionKey: key } : {}),
        repository: this.config.repository,
        branch: this.config.branch,
        subject: identity.subject,
        files: manifest
          .map((m) => ({
            path: m.path,
            record: m.record,
            baseRecordHash: m.baseRecordHash,
            baseCommit: m.baseCommit,
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      });
      await db.query(
        "INSERT INTO editorial_proposals(id,community_id,actor_id,repository,branch,base_commit,request_hash,actor_subject,manifest,state,publication_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'preparing',$10) ON CONFLICT(id) DO NOTHING",
        [
          id,
          user.communityId,
          user.id,
          this.config.repository,
          this.config.branch,
          remote.commit,
          inputHash,
          identity.subject,
          JSON.stringify(manifest),
          this.transport.commitDirect ? "direct" : "pull-request",
        ],
      );
      const saved = (
        await db.query(
          "SELECT * FROM editorial_proposals WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (saved.actor_id !== user.id || saved.community_id !== user.communityId)
        throw fail(
          409,
          "PROPOSAL_OWNER_CONFLICT",
          "Esta propuesta pertenece a otra sesión local.",
        );
      await db.query(
        "INSERT INTO editorial_requests(community_id,actor_id,key,request_hash,proposal_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [user.communityId, user.id, key, inputHash, id],
      );
      const bound = (
        await db.query(
          "SELECT * FROM editorial_requests WHERE community_id=$1 AND actor_id=$2 AND key=$3",
          [user.communityId, user.id, key],
        )
      ).rows[0];
      if (bound.request_hash !== inputHash || bound.proposal_id !== id)
        throw fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "La clave ya está vinculada a otra propuesta.",
        );
      for (const draft of drafts) {
        if (draft.proposal_id && draft.proposal_id !== id) {
          const pending = (
            await db.query(
              "SELECT state FROM editorial_proposals WHERE id=$1",
              [draft.proposal_id],
            )
          ).rows[0];
          if (
            pending &&
            [
              "preparing",
              "sending",
              "unknown",
              "retryable",
              "proposed",
            ].includes(pending.state)
          )
            throw fail(
              409,
              "SUBMISSION_PENDING",
              "Este borrador ya pertenece a otra propuesta pendiente. No se sobrescribió su seguimiento.",
            );
        }
        await db.query(
          "INSERT INTO editorial_submission_drafts(proposal_id,draft_id,version,record_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [id, draft.id, draft.version, draft.record_id],
        );
      }
      if (saved.state === "retryable") {
        const nextBase =
          saved.recovery?.state === "absent"
            ? remote.commit
            : saved.base_commit;
        await db.query(
          "UPDATE editorial_proposals SET state='preparing',base_commit=$2,error_code=NULL WHERE id=$1",
          [id, nextBase],
        );
        saved.state = "preparing";
        saved.base_commit = nextBase;
      }
      await db.query(
        "UPDATE editorial_drafts SET proposal_id=$2 WHERE id=ANY($1::uuid[])",
        [drafts.map((d) => d.id), id],
      );
      return { proposal: saved } as const;
    });
    if ("conflict" in prepared)
      throw fail(
        409,
        "REMOTE_RECORD_CONFLICT",
        "El contenido aprobado cambió. Compara las versiones; tu borrador local está conservado.",
      );
    const proposal = prepared.proposal;
    if (
      [
        "sending",
        "unknown",
        "proposed",
        "merged",
        "closed",
        "committed",
        "deployed",
        "deployment_failed",
      ].includes(proposal.state)
    ) {
      await this.reconcileProposal(user, proposal);
      return this.batchDTO(user, selections, proposal.id);
    }
    return this.withSubmissionLock(proposal.id, async () => {
      const claimed = await this.db.query(
        "UPDATE editorial_proposals SET state='sending',lease_until=now()+interval '10 minutes' WHERE id=$1 AND state='preparing' RETURNING id",
        [proposal.id],
      );
      if (!claimed.rowCount)
        throw fail(
          409,
          "SUBMISSION_PENDING",
          "Otra solicitud está verificando este envío.",
        );
      if (proposal.publication_mode === "direct") {
        try {
          await this.publishSubmissionDirect(user, proposal, false);
        } catch (e: any) {
          await this.db.query(
            "UPDATE editorial_proposals SET state=$2,error_code=$3,lease_until=NULL WHERE id=$1",
            [
              proposal.id,
              e.code === "PUBLICATION_UNCERTAIN"
                ? "unknown"
                : e.code === "REMOTE_RECORD_CONFLICT"
                  ? "conflict"
                  : "retryable",
              e.code ?? "REMOTE_UNAVAILABLE",
            ],
          );
          throw e;
        }
        return this.batchDTO(user, selections, proposal.id);
      }
      let createAttempted = false;
      try {
        let found = await this.transport.findProposal(
          `editorial/${proposal.id}`,
        );
        if (!found) {
          createAttempted = true;
          found = await this.transport.createProposal(
            this.proposalInput(proposal, identity.subject),
          );
        }
        await this.recordProposal(proposal, found);
      } catch (error) {
        const knownUnsent =
          !createAttempted || (error as any)?.remoteMutationAttempted === false;
        await this.db.query(
          "UPDATE editorial_proposals SET state=$2,error_code=$3,lease_until=NULL,updated_at=now() WHERE id=$1 AND state='sending'",
          [
            proposal.id,
            knownUnsent ? "retryable" : "unknown",
            error instanceof ApiError ? error.code : "REMOTE_UNAVAILABLE",
          ],
        );
        throw error instanceof ApiError
          ? error
          : fail(
              503,
              knownUnsent ? "REMOTE_UNAVAILABLE" : "PROPOSAL_UNCERTAIN",
              knownUnsent
                ? "No se envió la propuesta. Conservamos el intento para reintentar con la misma identidad."
                : "No se pudo confirmar la respuesta de GitHub. Conservamos el envío para conciliarlo sin duplicar.",
            );
      }
      return this.batchDTO(user, selections, proposal.id);
    });
  }
  async batchDTO(
    user: Session,
    selections: { id: string }[],
    proposalId: string,
  ): Promise<{ items: any[]; proposal?: any; publication?: any }> {
    const operation = (
      await this.db.query("SELECT * FROM editorial_proposals WHERE id=$1", [
        proposalId,
      ])
    ).rows[0];
    return {
      items: await Promise.all(
        selections.map(async (x) =>
          this.draftDTO(await this.draftRow(user, x.id)),
        ),
      ),
      ...(operation?.publication_mode === "direct"
        ? { publication: this.submissionDTO(operation) }
        : { proposal: operation?.remote ?? null }),
    };
  }

  proposalInput(proposal: any, subject: string) {
    return {
      subject,
      id: proposal.id,
      branch: `editorial/${proposal.id}`,
      baseCommit: proposal.base_commit,
      files: proposal.manifest.map((m: any) => ({
        path: m.path,
        record: m.record,
        hash: m.hash,
      })),
      title: "Update community events",
    };
  }
  private async publishSubmissionDirect(
    user: Session,
    proposal: any,
    reconcileOnly: boolean,
  ) {
    const identity = await this.identity(user);
    const input: DirectInput = {
      id: proposal.id,
      subject: identity.subject,
      repository: proposal.repository,
      branch: proposal.branch,
      baseCommit: proposal.base_commit,
      baseHashes: Object.fromEntries(
        proposal.manifest.map((f: any) => [f.path, f.baseRecordHash ?? null]),
      ),
      files: proposal.manifest.map((f: any) => ({
        path: f.path,
        record: f.record,
        hash: f.hash,
      })),
    };
    if (
      identity.subject !== proposal.actor_subject ||
      proposal.repository !== this.config.repository ||
      proposal.branch !== this.config.branch
    )
      throw fail(
        409,
        "TARGET_REPOSITORY_CHANGED",
        "Cambió el destino o la cuenta.",
      );
    const store = pgDirectStore(this.db, input);
    const check = async () => {
      const row = (
        await this.db.query(
          "SELECT * FROM users WHERE community_id=$1 AND id=$2 AND active=true",
          [user.communityId, user.id],
        )
      ).rows[0];
      if (
        !row ||
        !capabilitiesFor(row.roles?.length ? row.roles : [row.role]).some(
          (c) => c === "*" || c === "content:publish",
        )
      )
        throw Object.assign(
          fail(403, "ACTOR_REVOKED", "Tu permiso de publicación cambió."),
          { remoteMutationAttempted: false },
        );
      await this.identity(user);
      for (const f of proposal.manifest) {
        const draft = await this.draftRow(user, f.draftId);
        if (draft.version !== f.version)
          throw Object.assign(
            fail(409, "DRAFT_VERSION_CONFLICT", "El borrador cambió."),
            { remoteMutationAttempted: false },
          );
      }
    };
    let proof: any;
    if (reconcileOnly) {
      const attempt = await store.latest();
      if (!attempt) return;
      const inspected = await this.transport.inspectDirect!(input, attempt);
      if (inspected.state !== "committed") {
        if (
          inspected.state === "head-unchanged" ||
          attempt.state === "committed"
        ) {
          await this.db.query(
            "UPDATE editorial_proposals SET state='unknown',lease_until=NULL,recovery=$2 WHERE id=$1",
            [proposal.id, { state: "head-unchanged", canRetryExact: true }],
          );
          throw fail(
            503,
            "PUBLICATION_UNCERTAIN",
            "El envío puede seguir activo. Solo se permite repetir el mismo intento.",
          );
        }
        await store.save({ ...attempt, state: "absent" });
        await this.db.query(
          "UPDATE editorial_proposals SET state='retryable',lease_until=NULL,recovery=$2 WHERE id=$1",
          [proposal.id, { state: "absent", publicationMode: "direct" }],
        );
        return;
      }
      proof = inspected.commit;
      await store.save({ ...attempt, state: "committed", proof });
    } else {
      const transport = Object.create(this.transport) as EditorialTransport;
      transport.commitDirect = async (i, a) => {
        const db = this.db as pg.PoolClient;
        await db.query("BEGIN");
        try {
          await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
            user.id,
          ]);
          await db.query(
            "SELECT id FROM editorial_drafts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
            [proposal.manifest.map((f: any) => f.draftId)],
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
      proof = await publishDirect(
        transport,
        input,
        store,
        check,
        async (snapshot) => {
          await this.transport.verifyWebsite?.(snapshot.commit, ["events"]);
          const candidate = snapshot.records.filter(
            (r: any) =>
              !input.files.some(
                (f) => f.path === recordPath(r.type, r.record.id),
              ),
          );
          candidate.push(
            ...input.files.map((f) => ({ type: "events", record: f.record })),
          );
          await validateSnapshot(candidate);
        },
      );
    }
    await this.db.query(
      "UPDATE editorial_proposals SET state='committed',remote=$2,lease_until=NULL WHERE id=$1",
      [
        proposal.id,
        {
          publicationMode: "direct",
          commitSha: proof.commitSha,
          commitUrl: proof.commitUrl,
          expectedHeadOid: proof.parent,
          deployment: { state: "pending" },
        },
      ],
    );
    const deployment = await publicationDeployment(
      this.transport,
      proof,
      input.files,
    );
    const state =
      deployment.state === "deployed"
        ? "deployed"
        : deployment.state === "failed"
          ? "deployment_failed"
          : deployment.state === "superseded"
            ? "superseded"
            : "committed";
    const latest = await this.transport.snapshot();
    await this.atomic(async (db) => {
      await db.query(
        "UPDATE editorial_proposals SET state=$2,remote=$3,error_code=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
        [
          proposal.id,
          state,
          {
            publicationMode: "direct",
            protocol: "direct-main",
            commitSha: proof.commitSha,
            commitUrl: proof.commitUrl,
            expectedHeadOid: proof.parent,
            deployment: {
              ...deployment,
              sha: deployment.sha ?? proof.commitSha,
            },
          },
        ],
      );
      for (const f of proposal.manifest) {
        const current = latest.records.find(
          (r) => r.type === "events" && r.record.id === f.recordId,
        )?.record;
        if (!current || hashRevision(current) !== f.hash) continue;
        await db.query(
          "UPDATE editorial_drafts SET state=$2,base_commit=$3,base_record_hash=$4,base_record=$5,version=version+1,conflict=NULL WHERE id=$1 AND version=$6 AND proposal_id=$7",
          [
            f.draftId,
            state,
            latest.commit,
            f.hash,
            current,
            f.version,
            proposal.id,
          ],
        );
      }
    });
  }
  async reconcileProposal(user: Session, candidate: any) {
    return this.withSubmissionLock(candidate.id, async () => {
      const proposal = await this.submissionRow(user, candidate.id);
      const identity = await this.identity(user);
      if (
        proposal.publication_mode !== "direct" &&
        proposal.state === "sending" &&
        proposal.lease_until &&
        new Date(proposal.lease_until).getTime() > Date.now()
      )
        throw fail(
          409,
          "SUBMISSION_PENDING",
          "El envío sigue activo en este equipo. Espera a que termine antes de conciliar.",
        );
      if (proposal.publication_mode === "direct") {
        await this.publishSubmissionDirect(user, proposal, true);
        return;
      }
      const remote = await this.transport.findProposal(
        `editorial/${proposal.id}`,
      );
      if (remote) {
        await this.recordProposal(proposal, remote);
        return;
      }
      if (["merged", "closed", "proposed"].includes(proposal.state))
        throw fail(
          409,
          "PROPOSAL_UNCERTAIN",
          "GitHub no confirma la propuesta anteriormente conocida. No se repitió el envío.",
        );
      const proof = await this.transport.inspectProposal(
        this.proposalInput(proposal, identity.subject),
      );
      await this.db.query(
        "UPDATE editorial_proposals SET state='retryable',recovery=$2,lease_until=NULL,error_code=NULL,updated_at=now() WHERE id=$1 AND state IN('preparing','sending','unknown','retryable')",
        [proposal.id, JSON.stringify(proof)],
      );
    });
  }
  async reconcile(user: Session, id: string) {
    this.guard();
    const draft = await this.draftRow(user, id);
    if (!draft.proposal_id) return this.draftDTO(draft);
    const proposal = (
      await this.db.query("SELECT * FROM editorial_proposals WHERE id=$1", [
        draft.proposal_id,
      ])
    ).rows[0];
    await this.reconcileProposal(user, proposal);
    return this.draftDTO(await this.draftRow(user, id));
  }
}
