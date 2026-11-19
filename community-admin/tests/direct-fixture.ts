import { hashRevision } from "../src/shared/content";
import type {
  DirectAttempt,
  DirectInput,
} from "../src/server/editorial-sync/direct";
export function directRemote() {
  let head = "a".repeat(40),
    n = 1;
  const tree = new Map<string, any>(),
    history = new Map<string, any[]>(),
    proofs = new Map<string, any>();
  let deployment = "pending";
  let before: (
    i: DirectInput,
    a: DirectAttempt,
  ) => Promise<void> = async () => {};
  let lose = false;
  const entries = () =>
    [...tree]
      .filter(([p]) => p.startsWith("content/"))
      .map(([p, record]) => ({
        type: p.split("/")[1],
        record: structuredClone(record),
      }));
  history.set(head, []);
  const view = (types: string[]) => ({
    identity: async () => ({ subject: "42", login: "owner" }),
    snapshot: async (commit?: string) => ({
      commit: commit ?? head,
      records: (commit ? (history.get(commit) ?? []) : entries()).filter((r) =>
        types.includes(r.type),
      ),
    }),
    findProposal: async () => {
      throw Error("NO_PR_ALLOWED");
    },
    createProposal: async () => {
      throw Error("NO_PR_ALLOWED");
    },
    inspectProposal: async () => {
      throw Error("NO_PR_ALLOWED");
    },
    verifyWebsite: async () => {},
    hashesDirect: async (files: any[]) =>
      Object.fromEntries(
        files.map((f) => [
          f.path,
          tree.has(f.path) ? hashRevision(tree.get(f.path)) : null,
        ]),
      ),
    inspectDirect: async (_: DirectInput, a: DirectAttempt) =>
      proofs.has(a.id)
        ? { state: "committed" as const, commit: proofs.get(a.id) }
        : head === a.expectedHeadOid
          ? { state: "head-unchanged" as const, headCommit: head }
          : { state: "absent-proven" as const, headCommit: head },
    commitDirect: async (input: DirectInput, attempt: DirectAttempt) => {
      await before(input, attempt);
      if (attempt.expectedHeadOid !== head)
        throw Object.assign(Error("HEAD_CHANGED"), {
          code: "HEAD_CHANGED",
          remoteMutationAttempted: false,
        });
      const parent = head;
      head = (++n).toString(16).padStart(40, "0");
      for (const f of input.files) tree.set(f.path, structuredClone(f.record));
      history.set(head, entries());
      const proof = {
        commitSha: head,
        commitUrl: "https://github.com/example/commit/" + head,
        parent,
        attemptId: attempt.id,
      };
      proofs.set(attempt.id, proof);
      if (lose) {
        lose = false;
        throw Error("response lost");
      }
      return proof;
    },
    deployment: async () => ({ state: deployment }),
  });
  return {
    view,
    tree,
    head: () => head,
    before: (fn: typeof before) => (before = fn),
    lose: () => (lose = true),
    deployment: (state: string) => (deployment = state),
    proofs,
  };
}
