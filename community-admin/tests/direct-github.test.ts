import test from "node:test";
import assert from "node:assert/strict";
import { GhEditorialTransport } from "../src/server/editorial-sync/github";
import {
  directDigest,
  type DirectAttempt,
} from "../src/server/editorial-sync/direct";
import { hashRevision } from "../src/shared/content";
import { normalizeJob, publicJobs } from "../src/server/jobs/engine";
const H = "a".repeat(40),
  C = "b".repeat(40),
  config = {
    mode: "github" as const,
    repository: "platform-engineering-peru/platform-engineering-web",
    branch: "main",
    remoteWritesEnabled: true,
  };
function fixture() {
  const record = publicJobs([
    {
      ...normalizeJob(
        {
          id: "one",
          title: "Platform Engineer",
          location: { name: "Remote Peru" },
          absolute_url: "https://example.com/job",
        },
        {
          id: "fixture",
          adapter: "greenhouse",
          boardIdentifier: "fixture",
          company: "Example",
        },
        new Date(),
      ),
      status: "active",
      approved: true,
      summary: { "es-pe": "Plataforma.", en: "Platform." },
    },
  ])[0];
  const input = {
    id: "1".repeat(64),
    subject: "42",
    repository: config.repository,
    branch: "main",
    baseCommit: H,
    baseHashes: { [`content/jobs/${record.id}.json`]: null },
    files: [
      {
        path: `content/jobs/${record.id}.json`,
        record,
        hash: hashRevision(record),
      },
    ],
  };
  const digest = directDigest(input);
  const attempt: DirectAttempt = {
    id: hashRevision({ operation: input.id, head: H, digest }),
    operationId: input.id,
    expectedHeadOid: H,
    digest,
    state: "sending",
  };
  let branch = H,
    spoof = "",
    error: any = null;
  const calls: any[] = [];
  const message = `Publish community jobs\n\nWebsite operation: ${input.id}\nAttempt: ${attempt.id}\nPayload: ${attempt.digest}`;
  const executor = async (args: string[], stdin?: string) => {
    calls.push({ args, stdin });
    if (args.includes("graphql")) {
      const body = JSON.parse(stdin!);
      assert.deepEqual(Object.keys(body).sort(), ["query", "variables"]);
      assert.deepEqual(Object.keys(body.variables.input).sort(), [
        "branch",
        "clientMutationId",
        "expectedHeadOid",
        "fileChanges",
        "message",
      ]);
      assert.equal(body.variables.input.expectedHeadOid, H);
      // GitHub CommittableBranch input uses branchName, not the REST refName spelling.
      assert.deepEqual(body.variables.input.branch, {
        repositoryNameWithOwner: config.repository,
        branchName: "main",
      });
      assert.equal(
        Object.hasOwn(body.variables.input.branch, "refName"),
        false,
      );
      assert.equal(body.variables.input.fileChanges.deletions, undefined);
      if (error) return JSON.stringify(error);
      branch = C;
      return JSON.stringify({
        data: {
          createCommitOnBranch: {
            commit: { oid: C, url: "https://github.com/example/commit/" + C },
          },
        },
      });
    }
    const endpoint = args.at(-1)!;
    let body: any;
    if (endpoint === "/user") body = { id: 42, login: "owner", type: "User" };
    else if (endpoint.includes("/git/ref/heads/"))
      body = { object: { sha: branch } };
    else if (endpoint.includes("/compare/"))
      body = {
        status: "ahead",
        total_commits: spoof === "truncated" ? 101 : 1,
        merge_base_commit: { sha: H },
        commits: [{ sha: C, commit: { message } }],
      };
    else if (endpoint.includes("/commits/"))
      body = {
        author: { id: spoof === "author" ? 43 : 42 },
        parents: [{ sha: spoof === "parent" ? C : H }],
        files: [
          { filename: input.files[0].path, status: "added" },
          ...(spoof === "extra"
            ? [{ filename: "private.json", status: "added" }]
            : []),
        ],
      };
    else if (endpoint.includes("/contents/"))
      body = {
        type: "file",
        encoding: "base64",
        size: 100,
        content: Buffer.from(
          JSON.stringify(
            spoof === "bytes" ? { ...record, title: "changed" } : record,
            null,
            2,
          ) + "\n",
        ).toString("base64"),
      };
    else throw Error(endpoint);
    return "HTTP/2.0 200 OK\r\n\r\n" + JSON.stringify(body);
  };
  return {
    input,
    attempt,
    transport: new GhEditorialTransport<any>(
      config,
      executor,
      undefined,
      "jobs",
    ),
    calls,
    setSpoof: (s: string) => {
      spoof = s;
      branch = C;
    },
    setError: (e: any) => (error = e),
  };
}
test("fixed GraphQL atomic mutation uses exact expected head, additions and parent/author/bytes proof without PR calls", async () => {
  const f = fixture();
  const proof = await f.transport.commitDirect(f.input, f.attempt);
  assert.equal(proof.commitSha, C);
  assert.equal(f.calls.filter((x) => x.args.includes("graphql")).length, 1);
  assert.equal(
    f.calls.some((x) => x.args.some((a: string) => /pulls|git\/refs$/.test(a))),
    false,
  );
});
test("recovery rejects spoofed author/parent/extra files/bytes and truncated history", async () => {
  for (const spoof of ["author", "parent", "extra", "bytes", "truncated"]) {
    const f = fixture();
    f.setSpoof(spoof);
    await assert.rejects(f.transport.inspectDirect(f.input, f.attempt), {
      code:
        spoof === "truncated"
          ? "PUBLICATION_UNCERTAIN"
          : "DIRECT_PROOF_MISMATCH",
    });
  }
});
test("exact documented expected-branch mismatch is retryable, policy rejection is blocked, ambiguous errors remain uncertain", async () => {
  const f = fixture();
  f.setError({
    errors: [
      {
        type: "UNPROCESSABLE",
        message: `Expected branch to point to "${H}", but it did not.`,
      },
    ],
  });
  await assert.rejects(f.transport.commitDirect(f.input, f.attempt), {
    code: "HEAD_CHANGED",
    remoteMutationAttempted: false,
  });
  const denied = fixture();
  denied.setError({
    errors: [{ type: "FORBIDDEN", message: "branch policy" }],
  });
  await assert.rejects(
    denied.transport.commitDirect(denied.input, denied.attempt),
    { code: "BRANCH_POLICY_BLOCKED", remoteMutationAttempted: false },
  );
  const unknown = fixture();
  unknown.setError({
    errors: [{ type: "INTERNAL", message: "partial response" }],
    data: {},
  });
  await assert.rejects(
    unknown.transport.commitDirect(unknown.input, unknown.attempt),
    { code: "PUBLICATION_UNCERTAIN" },
  );
});

