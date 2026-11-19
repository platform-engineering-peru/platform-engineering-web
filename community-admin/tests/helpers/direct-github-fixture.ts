import { FakeEditorialGitHub } from "./editorial-fixture";
import { hashRevision } from "../../src/shared/content";
import type {
  DirectInput,
  DirectAttempt,
  DirectCommit,
  DirectInspection,
} from "../../src/server/editorial-sync/direct";
/** Test-only immutable main commits; no branch/PR/network operations. */
export class FakeDirectGitHub extends FakeEditorialGitHub {
  commitCalls = 0;
  uncertainBeforeMutationOnce = false;
  websiteChecks: { commit: string; types: string[] }[] = [];
  /** Injected test handshake; production verifies pinned renderer bytes remotely. */
  async verifyWebsite(commit: string, types: string[] = ["events"]) {
    await this.snapshot(commit);
    this.websiteChecks.push({ commit, types: [...types] });
  }
  deployed = false;
  failDeployment = false;
  proof = new Map<string, DirectCommit>();
  async commitDirect(
    input: DirectInput,
    attempt: DirectAttempt,
  ): Promise<DirectCommit> {
    if (attempt.expectedHeadOid !== this.head)
      throw Object.assign(Error("head advanced"), {
        code: "HEAD_CHANGED",
        remoteMutationAttempted: false,
      });
    if (this.uncertainBeforeMutationOnce) {
      this.uncertainBeforeMutationOnce = false;
      throw Object.assign(
        Error("Synthetic uncertain submission before remote mutation"),
        { code: "PUBLICATION_UNCERTAIN", remoteMutationAttempted: true },
      );
    }
    const parent = this.head;
    this.commitCalls++;
    const paths = new Set(
      input.files.filter((f) => !f.contentBase64).map((f) => f.path),
    );
    const records = this.records.filter(
      (r) => !paths.has(`content/${r.type}/${r.record.id}.json`),
    );
    records.push(
      ...input.files
        .filter((f) => !f.contentBase64)
        .map((f) => ({
          type: f.path.split("/")[1] as any,
          record: structuredClone(f.record),
        })),
    );
    this.approve(records);
    const proof = {
      commitSha: this.head,
      commitUrl: `https://github.com/example/community/commit/${this.head}`,
      parent,
      attemptId: attempt.id,
    };
    this.proof.set(attempt.id, proof);
    return proof;
  }
  async inspectDirect(
    _input: DirectInput,
    attempt: DirectAttempt,
  ): Promise<DirectInspection> {
    const proof = this.proof.get(attempt.id);
    if (proof) return { state: "committed", commit: structuredClone(proof) };
    return this.head === attempt.expectedHeadOid
      ? { state: "head-unchanged", headCommit: this.head }
      : { state: "absent-proven", headCommit: this.head };
  }
  async hashesDirect(files: any[], commit: string) {
    const snapshot = await this.snapshot(commit);
    return Object.fromEntries(
      files.map((f) => {
        const row = snapshot.records.find(
          (r) => `content/${r.type}/${r.record.id}.json` === f.path,
        );
        return [f.path, row ? hashRevision(row.record) : null];
      }),
    );
  }
  async deployment(_sha: string) {
    return {
      state: this.failDeployment
        ? "failed"
        : this.deployed
          ? "deployed"
          : "pending",
      url: "https://example.org/es-pe/",
      ...(this.deployed ? { sha: _sha } : {}),
    };
  }
}
