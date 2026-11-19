import { hashRevision } from "../../shared/content";
import { ApiError } from "../context";
import type { EditorialTransport, ProposalFile } from "./types";
export interface DirectInput<T = any> {
  id: string;
  subject: string;
  repository: string;
  branch: string;
  baseCommit: string;
  baseHashes: Record<string, string | null>;
  files: ProposalFile<T>[];
}
export interface DirectAttempt {
  id: string;
  operationId: string;
  expectedHeadOid: string;
  digest: string;
  state: "sending" | "uncertain" | "absent" | "committed";
  proof?: DirectCommit;
}
export interface DirectCommit {
  commitSha: string;
  commitUrl: string;
  parent: string;
  attemptId: string;
}
export type DirectInspection =
  | { state: "committed"; commit: DirectCommit }
  | { state: "head-unchanged"; headCommit: string }
  | { state: "absent-proven"; headCommit: string };
export interface DirectStore {
  latest(): Promise<DirectAttempt | null>;
  save(attempt: DirectAttempt): Promise<void>;
}
const error = (code: string, status = 409) =>
  Object.assign(
    new ApiError(
      status,
      code,
      "La publicación se conserva. Comprueba los cambios y vuelve a conciliar.",
    ),
    { ambiguous: code === "PUBLICATION_UNCERTAIN" },
  );