test("generic and Events publication are gated by the shipped reviewed renderer compatibility descriptor", async () => {
  const publicTransport = new GhEditorialTransport<any>(
    config,
    async () => {
      return "HTTP/2.0 404 Not Found\r\n\r\n{}";
    },
    undefined,
    "public",
  );
  await assert.rejects(publicTransport.verifyWebsite(H, ["resources"]), {
    code: "WEBSITE_RENDERER_NOT_READY",
  });
  await assert.rejects(
    new GhEditorialTransport<any>(config, async () => {
      return "HTTP/2.0 404 Not Found\r\n\r\n{}";
    }).verifyWebsite(H, ["events"]),
    { code: "WEBSITE_RENDERER_NOT_READY" },
  );
});

test("deployment evidence keeps actual descendant SHA and distinguishes superseded content and failed deployment", async () => {
  const f = fixture();
  let changed = false,
    failed = false;
  f.transport.api = async (_method, path) => {
    if (path.includes("/deployments?sha="))
      return failed ? [{ id: 1, sha: H, environment: "github-pages" }] : [];
    if (path.includes("/deployments?environment="))
      return failed ? [] : [{ id: 2, sha: C, environment: "github-pages" }];
    if (path.includes("/deployments/1/statuses")) return [{ state: "failure" }];
    if (path.includes("/deployments/2/statuses"))
      return [
        { state: "success", environment_url: "https://example.github.io/" },
      ];
    if (path.includes("/compare/"))
      return { status: "ahead", merge_base_commit: { sha: H } };
    throw Error("unexpected " + path);
  };
  f.transport.hashesDirect = async () => ({
    [f.input.files[0].path]: changed ? "changed" : f.input.files[0].hash,
  });
  f.transport.verifyWebsite = async () => {};
  const descendant = await f.transport.deploymentFor(H, f.input.files);
  assert.equal(descendant.state, "deployed");
  assert.equal(descendant.sha, C);
  changed = true;
  assert.equal(
    (await f.transport.deploymentFor(H, f.input.files)).state,
    "superseded",
  );
  failed = true;
  assert.equal(
    (await f.transport.deploymentFor(H, f.input.files)).state,
    "failed",
  );
});
