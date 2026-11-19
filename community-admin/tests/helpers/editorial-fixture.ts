import { hashRevision } from "../../src/shared/content";
import { ApiError } from "../../src/server/context";
import type {
  EditorialTransport,
  RemoteSnapshot,
  RemoteProposal,
  ProposalInput,
  SnapshotRecord,
} from "../../src/server/editorial-sync/types";
/** In-memory GitHub with immutable commits; local stores remain real independent PostgreSQL schemas. */
export class FakeEditorialGitHub implements EditorialTransport {
  subject = "42";
  login = "isolated-editor";
  offline = false;
  uncertainAfterCreate = false;
  createCalls = 0;
  head = "";
  records: SnapshotRecord[] = [];
  commits = new Map<string, SnapshotRecord[]>();
  proposals = new Map<string, RemoteProposal>();
  constructor(records: SnapshotRecord[] = []) {
    this.approve(records);
  }
  approve(records: SnapshotRecord[]) {
    this.records = structuredClone(records);
    this.head = hashRevision({ records, parent: this.head }).slice(0, 40);
    this.commits.set(this.head, structuredClone(records));
    return this.head;
  }
  async identity() {
    if (this.offline)
      throw new ApiError(
        503,
        "REMOTE_UNAVAILABLE",
        "GitHub no está disponible.",
      );
    return { subject: this.subject, login: this.login };
  }
  async snapshot(commit?: string): Promise<RemoteSnapshot> {
    await this.identity();
    const id = commit ?? this.head,
      records = this.commits.get(id);
    if (!records)
      throw new ApiError(503, "SNAPSHOT_INCOMPLETE", "Commit no disponible.");
    return { commit: id, records: structuredClone(records) };
  }
  async findProposal(branch: string) {
    await this.identity();
    return structuredClone(this.proposals.get(branch) ?? null);
  }
  async createProposal(input: ProposalInput) {
    await this.identity();
    this.createCalls++;
    let proposal = this.proposals.get(input.branch);
    if (!proposal) {
      proposal = {
        number: this.proposals.size + 1,
        url: `https://github.com/example/community/pull/${this.proposals.size + 1}`,
        headCommit: hashRevision(input.files).slice(0, 40),
        state: "open",
        mergeCommit: null,
        files: structuredClone(input.files),
        marker: input.id,
        branch: input.branch,
        baseBranch: "main",
        authorSubject: this.subject,
        reviewDecision: "pending",
        checks: "pending",
      };
      this.proposals.set(input.branch, proposal);
    }
    if (this.uncertainAfterCreate) {
      this.uncertainAfterCreate = false;
      throw new Error("Ambiguous response after remote creation");
    }
    return structuredClone(proposal);
  }
  async inspectProposal(input: ProposalInput): Promise<{
    state: "absent" | "branch_verified";
    headCommit: string | null;
  }> {
    await this.identity();
    return { state: "absent" as const, headCommit: null };
  }
  merge(branch: string) {
    const p = this.proposals.get(branch)!;
    const next = this.records.filter(
      (r) =>
        !p.files.some(
          (f) => f.record.id === r.record.id && r.type === "events",
        ),
    );
    next.push(...p.files.map((f) => ({ type: "events", record: f.record })));
    p.mergeCommit = this.approve(next);
    p.state = "merged";
    p.reviewDecision = "approved";
    p.checks = "success";
    return p.mergeCommit;
  }
}
