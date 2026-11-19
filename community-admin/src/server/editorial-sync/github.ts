import { rendererVerifier } from "./compatibility";
import {
  directDigest,
  type DirectInput,
  type DirectAttempt,
  type DirectCommit,
  type DirectInspection,
} from "./direct";
import { spawn } from "node:child_process";
import { z } from "zod";
import { canonicalJson, hashRevision } from "../../shared/content";
import { ApiError } from "../context";
import { validatePublicExport } from "../public-validation";
import { recordPath, snapshotTypes, publicTypes } from "./validation";
import { jobRecordPath } from "../jobs/publication-contract";
import type {
  PublicRecord,
  EditorialConfig,
  EditorialTransport,
  ProposalFile,
  ProposalInput,
  RemoteProposal,
  RemoteSnapshot,
} from "./types";
export type GhExecutor = (args: string[], stdin?: string) => Promise<string>;
/** Credentials come from the operator's gh credential store, never browser input or shared App env. */
export const executeGh: GhExecutor = (args, stdin) =>
  new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GH_PAGER: "cat",
      GH_HOST: "github.com",
    };
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "GH_DEBUG",
    ])
      delete (env as Record<string, string | undefined>)[key];
    const child = spawn("gh", args, {
        shell: false,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      }),
      chunks: Buffer[] = [];
    let size = 0,
      settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      done(
        new ApiError(
          503,
          "REMOTE_UNAVAILABLE",
          "GitHub no respondió a tiempo. Conserva el borrador y vuelve a conciliar.",
        ),
      );
    }, 15000);
    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > 8_000_000) {
        child.kill("SIGTERM");
        done(
          new ApiError(
            503,
            "REMOTE_RESPONSE_LIMIT",
            "La respuesta de GitHub supera el límite seguro.",
          ),
        );
      } else chunks.push(b);
    });
    // Drain stderr without forwarding provider details, tokens, or local filesystem paths.
    child.stderr.on("data", () => {});
    child.on("error", () =>
      done(
        new ApiError(
          503,
          "AUTH_UNAVAILABLE",
          "GitHub CLI no está disponible en este equipo.",
        ),
      ),
    );
    child.on("close", (code) => {
      if (
        code !== 0 &&
        !Buffer.concat(chunks).toString("utf8").startsWith("HTTP/")
      )
        done(
          new ApiError(
            503,
            "REMOTE_UNAVAILABLE",
            "No se pudo acceder a GitHub con la cuenta local.",
          ),
        );
      else done();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
class GhHttpError extends ApiError {
  constructor(readonly httpStatus: number) {
    super(
      httpStatus === 401 || httpStatus === 403 ? 403 : 503,
      httpStatus === 401 || httpStatus === 403
        ? "AUTH_UNAVAILABLE"
        : "REMOTE_UNAVAILABLE",
      "GitHub rechazó la operación. Comprueba la cuenta, permisos y conexión.",
    );
  }
}
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const sha = {
  parse(value: unknown) {
    const result = shaSchema.safeParse(value);
    if (!result.success)
      throw new ApiError(
        503,
        "REMOTE_RESPONSE_INVALID",
        "GitHub devolvió una identidad de commit no válida.",
      );
    return result.data;
  },
};
export class GhEditorialTransport<
  T extends { id: string } = PublicRecord,
> implements EditorialTransport<T> {
  private mutationAttempted = false;
  constructor(
    readonly config: EditorialConfig,
    readonly execute: GhExecutor = executeGh,
    readonly expectedSubject?: string,
    readonly allowedWriteType: "events" | "jobs" | "public" = "events",
  ) {}
  private writePath(record: T) {
    return this.allowedWriteType === "jobs"
      ? jobRecordPath(record.id)
      : recordPath("events", record.id);
  }
  private async validateRecord(record: T) {
    await validatePublicExport(this.allowedWriteType, record);
  }
  get root() {
    if (!this.config.repository)
      throw new ApiError(
        503,
        "UNCONFIGURED",
        "Falta el repositorio editorial.",
      );
    return `/repos/${this.config.repository}`;
  }
  async api(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<any> {
    if (path !== "/user" && !path.startsWith(this.root + "/"))
      throw new Error("Unsupported GitHub endpoint");
    if (method === "POST") {
      const endpoint = path.slice(this.root.length);
      if (
        !["/git/trees", "/git/commits", "/git/refs", "/pulls"].includes(
          endpoint,
        )
      )
        throw new ApiError(
          422,
          "PATH_NOT_ALLOWED",
          "Operación editorial no permitida.",
        );
      if (endpoint === "/git/refs")
        z.object({
          ref: z.string().regex(/^refs\/heads\/editorial\/[a-f0-9]{64}$/),
          sha: shaSchema,
        })
          .strict()
          .parse(body);
      if (endpoint === "/git/commits")
        z.object({
          message: z.string().max(1000),
          tree: shaSchema,
          parents: z.tuple([shaSchema]),
        })
          .strict()
          .parse(body);
      if (endpoint === "/pulls")
        z.object({
          title: z.string().max(200),
          head: z.string().regex(/^editorial\/[a-f0-9]{64}$/),
          base: z.literal(this.config.branch),
          body: z.string().max(2000),
        })
          .strict()
          .parse(body);
      if (endpoint === "/git/trees") {
        const input = z
          .object({
            base_tree: shaSchema,
            tree: z
              .array(
                z
                  .object({
                    path: z.string(),
                    mode: z.literal("100644"),
                    type: z.literal("blob"),
                    content: z.string().max(500000),
                  })
                  .strict(),
              )
              .min(1)
              .max(25),
          })
          .strict()
          .parse(body);
        for (const f of input.tree) {
          let record;
          try {
            record = JSON.parse(f.content);
          } catch {
            throw new ApiError(
              422,
              "VALIDATION_FAILED",
              "El registro propuesto debe ser JSON válido.",
            );
          }
          if (this.writePath(record) !== f.path)
            throw new ApiError(
              422,
              "PATH_NOT_ALLOWED",
              "Ruta editorial no permitida.",
            );
          await this.validateRecord(record);
        }
      }
      if (!this.config.remoteWritesEnabled)
        throw new ApiError(
          403,
          "REMOTE_WRITES_DISABLED",
          "Las escrituras están deshabilitadas.",
        );
      if (
        !this.expectedSubject ||
        (await this.identity()).subject !== this.expectedSubject
      )
        throw new ApiError(
          403,
          "AUTH_IDENTITY_MISMATCH",
          "La cuenta activa cambió antes de enviar la propuesta.",
        );
    }
    const args = [
      "api",
      "--hostname",
      "github.com",
      "--method",
      method,
      "--include",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      path,
    ];
    if (body !== undefined) args.push("--input", "-");
    if (method === "POST") this.mutationAttempted = true;
    const raw = await this.execute(
      args,
      body === undefined ? undefined : JSON.stringify(body),
    );
    const split = raw.search(/\r?\n\r?\n/),
      status = Number(/^HTTP\/\S+ (\d+)/.exec(raw)?.[1]);
    if (!status || split < 0)
      throw new ApiError(
        503,
        "REMOTE_RESPONSE_INVALID",
        "GitHub no devolvió una respuesta verificable.",
      );
    if (status < 200 || status >= 300) throw new GhHttpError(status);
    try {
      return JSON.parse(raw.slice(split).trim() || "{}");
    } catch {
      throw new ApiError(
        503,
        "REMOTE_RESPONSE_INVALID",
        "GitHub devolvió un documento no válido.",
      );
    }
  }
  async headCommit() {
    const response = await this.api(
      "GET",
      `${this.root}/git/ref/heads/${this.config.branch}`,
    );
    return sha.parse(response.object?.sha);
  }
  private rendererVerifier(commit: string) {
    sha.parse(commit);
    return rendererVerifier(async (path) => {
      let file: any;
      try {
        file = await this.api(
          "GET",
          `${this.root}/contents/${path}?ref=${commit}`,
        );
      } catch (e) {
        if (e instanceof GhHttpError && e.httpStatus === 404)
          throw new ApiError(
            409,
            "WEBSITE_RENDERER_NOT_READY",
            "Falta un lector público compatible.",
          );
        throw e;
      }
      if (
        file.type !== "file" ||
        file.encoding !== "base64" ||
        file.size > 500000
      )
        throw new ApiError(
          409,
          "WEBSITE_RENDERER_NOT_READY",
          "El lector público no coincide.",
        );
      return Buffer.from(file.content ?? "", "base64");
    });
  }
  async verifyWebsite(commit: string, types: string[] = ["events"]) {
    await this.rendererVerifier(commit).verify(types);
  }
  async rendererReadiness(commit: string, types: string[]) {
    const verifier = this.rendererVerifier(commit),
      result: Record<string, { rendererReady: boolean; reason?: string }> = {};
    for (const type of types) {
      try {
        await verifier.verify([type]);
        result[type] = { rendererReady: true };
      } catch (e: any) {
        result[type] = {
          rendererReady: false,
          reason: e.code ?? "REMOTE_UNAVAILABLE",
        };
      }
    }
    return result;
  }
  private async validateDirectFile(file: ProposalFile<T>) {
    if (this.allowedWriteType !== "public") {
      if (file.contentBase64 || file.path !== this.writePath(file.record))
        throw new ApiError(422, "PATH_NOT_ALLOWED", "Archivo no permitido.");
      return this.validateRecord(file.record);
    }
    if (file.contentBase64 !== undefined) {
      if (
        (file.record as any).id !== file.path ||
        (file.record as any).bytes !== file.contentBase64 ||
        Object.keys(file.record).some(
          (key) => !["id", "bytes"].includes(key),
        ) ||
        !/^public\/media\/[A-Za-z0-9_/-]+\.(?:png|jpe?g|webp|gif|svg)$/.test(
          file.path,
        ) ||
        file.path.includes("..") ||
        !file.contentBase64 ||
        Buffer.from(file.contentBase64, "base64").toString("base64") !==
          file.contentBase64
      )
        throw new ApiError(422, "PATH_NOT_ALLOWED", "Medio no permitido.");
      return;
    }
    const match = /^content\/([a-z-]+)\/([a-f0-9-]{36})\.json$/.exec(file.path);
    if (!match || file.path !== recordPath(match[1], file.record.id))
      throw new ApiError(422, "PATH_NOT_ALLOWED", "Archivo no permitido.");
    await validatePublicExport(match[1], file.record);
  }
  async hashesDirect(files: ProposalFile<T>[], commit: string) {
    sha.parse(commit);
    const result: Record<string, string | null> = {};
    for (const file of files) {
      await this.validateDirectFile(file);
      try {
        const actual = await this.api(
          "GET",
          `${this.root}/contents/${file.path}?ref=${commit}`,
        );
        if (
          actual.type !== "file" ||
          actual.encoding !== "base64" ||
          actual.size > 2_000_000
        )
          throw new ApiError(
            503,
            "REMOTE_RESPONSE_INVALID",
            "Archivo remoto no verificable.",
          );
        const bytes = Buffer.from(actual.content ?? "", "base64");
        result[file.path] =
          file.contentBase64 !== undefined
            ? hashRevision({
                id: file.record.id,
                bytes: bytes.toString("base64"),
              })
            : hashRevision(JSON.parse(bytes.toString("utf8")));
      } catch (e) {
        if (e instanceof GhHttpError && e.httpStatus === 404)
          result[file.path] = null;
        else throw e;
      }
    }
    return result;
  }
  private directGuard(input: DirectInput<T>, attempt: DirectAttempt) {
    if (
      this.config.repository !==
        "platform-engineering-peru/platform-engineering-web" ||
      this.config.branch !== "main" ||
      input.repository !== this.config.repository ||
      input.branch !== "main"
    )
      throw Object.assign(
        new ApiError(
          403,
          "DIRECT_TARGET_BLOCKED",
          "La publicación directa requiere el destino main autorizado.",
        ),
        { remoteMutationAttempted: false },
      );
    if (
      !/^[a-f0-9]{64}$/.test(input.id) ||
      attempt.operationId !== input.id ||
      attempt.digest !== directDigest(input) ||
      !/^[a-f0-9]{64}$/.test(attempt.id) ||
      !shaSchema.safeParse(attempt.expectedHeadOid).success ||
      !input.files.length ||
      input.files.length > 25
    )
      throw Object.assign(
        new ApiError(422, "DIRECT_INTENT_INVALID", "El envío no es válido."),
        { remoteMutationAttempted: false },
      );
  }
  private directMessage(input: DirectInput<T>, attempt: DirectAttempt) {
    return `Website operation: ${input.id}\nAttempt: ${attempt.id}\nPayload: ${attempt.digest}`;
  }
  async commitDirect(
    input: DirectInput<T>,
    attempt: DirectAttempt,
  ): Promise<DirectCommit> {
    this.directGuard(input, attempt);
    if (!this.config.remoteWritesEnabled)
      throw Object.assign(
        new ApiError(
          403,
          "REMOTE_WRITES_DISABLED",
          "La escritura remota está deshabilitada.",
        ),
        { remoteMutationAttempted: false },
      );
    try {
      const identity = await this.identity();
      if (identity.subject !== input.subject)
        throw new ApiError(403, "AUTH_IDENTITY_MISMATCH", "La cuenta cambió.");
      const paths = new Set<string>();
      for (const f of input.files) {
        if (paths.has(f.path) || f.hash !== hashRevision(f.record))
          throw new ApiError(422, "PATH_NOT_ALLOWED", "Archivo no permitido.");
        paths.add(f.path);
        await this.validateDirectFile(f);
      }
    } catch (error) {
      throw Object.assign(error as object, { remoteMutationAttempted: false });
    }
    const additions = input.files
      .filter((f) => input.baseHashes[f.path] !== f.hash)
      .map((f) => ({
        path: f.path,
        contents:
          f.contentBase64 ??
          Buffer.from(JSON.stringify(f.record, null, 2) + "\n").toString(
            "base64",
          ),
      }));
    if (!additions.length)
      throw Object.assign(
        new ApiError(
          409,
          "NO_CHANGES",
          "El contenido ya coincide con main; no se creó otro commit.",
        ),
        { remoteMutationAttempted: false },
      );
    if (Buffer.byteLength(JSON.stringify(additions)) > 2_000_000)
      throw Object.assign(
        new ApiError(422, "DIRECT_SIZE_LIMIT", "El envío supera el límite."),
        { remoteMutationAttempted: false },
      );
    const query =
      "mutation WebsiteCommit($input: CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid url}}}";
    const body = {
      query,
      variables: {
        input: {
          branch: {
            repositoryNameWithOwner: this.config.repository,
            branchName: "main",
          },
          expectedHeadOid: attempt.expectedHeadOid,
          fileChanges: { additions },
          message: {
            headline: `Publish community ${this.allowedWriteType}`,
            body: this.directMessage(input, attempt),
          },
          clientMutationId: attempt.id,
        },
      },
    };
    const raw = await this.execute(
      ["api", "--hostname", "github.com", "graphql", "--input", "-"],
      JSON.stringify(body),
    );
    let response: any;
    try {
      response = JSON.parse(raw);
    } catch {
      throw new ApiError(
        503,
        "PUBLICATION_UNCERTAIN",
        "No se verificó la respuesta.",
      );
    }
    if (response.errors?.length) {
      const headMismatch = response.errors.every(
        (e: any) =>
          (/expected.*(?:head|oid)|(?:head|oid).*expected/i.test(
            e.message ?? "",
          ) &&
            /match|changed|out of date/i.test(e.message ?? "")) ||
          (/Expected branch to point to/i.test(e.message ?? "") &&
            String(e.message).includes(attempt.expectedHeadOid) &&
            /did not/i.test(e.message)),
      );
      if (!response.data?.createCommitOnBranch && headMismatch)
        throw Object.assign(new ApiError(409, "HEAD_CHANGED", "main cambió."), {
          remoteMutationAttempted: false,
        });
      if (
        !response.data &&
        response.errors.every((e: any) =>
          ["FORBIDDEN", "NOT_FOUND"].includes(e.type),
        )
      )
        throw Object.assign(
          new ApiError(
            403,
            "BRANCH_POLICY_BLOCKED",
            "GitHub rechazó la publicación.",
          ),
          { remoteMutationAttempted: false },
        );
      throw new ApiError(
        503,
        "PUBLICATION_UNCERTAIN",
        "No se verificó la respuesta.",
      );
    }
    const result = response.data?.createCommitOnBranch?.commit;
    sha.parse(result?.oid);
    const verified = await this.inspectDirect(input, attempt);
    if (
      verified.state !== "committed" ||
      verified.commit.commitSha !== result.oid
    )
      throw new ApiError(
        503,
        "PUBLICATION_UNCERTAIN",
        "No se verificó el commit en main.",
      );
    return verified.commit;
  }
  async inspectDirect(
    input: DirectInput<T>,
    attempt: DirectAttempt,
  ): Promise<DirectInspection> {
    this.directGuard(input, attempt);
    for (const file of input.files) {
      await this.validateDirectFile(file);
      if (file.hash !== hashRevision(file.record))
        throw new ApiError(
          409,
          "DIRECT_PROOF_MISMATCH",
          "El manifiesto no coincide.",
        );
    }
    const head = await this.api("GET", `${this.root}/git/ref/heads/main`);
    const current = sha.parse(head.object?.sha);
    if (current === attempt.expectedHeadOid)
      return { state: "head-unchanged", headCommit: current };
    const comparison = await this.api(
      "GET",
      `${this.root}/compare/${attempt.expectedHeadOid}...${current}?per_page=100`,
    );
    if (
      comparison.status !== "ahead" ||
      comparison.total_commits > 100 ||
      !Array.isArray(comparison.commits) ||
      comparison.commits.length !== comparison.total_commits ||
      comparison.merge_base_commit?.sha !== attempt.expectedHeadOid
    )
      throw new ApiError(
        503,
        "PUBLICATION_UNCERTAIN",
        "El historial no prueba el resultado completo.",
      );
    const candidates = comparison.commits.filter((c: any) =>
      (c.commit?.message ?? "").endsWith(this.directMessage(input, attempt)),
    );
    if (candidates.length > 1)
      throw new ApiError(
        409,
        "DIRECT_PROOF_MISMATCH",
        "La identidad del envío no es única.",
      );
    if (!candidates.length)
      return { state: "absent-proven", headCommit: current };
    const commit = candidates[0];
    sha.parse(commit.sha);
    const detail = await this.api(
      "GET",
      `${this.root}/commits/${commit.sha}?per_page=100`,
    );
    if (
      String(detail.author?.id) !== input.subject ||
      detail.parents?.length !== 1 ||
      detail.parents[0].sha !== attempt.expectedHeadOid ||
      !Array.isArray(detail.files) ||
      detail.files.length !==
        input.files.filter((f) => input.baseHashes[f.path] !== f.hash).length
    )
      throw new ApiError(
        409,
        "DIRECT_PROOF_MISMATCH",
        "El autor, padre o archivos del commit no coinciden.",
      );
    for (const f of input.files.filter(
      (f) => input.baseHashes[f.path] !== f.hash,
    )) {
      const changed = detail.files.find((x: any) => x.filename === f.path);
      if (!changed || !["added", "modified"].includes(changed.status))
        throw new ApiError(
          409,
          "DIRECT_PROOF_MISMATCH",
          "El conjunto de archivos no coincide.",
        );
      const actual = await this.api(
        "GET",
        `${this.root}/contents/${f.path}?ref=${commit.sha}`,
      );
      if (
        actual.type !== "file" ||
        actual.encoding !== "base64" ||
        actual.size > (f.contentBase64 ? 2_000_000 : 500000) ||
        Buffer.from(actual.content ?? "", "base64").toString("base64") !==
          (f.contentBase64 ??
            Buffer.from(JSON.stringify(f.record, null, 2) + "\n").toString(
              "base64",
            ))
      )
        throw new ApiError(
          409,
          "DIRECT_PROOF_MISMATCH",
          "El contenido no coincide.",
        );
      await this.validateDirectFile(f);
    }
    return {
      state: "committed",
      commit: {
        commitSha: commit.sha,
        commitUrl: `https://github.com/${this.config.repository}/commit/${commit.sha}`,
        parent: attempt.expectedHeadOid,
        attemptId: attempt.id,
      },
    };
  }
  async deploymentFor(commit: string, files: ProposalFile<T>[]) {
    const exact = await this.deployment(commit);
    const deployments = await this.api(
      "GET",
      `${this.root}/deployments?environment=github-pages&per_page=10`,
    );
    if (!Array.isArray(deployments))
      throw new ApiError(
        503,
        "REMOTE_RESPONSE_INVALID",
        "No se verificó el despliegue.",
      );
    for (const candidate of deployments) {
      if (
        candidate.environment !== "github-pages" ||
        !Number.isSafeInteger(candidate.id) ||
        !shaSchema.safeParse(candidate.sha).success
      )
        continue;
      const statuses = await this.api(
        "GET",
        `${this.root}/deployments/${candidate.id}/statuses?per_page=1`,
      );
      if (statuses?.[0]?.state !== "success") continue;
      if (candidate.sha === commit)
        return {
          state: "deployed",
          sha: commit,
          url: statuses[0].environment_url,
        };
      const comparison = await this.api(
        "GET",
        `${this.root}/compare/${commit}...${candidate.sha}?per_page=1`,
      );
      if (
        comparison.status !== "ahead" ||
        comparison.merge_base_commit?.sha !== commit
      )
        continue;
      const hashes = await this.hashesDirect(files, candidate.sha);
      let contentReady = files.every((f) => hashes[f.path] === f.hash);
      if (contentReady) {
        try {
          await this.verifyWebsite(
            candidate.sha,
            files
              .filter((f) => !f.contentBase64)
              .map((f) => f.path.split("/")[1]),
          );
        } catch (e: any) {
          if (e.code === "WEBSITE_RENDERER_NOT_READY") contentReady = false;
          else throw e;
        }
      }
      return {
        state: contentReady ? "deployed" : "superseded",
        sha: candidate.sha,
        ...(typeof statuses[0].environment_url === "string" &&
        statuses[0].environment_url.startsWith("https://")
          ? { url: statuses[0].environment_url }
          : {}),
      };
    }
    return { ...exact, sha: commit };
  }
  async deployment(commit: string): Promise<{ state: string; url?: string }> {
    sha.parse(commit);
    const deployments = await this.api(
      "GET",
      `${this.root}/deployments?sha=${commit}&environment=github-pages&per_page=10`,
    );
    if (!Array.isArray(deployments))
      throw new ApiError(
        503,
        "REMOTE_RESPONSE_INVALID",
        "No se verificó el despliegue.",
      );
    const exact = deployments.find(
      (d: any) =>
        d.sha === commit &&
        d.environment === "github-pages" &&
        Number.isSafeInteger(d.id),
    );
    if (!exact) return { state: "pending" };
    const statuses = await this.api(
      "GET",
      `${this.root}/deployments/${Number(exact.id)}/statuses?per_page=1`,
    );
    const latest = statuses?.[0];
    return {
      state:
        latest?.state === "success"
          ? "deployed"
          : ["failure", "error"].includes(latest?.state)
            ? "failed"
            : "pending",
      ...(typeof latest?.environment_url === "string" &&
      latest.environment_url.startsWith("https://")
        ? { url: latest.environment_url }
        : {}),
    };
  }
  async identity() {
    const p = await this.api("GET", "/user");
    const parsed = z
      .object({
        id: z.number().int().safe().positive(),
        login: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
      })
      .safeParse(p);
    if (!parsed.success)
      throw new ApiError(
        503,
        "AUTH_UNAVAILABLE",
        "GitHub no devolvió una identidad personal verificable.",
      );
    const subject = parsed.data.id,
      login = parsed.data.login;
    if (p.type !== "User")
      throw new ApiError(
        403,
        "AUTH_UNAVAILABLE",
        "Se requiere una cuenta personal de GitHub CLI.",
      );
    return { subject: String(subject), login };
  }
  async snapshot(commit?: string): Promise<RemoteSnapshot<T>> {
    const current = commit
      ? sha.parse(commit)
      : sha.parse(
          (
            await this.api(
              "GET",
              `${this.root}/git/ref/heads/${this.config.branch}`,
            )
          ).object?.sha,
        );
    const data = await this.api(
      "GET",
      `${this.root}/git/trees/${current}?recursive=1`,
    );
    if (data.truncated !== false || !Array.isArray(data.tree))
      throw new ApiError(
        503,
        "SNAPSHOT_INCOMPLETE",
        "GitHub devolvió un árbol incompleto. No se reemplazó la copia aprobada.",
      );
    const records = [];
    let bytes = 0;
    for (const entry of data.tree) {
      const match = new RegExp(
        this.allowedWriteType === "jobs"
          ? "^content/(jobs)/((?:greenhouse|lever|manual|hirehive|globant|smartrecruiters):[a-z0-9_-]+:[A-Za-z0-9_-]+)\\.json$"
          : `^content/(${(this.allowedWriteType === "public" ? publicTypes : snapshotTypes).join("|")})/([a-f0-9-]{36})\\.json$`,
      ).exec(entry.path ?? "");
      if (!match) {
        if (
          (this.allowedWriteType === "jobs"
            ? ["jobs"]
            : this.allowedWriteType === "public"
              ? publicTypes
              : snapshotTypes
          ).some((type) =>
            String(entry.path ?? "").startsWith(`content/${type}/`),
          ) &&
          entry.type !== "tree"
        )
          throw new ApiError(
            422,
            "SNAPSHOT_UNSAFE",
            "La colección editorial contiene una ruta no válida.",
          );
        continue;
      }
      if (
        entry.type !== "blob" ||
        entry.mode !== "100644" ||
        entry.size > 500000 ||
        records.length >= 3000
      )
        throw new ApiError(
          422,
          "SNAPSHOT_UNSAFE",
          "El inventario contiene un archivo no permitido.",
        );
      const blob = await this.api(
        "GET",
        `${this.root}/git/blobs/${sha.parse(entry.sha)}`,
      );
      if (blob.encoding !== "base64" || typeof blob.content !== "string")
        throw new ApiError(
          503,
          "SNAPSHOT_INCOMPLETE",
          "No se pudo verificar un registro aprobado.",
        );
      const text = Buffer.from(blob.content, "base64").toString("utf8");
      bytes += Buffer.byteLength(text);
      if (bytes > 25_000_000)
        throw new ApiError(
          422,
          "SNAPSHOT_LIMIT",
          "El inventario supera el límite seguro.",
        );
      let record;
      try {
        record = JSON.parse(text);
      } catch {
        throw new ApiError(
          422,
          "VALIDATION_FAILED",
          "Un registro aprobado no contiene JSON válido.",
        );
      }
      if (record.id !== match[2])
        throw new ApiError(
          422,
          "IDENTITY_MISMATCH",
          "La identidad no coincide con la ruta del registro.",
        );
      if (this.allowedWriteType === "jobs") {
        jobRecordPath(record.id);
        await this.validateRecord(record);
      } else recordPath(match[1], record.id);
      records.push({ type: match[1], record });
    }
    return { commit: current, records };
  }
  async filesAt(paths: string[], commit: string): Promise<ProposalFile<T>[]> {
    const files = [];
    for (const path of paths) {
      if (
        !(
          this.allowedWriteType === "jobs"
            ? /^content\/jobs\/(?:greenhouse|lever|manual|hirehive|globant|smartrecruiters):[a-z0-9_-]+:[A-Za-z0-9_-]+\.json$/
            : /^content\/events\/[a-f0-9-]{36}\.json$/
        ).test(path)
      )
        throw new ApiError(
          409,
          "PROPOSAL_CONTENT_MISMATCH",
          "La propuesta incluye archivos fuera del contrato de Eventos.",
        );
      const file = await this.api(
        "GET",
        `${this.root}/contents/${path}?ref=${sha.parse(commit)}`,
      );
      if (
        file.type !== "file" ||
        file.encoding !== "base64" ||
        typeof file.content !== "string" ||
        file.size > 500000
      )
        throw new ApiError(
          409,
          "PROPOSAL_CONTENT_MISMATCH",
          "No se pudo verificar el archivo propuesto.",
        );
      let record;
      try {
        record = JSON.parse(
          Buffer.from(file.content, "base64").toString("utf8"),
        );
      } catch {
        throw new ApiError(
          409,
          "PROPOSAL_CONTENT_MISMATCH",
          "El archivo propuesto no contiene JSON válido.",
        );
      }
      if (this.writePath(record) !== path)
        throw new ApiError(
          409,
          "PROPOSAL_CONTENT_MISMATCH",
          "La identidad propuesta no coincide.",
        );
      await this.validateRecord(record);
      files.push({ path, record, hash: hashRevision(record) });
    }
    return files;
  }
  async findProposal(branch: string): Promise<RemoteProposal<T> | null> {
    if (!/^editorial\/[a-f0-9]{64}$/.test(branch))
      throw new ApiError(422, "PATH_NOT_ALLOWED", "Rama editorial no válida.");
    const owner = this.config.repository!.split("/")[0];
    const list = await this.api(
      "GET",
      `${this.root}/pulls?state=all&head=${encodeURIComponent(owner + ":" + branch)}&base=${encodeURIComponent(this.config.branch)}&per_page=100`,
    );
    if (!Array.isArray(list) || list.length > 1)
      throw new ApiError(
        409,
        "PROPOSAL_AMBIGUOUS",
        "No se pudo identificar una única propuesta.",
      );
    if (!list.length) return null;
    const pr = await this.api(
      "GET",
      `${this.root}/pulls/${z.number().int().positive().parse(list[0].number)}`,
    );
    if (
      pr.head?.repo?.full_name !== this.config.repository ||
      pr.base?.repo?.full_name !== this.config.repository ||
      pr.head.ref !== branch ||
      pr.base.ref !== this.config.branch ||
      pr.html_url !==
        `https://github.com/${this.config.repository}/pull/${pr.number}`
    )
      throw new ApiError(
        409,
        "PROPOSAL_CONTENT_MISMATCH",
        "La propuesta pertenece a otro repositorio o rama.",
      );
    const changed = await this.api(
      "GET",
      `${this.root}/pulls/${pr.number}/files?per_page=100`,
    );
    if (
      !Array.isArray(changed) ||
      !changed.length ||
      changed.length > 25 ||
      pr.changed_files !== changed.length ||
      changed.some((f) => !["added", "modified"].includes(f.status))
    )
      throw new ApiError(
        409,
        "PROPOSAL_CONTENT_MISMATCH",
        "La propuesta contiene cambios no permitidos.",
      );
    const files = await this.filesAt(
      changed.map((f) => f.filename),
      sha.parse(pr.head.sha),
    );
    let reviewDecision = "unknown",
      checks = "unknown";
    try {
      const reviews = await this.api(
          "GET",
          `${this.root}/pulls/${pr.number}/reviews?per_page=100`,
        ),
        latest = new Map<string, string>();
      if (Array.isArray(reviews) && reviews.length < 100) {
        for (const r of reviews)
          if (
            r.commit_id === pr.head.sha &&
            ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)
          )
            latest.set(String(r.user?.id), r.state);
        reviewDecision = [...latest.values()].includes("CHANGES_REQUESTED")
          ? "changes_requested"
          : [...latest.values()].includes("APPROVED")
            ? "approved"
            : "pending";
      }
      const status = await this.api(
        "GET",
        `${this.root}/commits/${sha.parse(pr.head.sha)}/status`,
      );
      const runs = await this.api(
        "GET",
        `${this.root}/commits/${sha.parse(pr.head.sha)}/check-runs?per_page=100`,
      );
      const list = Array.isArray(runs.check_runs) ? runs.check_runs : [];
      if (runs.total_count === list.length && list.length < 100) {
        const legacyCount = Number(status.total_count ?? 0);
        const legacy = legacyCount > 0 ? status.state : null;
        if (
          list.some((r: any) => r.status !== "completed") ||
          legacy === "pending"
        )
          checks = "pending";
        else if (
          list.some(
            (r: any) =>
              !["success", "neutral", "skipped"].includes(r.conclusion),
          ) ||
          ["failure", "error"].includes(legacy)
        )
          checks = "failure";
        else checks = list.length || legacyCount ? "success" : "unknown";
      }
    } catch {
      /* Provider review/check visibility is optional; unknown is never success. */
    }
    return {
      number: pr.number,
      url: pr.html_url,
      headCommit: sha.parse(pr.head.sha),
      state: pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open",
      mergeCommit: pr.merged ? sha.parse(pr.merge_commit_sha) : null,
      files,
      marker:
        /editorial-proposal:([a-f0-9]{64})/.exec(pr.body ?? "")?.[1] ?? "",
      branch: pr.head.ref,
      baseBranch: pr.base.ref,
      authorSubject: String(pr.user?.id ?? ""),
      reviewDecision,
      checks,
    };
  }
  async createProposal(input: ProposalInput<T>): Promise<RemoteProposal<T>> {
    if (!this.config.remoteWritesEnabled)
      throw new ApiError(
        403,
        "REMOTE_WRITES_DISABLED",
        "Las escrituras editoriales están deshabilitadas.",
      );
    if (!/^[1-9][0-9]{0,19}$/.test(input.subject ?? ""))
      throw new ApiError(
        403,
        "AUTH_UNAVAILABLE",
        "Falta la identidad personal verificada.",
      );
    const scoped = new GhEditorialTransport<T>(
      this.config,
      this.execute,
      input.subject,
      this.allowedWriteType,
    );
    try {
      return await scoped.createBound(input);
    } catch (error) {
      if (error instanceof Error)
        (
          error as Error & { remoteMutationAttempted: boolean }
        ).remoteMutationAttempted = scoped.mutationAttempted;
      throw error;
    }
  }
  async inspectProposal(input: ProposalInput<T>): Promise<{
    state: "absent" | "branch_verified";
    headCommit: string | null;
  }> {
    if ((await this.identity()).subject !== input.subject)
      throw new ApiError(
        403,
        "AUTH_IDENTITY_MISMATCH",
        "La cuenta activa no coincide con esta propuesta.",
      );
    // A successful configured-branch read establishes repository access before a missing proposal ref is accepted.
    await this.api("GET", `${this.root}/git/ref/heads/${this.config.branch}`);
    let branch;
    try {
      branch = await this.api(
        "GET",
        `${this.root}/git/ref/heads/${input.branch}`,
      );
    } catch (error) {
      if (error instanceof GhHttpError && error.httpStatus === 404)
        return { state: "absent", headCommit: null };
      throw error;
    }
    const head = sha.parse(branch.object?.sha),
      commit = await this.api("GET", `${this.root}/git/commits/${head}`);
    if (
      !commit.message?.includes(`editorial-proposal:${input.id}`) ||
      commit.parents?.length !== 1 ||
      commit.parents[0].sha !== input.baseCommit
    )
      throw new ApiError(
        409,
        "PROPOSAL_CONTENT_MISMATCH",
        "La rama pendiente no coincide con la propuesta local.",
      );
    const diff = await this.api(
      "GET",
      `${this.root}/compare/${sha.parse(input.baseCommit)}...${head}`,
    );
    if (
      !Array.isArray(diff.files) ||
      diff.files.length !== input.files.length ||
      diff.files.some((f: any) => !["added", "modified"].includes(f.status))
    )
      throw new ApiError(
        409,
        "PROPOSAL_CONTENT_MISMATCH",
        "La rama pendiente incluye otros cambios.",
      );
    const files = await this.filesAt(
      diff.files.map((f: any) => f.filename),
      head,
    );
    const signature = (values: ProposalFile<T>[]) =>
      hashRevision(
        values
          .map((f) => ({ path: f.path, record: f.record }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      );
    if (signature(files) !== signature(input.files))
      throw new ApiError(
        409,
        "PROPOSAL_CONTENT_MISMATCH",
        "La revisión remota pendiente es diferente.",
      );
    return { state: "branch_verified", headCommit: head };
  }
  private async createBound(
    input: ProposalInput<T>,
  ): Promise<RemoteProposal<T>> {
    if (!this.config.remoteWritesEnabled)
      throw new ApiError(
        403,
        "REMOTE_WRITES_DISABLED",
        "Las escrituras editoriales están deshabilitadas.",
      );
    if (
      input.branch !== `editorial/${input.id}` ||
      !/^[a-f0-9]{64}$/.test(input.id) ||
      !input.files.length ||
      input.files.length > 25
    )
      throw new ApiError(
        422,
        "PROPOSAL_INVALID",
        "Propuesta editorial no válida.",
      );
    const existing = await this.findProposal(input.branch);
    if (existing) return existing;
    let branch: any;
    try {
      branch = await this.api(
        "GET",
        `${this.root}/git/ref/heads/${input.branch}`,
      );
    } catch (e) {
      if (!(e instanceof GhHttpError) || e.httpStatus !== 404) throw e;
    }
    if (branch) {
      const commit = await this.api(
        "GET",
        `${this.root}/git/commits/${sha.parse(branch.object?.sha)}`,
      );
      if (
        !commit.message?.includes(`editorial-proposal:${input.id}`) ||
        commit.parents?.length !== 1 ||
        commit.parents[0].sha !== input.baseCommit
      )
        throw new ApiError(
          409,
          "PROPOSAL_CONTENT_MISMATCH",
          "La rama propuesta ya tiene otros cambios.",
        );
      const diff = await this.api(
        "GET",
        `${this.root}/compare/${sha.parse(input.baseCommit)}...${sha.parse(branch.object.sha)}`,
      );
      const actual = await this.filesAt(
        (diff.files ?? []).map((f: any) => f.filename),
        branch.object.sha,
      );
      if (
        hashRevision(
          actual
            .map((f) => ({ path: f.path, record: f.record }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        ) !==
        hashRevision(
          input.files
            .map((f) => ({ path: f.path, record: f.record }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        )
      )
        throw new ApiError(
          409,
          "PROPOSAL_CONTENT_MISMATCH",
          "La rama no contiene la revisión preparada.",
        );
    } else {
      const base = await this.api(
        "GET",
        `${this.root}/git/commits/${sha.parse(input.baseCommit)}`,
      );
      const tree = await this.api("POST", `${this.root}/git/trees`, {
        base_tree: sha.parse(base.tree?.sha),
        tree: input.files.map((f) => {
          if (this.writePath(f.record) !== f.path)
            throw new ApiError(
              422,
              "PATH_NOT_ALLOWED",
              "Archivo no permitido.",
            );
          return {
            path: f.path,
            mode: "100644",
            type: "blob",
            content: canonicalJson(f.record) + "\n",
          };
        }),
      });
      const commit = await this.api("POST", `${this.root}/git/commits`, {
        message: `Update community ${this.allowedWriteType}\n\neditorial-proposal:${input.id}`,
        tree: sha.parse(tree.sha),
        parents: [input.baseCommit],
      });
      await this.api("POST", `${this.root}/git/refs`, {
        ref: `refs/heads/${input.branch}`,
        sha: sha.parse(commit.sha),
      });
    }
    await this.api("POST", `${this.root}/pulls`, {
      title: input.title,
      head: input.branch,
      base: this.config.branch,
      body: `Public event proposal for repository review. Local drafts do not publish automatically.\n\neditorial-proposal:${input.id}`,
    });
    const result = await this.findProposal(input.branch);
    if (!result)
      throw new ApiError(
        503,
        "PROPOSAL_UNCERTAIN",
        "GitHub todavía no confirma la propuesta enviada.",
      );
    return result;
  }
}