export function directDigest(input: DirectInput) {
  return hashRevision({
    id: input.id,
    subject: input.subject,
    repository: input.repository,
    branch: input.branch,
    baseCommit: input.baseCommit,
    baseHashes: input.baseHashes,
    files: input.files
      .map((f) => ({
        path: f.path,
        record: f.record,
        contentBase64: f.contentBase64 ?? null,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  });
}
/** One immutable intent; every retry has a durable expected-head attempt. */
export async function publishDirect<T>(
  transport: EditorialTransport<T>,
  input: DirectInput<T>,
  store: DirectStore,
  beforeWrite: () => Promise<void>,
  validateSnapshot?: (snapshot: any) => Promise<void>,
): Promise<DirectCommit> {
  if (!transport.commitDirect || !transport.inspectDirect)
    throw error("DIRECT_PUBLICATION_UNAVAILABLE", 503);
  let outcomeUnproven = true;
  try {
    const digest = directDigest(input);
    for (let retry = 0; retry < 3; retry++) {
      const previous = await store.latest();
      outcomeUnproven = Boolean(
        previous &&
        ["sending", "uncertain", "committed"].includes(previous.state),
      );
      let reuse: DirectAttempt | null = null;
      if (previous) {
        if (previous.digest !== digest || previous.operationId !== input.id)
          throw error("IDEMPOTENCY_CONFLICT");
        const inspection = await transport.inspectDirect(input, previous);
        if (inspection.state === "committed") {
          await store.save({
            ...previous,
            state: "committed",
            proof: inspection.commit,
          });
          return inspection.commit;
        }
        if (previous.state === "committed")
          throw error("PUBLICATION_UNCERTAIN", 503);
        if (inspection.state === "head-unchanged") reuse = previous;
        else {
          await store.save({ ...previous, state: "absent" });
          outcomeUnproven = false;
        }
      }
      // A possibly still-running request is never rebased: inspect at its immutable H and replay ONLY the identical CAS.
      const snapshot = await transport.snapshot(reuse?.expectedHeadOid);
      await validateSnapshot?.(snapshot);
      if (reuse && snapshot.commit !== reuse.expectedHeadOid)
        throw error("PUBLICATION_UNCERTAIN", 503);
      const remoteHashes = await transport.hashesDirect?.(
        input.files,
        snapshot.commit,
      );
      for (const file of input.files) {
        const current =
          snapshot.records.find(
            (r) =>
              `content/${r.type}/${(r.record as any).id}.json` === file.path,
          )?.record ?? null;
        const actual = remoteHashes
          ? remoteHashes[file.path]
          : current
            ? hashRevision(current)
            : null;
        if (actual !== input.baseHashes[file.path])
          throw Object.assign(error("REMOTE_RECORD_CONFLICT"), {
            remoteMutationAttempted: false,
            conflicts: [
              {
                path: file.path,
                baseHash: input.baseHashes[file.path],
                remoteHash: actual,
                localHash: file.hash,
              },
            ],
          });
      }
      const attempt: DirectAttempt = reuse
        ? { ...reuse, state: "sending" }
        : {
            id: hashRevision({
              operation: input.id,
              head: snapshot.commit,
              digest,
            }),
            operationId: input.id,
            expectedHeadOid: snapshot.commit,
            digest,
            state: "sending",
          };
      const replayAmbiguous = Boolean(
        reuse && ["sending", "uncertain"].includes(reuse.state),
      );
      try {
        await beforeWrite();
      } catch (e: any) {
        if (replayAmbiguous)
          throw Object.assign(error("PUBLICATION_UNCERTAIN", 503), {
            blockedReason: e.code ?? "PREFLIGHT_BLOCKED",
          });
        throw e;
      }
      await store.save(attempt);
      outcomeUnproven = true;
      try {
        const proof = await transport.commitDirect(input, attempt);
        await store.save({ ...attempt, state: "committed", proof });
        return proof;
      } catch (e: any) {
        if (e.code === "HEAD_CHANGED" && e.remoteMutationAttempted === false) {
          await store.save({ ...attempt, state: "uncertain" });
          continue;
        }
        if (e.remoteMutationAttempted === false) {
          if (replayAmbiguous) {
            await store.save({ ...attempt, state: "uncertain" });
            throw Object.assign(error("PUBLICATION_UNCERTAIN", 503), {
              blockedReason: e.code ?? "REPLAY_BLOCKED",
            });
          }
          await store.save({ ...attempt, state: "absent" });
          outcomeUnproven = false;
          throw e;
        }
        await store.save({ ...attempt, state: "uncertain" });
        throw error("PUBLICATION_UNCERTAIN", 503);
      }
    }
    const final = await store.latest();
    if (final) {
      const inspected = await transport.inspectDirect(input, final);
      if (inspected.state === "committed") {
        await store.save({
          ...final,
          state: "committed",
          proof: inspected.commit,
        });
        return inspected.commit;
      }
      if (inspected.state === "head-unchanged")
        throw error("PUBLICATION_UNCERTAIN", 503);
      await store.save({ ...final, state: "absent" });
      outcomeUnproven = false;
    }
    outcomeUnproven = false;
    throw error("HEAD_CONTENTION");
  } catch (e: any) {
    if (outcomeUnproven && e.code !== "PUBLICATION_UNCERTAIN")
      throw Object.assign(error("PUBLICATION_UNCERTAIN", 503), {
        blockedReason: e.code ?? "RECONCILIATION_READ_FAILED",
      });
    throw e;
  }
}

export function pgDirectStore(db: any, input: DirectInput): DirectStore {
  return {
    latest: async () => {
      const row = (
        await db.query(
          "SELECT attempt FROM website_publication_attempts WHERE operation_id=$1 ORDER BY sequence DESC LIMIT 1",
          [input.id],
        )
      ).rows[0];
      return row?.attempt ?? null;
    },
    save: async (attempt) => {
      await db.query(
        "INSERT INTO website_publication_attempts(operation_id,attempt_id,repository,branch,subject,attempt) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(operation_id,attempt_id) DO UPDATE SET attempt=EXCLUDED.attempt,updated_at=now()",
        [
          input.id,
          attempt.id,
          input.repository,
          input.branch,
          input.subject,
          JSON.stringify(attempt),
        ],
      );
    },
  };
}

export async function publicationDeployment<T>(
  transport: EditorialTransport<T>,
  proof: DirectCommit,
  files: ProposalFile<T>[],
): Promise<{ state: string; sha?: string; url?: string }> {
  try {
    return (
      (await (transport.deploymentFor
        ? transport.deploymentFor(proof.commitSha, files)
        : transport.deployment?.(proof.commitSha))) ?? { state: "pending" }
    );
  } catch {
    return { state: "pending" };
  }
}

export function expectedRevisionMap(
  ids: string[],
  input: unknown,
  kind: "revisions" | "versions",
): Record<string, number> {
  if (input === undefined || input === null)
    throw new ApiError(
      428,
      kind === "revisions"
        ? "EXPECTED_REVISIONS_REQUIRED"
        : "EXPECTED_VERSIONS_REQUIRED",
      "Envía la versión mostrada de cada registro.",
    );
  if (
    typeof input !== "object" ||
    Array.isArray(input) ||
    new Set(ids).size !== ids.length ||
    Object.keys(input).length !== ids.length ||
    ids.some(
      (id) =>
        !Object.hasOwn(input, id) ||
        !Number.isSafeInteger((input as any)[id]) ||
        (input as any)[id] < 1,
    )
  )
    throw new ApiError(
      422,
      "EXPECTED_VERSION_MAP_INVALID",
      "Las versiones deben coincidir exactamente con la selección.",
    );
  return Object.fromEntries(
    ids
      .slice()
      .sort()
      .map((id) => [id, (input as any)[id]]),
  );
}
