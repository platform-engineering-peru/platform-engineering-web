export type PublicRecord = Record<string, any> & {
  id: string;
  status: "published" | "archived";
};
export interface SnapshotRecord<T = PublicRecord> {
  type: string;
  record: T;
}
export interface RemoteSnapshot<T = PublicRecord> {
  commit: string;
  records: SnapshotRecord<T>[];
}
export interface Identity {
  subject: string;
  login: string;
}
export interface ProposalFile<T = PublicRecord> {
  path: string;
  contentBase64?: string;
  record: T;
  hash: string;
}
export interface RemoteProposal<T = PublicRecord> {
  number: number;
  url: string;
  headCommit: string;
  state: "open" | "closed" | "merged";
  mergeCommit: string | null;
  files: ProposalFile<T>[];
  marker: string;
  branch: string;
  baseBranch: string;
  authorSubject?: string;
  reviewDecision?: string;
  checks?: string;
}
export interface ProposalInput<T = PublicRecord> {
  subject: string;
  id: string;
  branch: string;
  baseCommit: string;
  files: ProposalFile<T>[];
  title: string;
}
/** PR history remains available; direct publication uses an explicit expected-head CAS. */
export interface EditorialTransport<T = PublicRecord> {
  commitDirect?(
    input: import("./direct").DirectInput<T>,
    attempt: import("./direct").DirectAttempt,
  ): Promise<import("./direct").DirectCommit>;
  inspectDirect?(
    input: import("./direct").DirectInput<T>,
    attempt: import("./direct").DirectAttempt,
  ): Promise<import("./direct").DirectInspection>;
  headCommit?(): Promise<string>;
  rendererReadiness?(
    commit: string,
    types: string[],
  ): Promise<Record<string, { rendererReady: boolean; reason?: string }>>;
  verifyWebsite?(commit: string, types?: string[]): Promise<void>;
  hashesDirect?(
    files: ProposalFile<T>[],
    commit: string,
  ): Promise<Record<string, string | null>>;
  deploymentFor?(
    sha: string,
    files: ProposalFile<T>[],
  ): Promise<{ state: string; sha?: string; url?: string }>;
  deployment?(sha: string): Promise<{ state: string; url?: string }>;
  identity(): Promise<Identity>;
  snapshot(commit?: string): Promise<RemoteSnapshot<T>>;
  findProposal(branch: string): Promise<RemoteProposal<T> | null>;
  createProposal(input: ProposalInput<T>): Promise<RemoteProposal<T>>;
  inspectProposal(input: ProposalInput<T>): Promise<{
    state: "absent" | "branch_verified";
    headCommit: string | null;
  }>;
}
export interface EditorialConfig {
  mode: "local" | "github";
  repository: string | null;
  branch: string;
  remoteWritesEnabled: boolean;
}
export function editorialConfig(): EditorialConfig {
  const mode = process.env.EDITORIAL_MODE ?? "local";
  if (!["local", "github"].includes(mode))
    throw new Error("Invalid EDITORIAL_MODE");
  if (
    process.env.EDITORIAL_REMOTE_WRITES &&
    !["0", "1"].includes(process.env.EDITORIAL_REMOTE_WRITES)
  )
    throw new Error("Invalid EDITORIAL_REMOTE_WRITES");
  const repository = process.env.EDITORIAL_REPOSITORY || null;
  const branch = process.env.EDITORIAL_BRANCH || "main";
  if (
    repository &&
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(
      repository,
    )
  )
    throw new Error("Invalid EDITORIAL_REPOSITORY");
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,99}$/.test(branch) ||
    branch.includes("//") ||
    branch.endsWith("/") ||
    branch.includes("..")
  )
    throw new Error("Invalid EDITORIAL_BRANCH");
  return {
    mode: mode as "local" | "github",
    repository,
    branch,
    remoteWritesEnabled: process.env.EDITORIAL_REMOTE_WRITES === "1",
  };
}
