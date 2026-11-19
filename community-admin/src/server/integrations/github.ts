import { sign } from "node:crypto";
import { apiRequest, jsonBody, secureRequest, type Transport } from "./http";
import { hashValue, IntegrationError } from "./security";
export interface GitHubConfig {
  appId: string;
  installationId: string;
  privateKey: string;
  owner: string;
  repo: string;
  apiVersion?: string;
  enabled: boolean;
  requiredChecks: string[];
  requiredApprovals: number;
  installationPermissions?: Record<string, string>;
}
export interface ExportFile {
  path: string;
  content: string | null;
  encoding?: "utf-8" | "base64";
  baseEntityHash?: string | null;
}
export class GitHub {
  constructor(
    public config: GitHubConfig,
    private transport: Transport = secureRequest,
  ) {}
  private token?: { value: string; expires: number };
  async installationToken(): Promise<string> {
    if (!this.config.enabled)
      throw new IntegrationError("INTEGRATION_DISABLED", 503);
    if (this.token && this.token.expires > Date.now() + 60000)
      return this.token.value;
    const now = Math.floor(Date.now() / 1000),
      encode = (o: unknown) =>
        Buffer.from(JSON.stringify(o)).toString("base64url");
    const value = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: this.config.appId })}`;
    const jwt = `${value}.${sign("RSA-SHA256", Buffer.from(value), this.config.privateKey).toString("base64url")}`;
    const result = await apiRequest(
      this.transport,
      `https://api.github.com/app/installations/${encodeURIComponent(this.config.installationId)}/access_tokens`,
      {
        method: "POST",
        hosts: ["api.github.com"],
        headers: this.headers(jwt),
        body: JSON.stringify({
          repositories: [this.config.repo],
          permissions: this.config.installationPermissions ?? {
            contents: "write",
            pull_requests: "write",
            checks: "read",
            actions: "read",
            deployments: "read",
            statuses: "read",
            administration: "read",
          },
        }),
      },
    );
    const data = jsonBody(result);
    if (!data.token || !data.expires_at)
      throw new IntegrationError("TOKEN_RESPONSE");
    this.token = { value: data.token, expires: Date.parse(data.expires_at) };
    return data.token;
  }
  private headers(token: string) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": this.config.apiVersion ?? "2026-03-10",
      "User-Agent": "community-admin",
      "Content-Type": "application/json",
    };
  }
  async request(method: string, path: string, body?: unknown): Promise<any> {
    const token = await this.installationToken();
    const result = await apiRequest(
      this.transport,
      `https://api.github.com${path}`,
      {
        method,
        hosts: ["api.github.com"],
        headers: this.headers(token),
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    return result.body.length ? jsonBody(result) : {};
  }
  get root() {
    return `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`;
  }
  validateFiles(files: ExportFile[]) {
    if (!files.length || files.length > 100)
      throw new IntegrationError("FILE_LIMIT");
    let bytes = 0;
    for (const file of files) {
      if (
        !/^(content\/(?:memories|resources|courses|organizers|speakers|events|settings|brands|jobs|job-sources)\/[a-zA-Z0-9:_-]+\.json|content\/collection\/latest\.json|public\/media\/[a-f0-9]{12,64}\/[a-zA-Z0-9_-]+\.(?:webp|png|jpg))$/.test(
          file.path,
        )
      )
        throw new IntegrationError("PATH_NOT_ALLOWED");
      if (file.content === null) continue;
      bytes += Buffer.byteLength(file.content);
      if (file.path.startsWith("content/")) {
        let record;
        try {
          record = JSON.parse(file.content);
        } catch {
          throw new IntegrationError("INVALID_EXPORT");
        }
        const walk = (v: any): void => {
          if (!v || typeof v !== "object") return;
          for (const [key, value] of Object.entries(v)) {
            if (
              /^(email|phone|notes|contactPoints|accessToken|refreshToken|storageKey|presignedUrl|privateNotes|credentials)$/i.test(
                key,
              )
            )
              throw new IntegrationError("PRIVATE_EXPORT_FIELD");
            walk(value);
          }
        };
        walk(record);
      }
    }
    if (bytes > 25_000_000) throw new IntegrationError("BYTE_LIMIT");
  }
  async createChangeset(
    id: string,
    files: ExportFile[],
    title = "Update approved community content",
    branchOverride?: string,
  ): Promise<any> {
    this.validateFiles(files);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      throw new IntegrationError("INVALID_CHANGESET");
    const branch = branchOverride ?? `content/${id}`;
    if (!/^content\/[a-zA-Z0-9_-]+$/.test(branch))
      throw new IntegrationError("INVALID_BRANCH");
    const existing = await this.request(
      "GET",
      `${this.root}/pulls?state=all&head=${encodeURIComponent(this.config.owner + ":" + branch)}&per_page=100`,
    );
    if (existing.length) {
      const pr = existing[0];
      if (pr.body?.includes(`export-hash:${hashValue(files)}`)) return pr;
      throw new IntegrationError("CHANGESET_HASH_CONFLICT", 409);
    }
    const main = await this.request("GET", `${this.root}/git/ref/heads/main`),
      commit = await this.request(
        "GET",
        `${this.root}/git/commits/${main.object.sha}`,
      );
    for (const file of files.filter((f) => f.baseEntityHash !== undefined)) {
      let current = null;
      try {
        const value = await this.request(
          "GET",
          `${this.root}/contents/${file.path}?ref=${main.object.sha}`,
        );
        current = hashValue(
          JSON.parse(Buffer.from(value.content, "base64").toString()),
        );
      } catch (e) {
        if (!(e instanceof IntegrationError) || e.code !== "PROVIDER_REJECTED")
          throw e;
      }
      if (current !== file.baseEntityHash)
        throw new IntegrationError("ENTITY_CONFLICT", 409);
    }
    let existingBranch: any;
    try {
      existingBranch = await this.request(
        "GET",
        `${this.root}/git/ref/heads/${branch}`,
      );
    } catch (e) {
      if (!(e instanceof IntegrationError) || e.code !== "PROVIDER_REJECTED")
        throw e;
    }
    if (existingBranch) {
      const previous = await this.request(
        "GET",
        `${this.root}/git/commits/${existingBranch.object.sha}`,
      );
      if (!previous.message?.includes(`export-hash:${hashValue(files)}`))
        throw new IntegrationError("BRANCH_CONFLICT", 409);
      return this.request("POST", `${this.root}/pulls`, {
        title,
        head: branch,
        base: "main",
        body: `Approved public content.\n\nexport-hash:${hashValue(files)}`,
      });
    }
    const tree = [];
    for (const file of files) {
      const blob =
        file.content === null
          ? { sha: null }
          : await this.request("POST", `${this.root}/git/blobs`, {
              content: file.content,
              encoding: file.encoding ?? "utf-8",
            });
      tree.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }
    const built = await this.request("POST", `${this.root}/git/trees`, {
      base_tree: commit.tree.sha,
      tree,
    });
    const next = await this.request("POST", `${this.root}/git/commits`, {
      message: `${title}\n\nexport-hash:${hashValue(files)}`,
      tree: built.sha,
      parents: [main.object.sha],
    });
    try {
      await this.request("POST", `${this.root}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: next.sha,
      });
    } catch (e) {
      const ref = await this.request(
        "GET",
        `${this.root}/git/ref/heads/${branch}`,
      );
      if (ref.object.sha !== next.sha)
        throw new IntegrationError("BRANCH_CONFLICT", 409);
    }
    return this.request("POST", `${this.root}/pulls`, {
      title,
      head: branch,
      base: "main",
      body: `Approved public content.\n\nexport-hash:${hashValue(files)}`,
    });
  }
  async syncJobs(files: ExportFile[]) {
    this.validateFiles(files);
    if (
      files.some(
        (f) =>
          !f.path.startsWith("content/jobs/") &&
          f.path !== "content/collection/latest.json",
      )
    )
      throw new IntegrationError("PATH_NOT_ALLOWED");
    const branch = "content/jobs-sync",
      main = await this.request("GET", `${this.root}/git/ref/heads/main`),
      base = await this.request(
        "GET",
        `${this.root}/git/commits/${main.object.sha}`,
      );
    const open = await this.request(
      "GET",
      `${this.root}/pulls?state=open&head=${encodeURIComponent(this.config.owner + ":" + branch)}&per_page=100`,
    );
    if (open[0]?.body?.includes(`export-hash:${hashValue(files)}`))
      return open[0];
    let old: any;
    try {
      old = await this.request("GET", `${this.root}/git/ref/heads/${branch}`);
    } catch (e) {
      if (!(e instanceof IntegrationError) || e.code !== "PROVIDER_REJECTED")
        throw e;
    }
    const tree = [];
    for (const file of files) {
      const blob = await this.request("POST", `${this.root}/git/blobs`, {
        content: file.content,
        encoding: "utf-8",
      });
      tree.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }
    const built = await this.request("POST", `${this.root}/git/trees`, {
        base_tree: base.tree.sha,
        tree,
      }),
      commit = await this.request("POST", `${this.root}/git/commits`, {
        message: `Review collected jobs\n\nexport-hash:${hashValue(files)}`,
        tree: built.sha,
        parents: [
          ...new Set([old?.object.sha, main.object.sha].filter(Boolean)),
        ],
      });
    if (old)
      await this.request("PATCH", `${this.root}/git/refs/heads/${branch}`, {
        sha: commit.sha,
        force: false,
      });
    else
      await this.request("POST", `${this.root}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      });
    const body = `Review factual source changes and candidate eligibility before approval.\n\nexport-hash:${hashValue(files)}`;
    return open[0]
      ? this.request("PATCH", `${this.root}/pulls/${open[0].number}`, { body })
      : this.request("POST", `${this.root}/pulls`, {
          title: "Review collected community jobs",
          head: branch,
          base: "main",
          body,
        });
  }
  async status(number: number): Promise<any> {
    const pr = await this.request("GET", `${this.root}/pulls/${number}`);
    const checks = await this.request(
      "GET",
      `${this.root}/commits/${pr.head.sha}/check-runs?per_page=100`,
    );
    const statuses = await this.request(
      "GET",
      `${this.root}/commits/${pr.head.sha}/status`,
    );
    const latestChecks = new Map<string, any>();
    for (const check of [...(checks.check_runs ?? [])].sort(
      (a: any, b: any) => (b.id ?? 0) - (a.id ?? 0),
    ))
      if (!latestChecks.has(check.name)) latestChecks.set(check.name, check);
    const checkResults: Record<string, boolean> = {};
    for (const name of new Set([
      ...this.config.requiredChecks,
      ...latestChecks.keys(),
      ...(statuses.statuses ?? []).map((s: any) => s.context),
    ])) {
      const c = latestChecks.get(name);
      checkResults[name] = c
        ? c.head_sha === pr.head.sha &&
          c.status === "completed" &&
          c.conclusion === "success"
        : statuses.statuses?.find((s: any) => s.context === name)?.state ===
          "success";
    }
    const checksPassed =
      this.config.requiredChecks.length > 0 &&
      this.config.requiredChecks.every((name) => checkResults[name]);
    let state = pr.merged
      ? "merged"
      : pr.state === "closed"
        ? "closed"
        : checksPassed
          ? "checks_passed"
          : checks.check_runs?.some((c: any) =>
                ["failure", "cancelled", "timed_out"].includes(c.conclusion),
              )
            ? "checks_failed"
            : "pr_open";
    if (pr.merged) {
      const deployments = await this.request(
        "GET",
        `${this.root}/deployments?sha=${pr.merge_commit_sha}&environment=github-pages&per_page=100`,
      );
      for (const d of deployments) {
        if (d.sha !== pr.merge_commit_sha) continue;
        const outcomes = await this.request(
          "GET",
          `${this.root}/deployments/${d.id}/statuses?per_page=1`,
        );
        if (outcomes[0]?.state === "success") {
          state = "deployed";
          break;
        }
        if (["failure", "error"].includes(outcomes[0]?.state))
          state = "deploy_failed";
      }
    }
    return {
      state,
      headSha: pr.head.sha,
      mergedSha: pr.merged ? pr.merge_commit_sha : null,
      deployedSha: state === "deployed" ? pr.merge_commit_sha : null,
      checksPassed,
      checkResults,
      pr,
    };
  }
  async merge(number: number, expectedSha: string) {
    const status = await this.status(number);
    if (status.headSha !== expectedSha || !status.checksPassed)
      throw new IntegrationError("MERGE_GATES", 409);
    const protection = await this.request(
      "GET",
      `${this.root}/branches/main/protection`,
    );
    if (
      !protection.required_pull_request_reviews ||
      !protection.required_status_checks ||
      !protection.enforce_admins?.enabled
    )
      throw new IntegrationError("PROTECTION_REQUIRED", 409);
    const contexts = [
      ...(protection.required_status_checks.contexts ?? []),
      ...(protection.required_status_checks.checks ?? []).map(
        (c: any) => c.context,
      ),
    ];
    if (!contexts.length || contexts.some((name) => !status.checkResults[name]))
      throw new IntegrationError("REQUIRED_CHECKS_PENDING", 409);
    const required = Math.max(
      1,
      this.config.requiredApprovals,
      protection.required_pull_request_reviews
        .required_approving_review_count ?? 0,
    );
    const reviews = await this.request(
        "GET",
        `${this.root}/pulls/${number}/reviews?per_page=100`,
      ),
      latest = new Map<string, any>();
    for (const review of reviews) latest.set(review.user.id, review);
    if (
      [...latest.values()].some((r) => r.state === "CHANGES_REQUESTED") ||
      [...latest.values()].filter(
        (r) =>
          r.state === "APPROVED" &&
          r.commit_id === expectedSha &&
          r.user.id !== status.pr.user.id,
      ).length < required ||
      status.pr.mergeable !== true ||
      status.pr.mergeable_state !== "clean"
    )
      throw new IntegrationError("REVIEW_REQUIRED", 409);
    return this.request("PUT", `${this.root}/pulls/${number}/merge`, {
      sha: expectedSha,
      merge_method: "merge",
    });
  }
  async revert(id: string, number: number, expectedMain: string) {
    const main = await this.request("GET", `${this.root}/git/ref/heads/main`);
    if (main.object.sha !== expectedMain)
      throw new IntegrationError("REVERT_CONFLICT", 409);
    const pr = await this.request("GET", `${this.root}/pulls/${number}`);
    if (!pr.merged) throw new IntegrationError("NOT_MERGED", 409);
    const changed = await this.request(
      "GET",
      `${this.root}/pulls/${number}/files?per_page=100`,
    );
    if (changed.length === 100) throw new IntegrationError("FILE_LIMIT");
    const files: ExportFile[] = [];
    for (const f of changed) {
      if (f.status === "added") {
        const current = await this.request(
            "GET",
            `${this.root}/contents/${f.filename}?ref=${expectedMain}`,
          ),
          merged = await this.request(
            "GET",
            `${this.root}/contents/${f.filename}?ref=${pr.merge_commit_sha}`,
          );
        if (current.sha !== merged.sha)
          throw new IntegrationError("REVERT_CONFLICT", 409);
        files.push({ path: f.filename, content: null });
        continue;
      }
      if (!["modified", "removed"].includes(f.status))
        throw new IntegrationError("REVERT_RENAME_REVIEW_REQUIRED", 409);
      if (f.status === "removed") {
        try {
          await this.request(
            "GET",
            `${this.root}/contents/${f.filename}?ref=${expectedMain}`,
          );
          throw new IntegrationError("REVERT_CONFLICT", 409);
        } catch (e) {
          if (
            !(e instanceof IntegrationError) ||
            e.code !== "PROVIDER_REJECTED"
          )
            throw e;
        }
        const before = await this.request(
          "GET",
          `${this.root}/contents/${f.filename}?ref=${pr.base.sha}`,
        );
        files.push({
          path: f.filename,
          content: f.filename.startsWith("public/")
            ? before.content
            : Buffer.from(before.content, "base64").toString(),
          encoding: f.filename.startsWith("public/") ? "base64" : "utf-8",
        });
        continue;
      }
      const current = await this.request(
          "GET",
          `${this.root}/contents/${f.filename}?ref=${expectedMain}`,
        ),
        merged = await this.request(
          "GET",
          `${this.root}/contents/${f.filename}?ref=${pr.merge_commit_sha}`,
        );
      if (current.sha !== merged.sha)
        throw new IntegrationError("REVERT_CONFLICT", 409);
      const before = await this.request(
        "GET",
        `${this.root}/contents/${f.filename}?ref=${pr.base.sha}`,
      );
      files.push({
        path: f.filename,
        content: f.filename.startsWith("public/")
          ? before.content
          : Buffer.from(before.content, "base64").toString(),
        encoding: f.filename.startsWith("public/") ? "base64" : "utf-8",
      });
    }
    return this.createChangeset(id, files, "Revert approved community content");
  }
}
