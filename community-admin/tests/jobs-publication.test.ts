import test from "node:test";
import assert from "node:assert/strict";
import { GhEditorialTransport } from "../src/server/editorial-sync/github";
import { publicJobs, normalizeJob } from "../src/server/jobs/engine";
import {
  jobRecordPath,
  type PublicJobRecord,
} from "../src/server/jobs/publication-contract";
const config = {
    mode: "github" as const,
    repository: "example/community",
    branch: "main",
    remoteWritesEnabled: true,
  },
  sha = "a".repeat(40);
const http = (body: unknown) =>
  `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(body)}`;
const job = () =>
  publicJobs([
    {
      ...normalizeJob(
        {
          id: "1",
          title: "Platform Engineer",
          location: { name: "Peru" },
          content: "Work Mode: Hybrid",
          absolute_url: "https://jobs.lever.co/example/1",
        },
        {
          id: "example",
          adapter: "lever",
          company: "Example",
          boardIdentifier: "example",
        },
        new Date("2026-11-18"),
      ),
      status: "active",
      approved: true,
      summary: {
        "es-pe": "Ingeniería de plataforma.",
        en: "Platform engineering.",
      },
    },
  ])[0] as PublicJobRecord;
test("jobs CLI instance validates dedicated namespace/schema and Events instance rejects jobs", async () => {
  const calls: any[] = [];
  const execute = async (args: string[], stdin?: string) => {
    calls.push({ args, stdin });
    return http({ id: 42, login: "owner", type: "User", sha });
  };
  const jobs = new GhEditorialTransport<PublicJobRecord>(
      config,
      execute,
      "42",
      "jobs",
    ),
    events = new GhEditorialTransport(config, execute, "42");
  const record = job(),
    body = {
      base_tree: sha,
      tree: [
        {
          path: jobRecordPath(record.id),
          mode: "100644",
          type: "blob",
          content: JSON.stringify(record),
        },
      ],
    };
  await jobs.api("POST", "/repos/example/community/git/trees", body);
  await assert.rejects(
    events.api("POST", "/repos/example/community/git/trees", body),
  );
  await assert.rejects(
    jobs.api("POST", "/repos/example/community/git/trees", {
      ...body,
      tree: [
        {
          ...body.tree[0],
          path: "content/events/40000000-0000-4000-8000-000000000001.json",
        },
      ],
    }),
  );
  await assert.rejects(
    jobs.api("POST", "/repos/example/community/git/trees", {
      ...body,
      tree: [
        {
          ...body.tree[0],
          content: JSON.stringify({
            ...record,
            privateEmail: "private@example.com",
          }),
        },
      ],
    }),
  );
  await assert.rejects(
    jobs.api("POST", "/repos/example/community/git/refs", {
      ref: "refs/heads/main",
      sha,
    }),
  );
  assert.ok(!calls.flatMap((c) => c.args).includes("token"));
  for (const bad of [
    "manual:../evil:1",
    "manual:example:../1",
    "manual:example:%2fsecret",
    "manual:example:a/b",
    "../x",
  ])
    assert.throws(() => jobRecordPath(bad));
});
test("job immutable snapshot preserves colon filenames, rejects malformed job data and ignores events", async () => {
  const record = job();
  const gh = new GhEditorialTransport<PublicJobRecord>(
    config,
    async (args) => {
      const path = args.find((a) => a.startsWith("/"))!;
      if (path.includes("/git/ref/")) return http({ object: { sha } });
      if (path.includes("/git/trees/"))
        return http({
          truncated: false,
          tree: [
            {
              path: jobRecordPath(record.id),
              type: "blob",
              mode: "100644",
              size: 100,
              sha,
            },
            {
              path: "content/events/40000000-0000-4000-8000-000000000001.json",
              type: "blob",
              mode: "100644",
              sha,
            },
          ],
        });
      return http({
        encoding: "base64",
        content: Buffer.from(JSON.stringify(record)).toString("base64"),
      });
    },
    "42",
    "jobs",
  );
  assert.deepEqual((await gh.snapshot()).records, [{ type: "jobs", record }]);
});
