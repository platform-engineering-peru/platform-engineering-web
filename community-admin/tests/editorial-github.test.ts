import test from "node:test";
import assert from "node:assert/strict";
import {
  GhEditorialTransport,
  type GhExecutor,
} from "../src/server/editorial-sync/github";
import {
  eventProjection,
  validateSnapshot,
} from "../src/server/editorial-sync/validation";
import { entityDefinitions } from "../src/shared/product-contract";
import { hashRevision } from "../src/shared/content";
const config = {
    mode: "github" as const,
    repository: "example/community",
    branch: "main",
    remoteWritesEnabled: true,
  },
  head = "a".repeat(40),
  blob = "b".repeat(40);
const http = (body: unknown, status = 200) =>
  `HTTP/2.0 ${status} OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;
const p = () => ({
  ...structuredClone(
    entityDefinitions.find((d) => d.type === "events")!.defaults,
  ),
  slug: "gh-test",
  title: { "es-pe": "Prueba", en: "Test" },
  description: { "es-pe": "Prueba local.", en: "Local test." },
  city: { "es-pe": "Lima", en: "Lima" },
  date: "2026-12-01",
});
const id = "40000000-0000-4000-8000-000000000001";
test("gh adapter uses fixed hostname/argv and JSON stdin, never token commands or arbitrary paths", async () => {
  const calls: { args: string[]; stdin?: string }[] = [];
  const executor: GhExecutor = async (args, stdin) => {
    calls.push({ args, stdin });
    return http({ id: 42, login: "person", type: "User" });
  };
  const gh = new GhEditorialTransport(config, executor, "42");
  assert.deepEqual(await gh.identity(), { subject: "42", login: "person" });
  const record = await eventProjection(
    id,
    {
      ...p(),
      description: {
        "es-pe": 'quote " and $(not-a-shell)',
        en: 'quote " and $(not-a-shell)',
      },
    },
    "published",
  );
  const body = {
    base_tree: head,
    tree: [
      {
        path: `content/events/${id}.json`,
        mode: "100644",
        type: "blob",
        content: JSON.stringify(record),
      },
    ],
  };
  await gh.api("POST", "/repos/example/community/git/trees", body);
  assert.equal(calls[0].args[0], "api");
  assert.equal(calls[0].args[2], "github.com");
  assert.ok(!calls.flatMap((c) => c.args).includes("token"));
  assert.deepEqual(JSON.parse(calls[2].stdin!), body);
  assert.deepEqual(calls[2].args.slice(-2), ["--input", "-"]);
  await assert.rejects(gh.api("GET", "https://evil.example.org/credentials"));
  await assert.rejects(gh.api("POST", "/repos/example/community/merges", {}));
  await assert.rejects(
    gh.api("POST", "/repos/example/community/git/refs", {
      ref: "refs/heads/main",
      sha: head,
    }),
  );
});
test("canonical snapshot reads immutable SHA and validates complete selected public collections", async () => {
  const record = await eventProjection(id, p(), "published"),
    paths: string[] = [];
  const gh = new GhEditorialTransport(config, async (args) => {
    const path = args.find((a) => a.startsWith("/"))!;
    paths.push(path);
    if (path.includes("/git/ref/")) return http({ object: { sha: head } });
    if (path.includes("/git/trees/"))
      return http({
        truncated: false,
        tree: [
          {
            path: `content/events/${id}.json`,
            type: "blob",
            mode: "100644",
            sha: blob,
            size: 200,
          },
          {
            path: "private/contacts.json",
            type: "blob",
            mode: "100644",
            sha: "d".repeat(40),
            size: 200,
          },
        ],
      });
    if (path.includes("/git/blobs/"))
      return http({
        encoding: "base64",
        content: Buffer.from(JSON.stringify(record)).toString("base64"),
      });
    throw new Error("unexpected");
  });
  const snapshot = await gh.snapshot();
  await validateSnapshot(snapshot.records);
  assert.equal(snapshot.commit, head);
  assert.equal(snapshot.records.length, 1);
  assert.ok(
    paths.includes(`/repos/example/community/git/trees/${head}?recursive=1`),
  );
  assert.ok(!paths.some((p) => p.includes("private")));
});
test("truncated, malformed, unsafe and unavailable snapshots fail closed instead of empty", async () => {
  const record = await eventProjection(id, p(), "published");
  for (const mode of [
    "truncated",
    "missing",
    "malformed",
    "wrong-id",
    "symlink",
    "bad-path",
    "forbidden",
  ] as const) {
    const gh = new GhEditorialTransport(config, async (args) => {
      const path = args.find((a) => a.startsWith("/"))!;
      if (path.includes("/git/ref/")) return http({ object: { sha: head } });
      if (path.includes("/git/trees/"))
        return http({
          truncated: mode === "truncated",
          tree: [
            {
              path:
                mode === "bad-path"
                  ? "content/events/not-a-stable-id.json"
                  : `content/events/${id}.json`,
              type: "blob",
              mode: mode === "symlink" ? "120000" : "100644",
              sha: blob,
              size: 200,
            },
          ],
        });
      if (mode === "missing" || mode === "forbidden")
        return http(
          { message: "provider error" },
          mode === "missing" ? 404 : 403,
        );
      return http({
        encoding: "base64",
        content: Buffer.from(
          mode === "malformed"
            ? "invalid JSON"
            : JSON.stringify({
                ...record,
                id:
                  mode === "wrong-id"
                    ? "40000000-0000-4000-8000-000000000002"
                    : id,
              }),
        ).toString("base64"),
      });
    });
    await assert.rejects(
      gh.snapshot(),
      (e: unknown) => e instanceof Error,
      mode,
    );
  }
});
test("proposal inspection verifies actual changed files and not only a marker", async () => {
  const record = await eventProjection(id, p(), "published"),
    proposalId = "e".repeat(64),
    branch = "editorial/" + proposalId;
  let extra = false;
  const gh = new GhEditorialTransport(config, async (args) => {
    const path = args.find((a) => a.startsWith("/"))!;
    if (path.includes("/pulls?")) return http([{ number: 7 }]);
    if (path.endsWith("/pulls/7"))
      return http({
        number: 7,
        html_url: "https://github.com/example/community/pull/7",
        head: {
          sha: head,
          ref: branch,
          repo: { full_name: "example/community" },
        },
        base: { ref: "main", repo: { full_name: "example/community" } },
        changed_files: 1,
        body: "editorial-proposal:" + proposalId,
        user: { id: 42 },
        state: "open",
        merged: false,
      });
    if (path.includes("/files?"))
      return http([
        {
          filename: extra
            ? "private/contacts.json"
            : `content/events/${id}.json`,
          status: "modified",
        },
      ]);
    if (path.includes("/contents/"))
      return http({
        type: "file",
        encoding: "base64",
        content: Buffer.from(JSON.stringify(record)).toString("base64"),
        size: 200,
      });
    if (path.includes("/reviews?")) return http([]);
    if (path.includes("/status"))
      return http({ state: "pending", total_count: 1 });
    if (path.includes("/check-runs"))
      return http({ total_count: 0, check_runs: [] });
    throw new Error("unexpected");
  });
  const found = await gh.findProposal(branch);
  assert.equal(found!.files[0].hash, hashRevision(record));
  assert.equal(found!.checks, "pending");
  extra = true;
  await assert.rejects(
    gh.findProposal(branch),
    (e: any) => e.code === "PROPOSAL_CONTENT_MISMATCH",
  );
});
test("write-disabled transport cannot mutate even if invoked without the service", async () => {
  let calls = 0;
  const gh = new GhEditorialTransport(
    { ...config, remoteWritesEnabled: false },
    async () => {
      calls++;
      return http({});
    },
  );
  await assert.rejects(
    gh.createProposal({
      subject: "42",
      id: "e".repeat(64),
      branch: "editorial/" + "e".repeat(64),
      baseCommit: head,
      files: [],
      title: "test",
    }),
    (e: any) => e.code === "REMOTE_WRITES_DISABLED",
  );
  assert.equal(calls, 0);
});

test("atomic proposal creates only a new editorial ref and rechecks identity before mutations", async () => {
  const record = await eventProjection(id, p(), "published"),
    proposalId = "e".repeat(64),
    branch = "editorial/" + proposalId;
  for (const switchAccount of [false, true]) {
    let created = false,
      subject = 42;
    const writes: { path: string; body: any }[] = [];
    const gh = new GhEditorialTransport(config, async (args, stdin) => {
      const path = args.find((a) => a.startsWith("/"))!,
        method = args[args.indexOf("--method") + 1],
        body = stdin ? JSON.parse(stdin) : undefined;
      if (path === "/user")
        return http({ id: subject, login: "person", type: "User" });
      if (method === "POST") {
        writes.push({ path, body });
        if (path.endsWith("/git/trees")) {
          if (switchAccount) subject = 43;
          return http({ sha: "c".repeat(40) });
        }
        if (path.endsWith("/git/commits")) return http({ sha: "d".repeat(40) });
        if (path.endsWith("/git/refs"))
          return http({ object: { sha: "d".repeat(40) } });
        if (path.endsWith("/pulls")) {
          created = true;
          return http({ number: 8 });
        }
      }
      if (path.includes("/pulls?")) return http(created ? [{ number: 8 }] : []);
      if (path.endsWith("/git/ref/heads/" + branch)) return http({}, 404);
      if (path.endsWith("/git/commits/" + head))
        return http({ tree: { sha: "f".repeat(40) } });
      if (path.endsWith("/pulls/8"))
        return http({
          number: 8,
          html_url: "https://github.com/example/community/pull/8",
          head: {
            sha: "d".repeat(40),
            ref: branch,
            repo: { full_name: "example/community" },
          },
          base: { ref: "main", repo: { full_name: "example/community" } },
          changed_files: 1,
          body: "editorial-proposal:" + proposalId,
          user: { id: 42 },
          state: "open",
          merged: false,
        });
      if (path.includes("/files?"))
        return http([
          { filename: `content/events/${id}.json`, status: "modified" },
        ]);
      if (path.includes("/contents/"))
        return http({
          type: "file",
          encoding: "base64",
          size: 500,
          content: Buffer.from(JSON.stringify(record)).toString("base64"),
        });
      if (path.includes("/reviews?"))
        return http([
          { state: "APPROVED", commit_id: "a".repeat(40), user: { id: 99 } },
        ]);
      if (path.includes("/status"))
        return http({ state: "success", total_count: 1 });
      if (path.includes("/check-runs"))
        return http({
          total_count: 1,
          check_runs: [{ status: "completed", conclusion: "failure" }],
        });
      throw new Error("unexpected " + path);
    });
    const intent = {
      subject: "42",
      id: proposalId,
      branch,
      baseCommit: head,
      files: [
        {
          path: `content/events/${id}.json`,
          record,
          hash: hashRevision(record),
        },
      ],
      title: "Test event proposal",
    };
    if (switchAccount) {
      await assert.rejects(
        gh.createProposal(intent),
        (e: any) => e.code === "AUTH_IDENTITY_MISMATCH",
      );
      assert.equal(
        writes.length,
        1,
        "Only unreferenced tree written before account changed",
      );
    } else {
      const result = await gh.createProposal(intent);
      assert.equal(result.number, 8);
      assert.equal(
        result.reviewDecision,
        "pending",
        "Old-head approval is not current",
      );
      assert.equal(
        result.checks,
        "failure",
        "Failed check runs override legacy success",
      );
      assert.equal(writes.length, 4);
      assert.equal(
        writes.find((w) => w.path.endsWith("/git/refs"))!.body.ref,
        "refs/heads/" + branch,
      );
      assert.deepEqual(
        writes.find((w) => w.path.endsWith("/git/commits"))!.body.parents,
        [head],
      );
      assert.ok(writes.every((w) => !w.body.force));
      assert.doesNotThrow(() => JSON.parse(writes[0].body.tree[0].content));
    }
  }
});

test("real adapter resumes verified missing stages after pre-write, after-ref and post-PR failures", async () => {
  const record = await eventProjection(id, p(), "published"),
    proposalId = "f".repeat(64),
    branch = "editorial/" + proposalId,
    path = `content/events/${id}.json`;
  for (const phase of ["before-write", "after-ref", "after-pr"]) {
    let ref = false,
      pr = false,
      failOnce = true;
    const writes: string[] = [];
    const gh = new GhEditorialTransport(config, async (args, stdin) => {
      const endpoint = args.find((a) => a.startsWith("/"))!,
        method = args[args.indexOf("--method") + 1];
      if (endpoint === "/user")
        return http({ id: 42, login: "person", type: "User" });
      if (endpoint.includes("/pulls?")) return http(pr ? [{ number: 9 }] : []);
      if (endpoint.endsWith("/git/ref/heads/main"))
        return http({ object: { sha: head } });
      if (endpoint.endsWith("/git/ref/heads/" + branch)) {
        if (phase === "before-write" && failOnce) {
          failOnce = false;
          throw new Error("Read unavailable before mutation");
        }
        return ref ? http({ object: { sha: "d".repeat(40) } }) : http({}, 404);
      }
      if (endpoint.endsWith("/git/commits/" + head))
        return http({ tree: { sha: "c".repeat(40) } });
      if (endpoint.endsWith("/git/commits/" + "d".repeat(40)))
        return http({
          message: "editorial-proposal:" + proposalId,
          parents: [{ sha: head }],
        });
      if (endpoint.includes("/compare/"))
        return http({ files: [{ filename: path, status: "modified" }] });
      if (endpoint.includes("/contents/"))
        return http({
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(record)).toString("base64"),
          size: 500,
        });
      if (method === "POST") {
        writes.push(endpoint);
        const body = JSON.parse(stdin!);
        if (endpoint.endsWith("/git/trees")) {
          assert.equal(body.tree[0].path, path);
          return http({ sha: "c".repeat(40) });
        }
        if (endpoint.endsWith("/git/commits"))
          return http({ sha: "d".repeat(40) });
        if (endpoint.endsWith("/git/refs")) {
          ref = true;
          if (phase === "after-ref" && failOnce) {
            failOnce = false;
            throw new Error("Lost response after ref");
          }
          return http({});
        }
        if (endpoint.endsWith("/pulls")) {
          pr = true;
          if (phase === "after-pr" && failOnce) {
            failOnce = false;
            throw new Error("Lost response after PR");
          }
          return http({ number: 9 });
        }
      }
      if (endpoint.endsWith("/pulls/9"))
        return http({
          number: 9,
          html_url: "https://github.com/example/community/pull/9",
          head: {
            sha: "d".repeat(40),
            ref: branch,
            repo: { full_name: "example/community" },
          },
          base: { ref: "main", repo: { full_name: "example/community" } },
          changed_files: 1,
          body: "editorial-proposal:" + proposalId,
          user: { id: 42 },
          state: "open",
          merged: false,
        });
      if (endpoint.includes("/files?"))
        return http([{ filename: path, status: "modified" }]);
      if (endpoint.includes("/reviews?")) return http([]);
      if (endpoint.includes("/status"))
        return http({ state: "pending", total_count: 0 });
      if (endpoint.includes("/check-runs"))
        return http({ total_count: 0, check_runs: [] });
      throw new Error(endpoint);
    });
    const input = {
      subject: "42",
      id: proposalId,
      branch,
      baseCommit: head,
      files: [{ path, record, hash: hashRevision(record) }],
      title: "Isolated recovery",
    };
    await assert.rejects(
      gh.createProposal(input),
      (e: any) => e.remoteMutationAttempted === (phase !== "before-write"),
      phase,
    );
    if (phase === "after-ref") {
      const before = writes.length;
      assert.equal((await gh.inspectProposal(input)).state, "branch_verified");
      assert.equal(writes.length, before, "Inspect is read-only");
    }
    const recovered = await gh.createProposal(input);
    assert.equal(recovered.number, 9, phase);
    assert.equal(
      writes.filter((p) => p.endsWith("/git/refs")).length,
      1,
      phase,
    );
    assert.equal(writes.filter((p) => p.endsWith("/pulls")).length, 1, phase);
  }
});
