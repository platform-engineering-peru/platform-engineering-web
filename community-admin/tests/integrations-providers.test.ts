import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { GitHub } from "../src/server/integrations/github";
import {
  LinkedIn,
  YouTube,
  type Connector,
} from "../src/server/integrations/social";
import { collectSource, reconcileJobs } from "../src/server/jobs/engine";
import { IntegrationError } from "../src/server/integrations/security";
import type { Transport } from "../src/server/integrations/http";
const response = (
  data: any,
  status = 200,
  headers: Record<string, string> = {},
) => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: Buffer.from(JSON.stringify(data)),
});
const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const config = {
  appId: "1",
  installationId: "2",
  privateKey: key,
  owner: "fixture",
  repo: "website",
  enabled: true,
  requiredChecks: ["Validate website"],
  requiredApprovals: 1,
};
test("GitHub atomic commit and one-PR idempotency with scoped token", async () => {
  const calls: any[] = [];
  let pr: any = null;
  const transport: Transport = async (url, opt) => {
    calls.push({ url, opt });
    if (url.endsWith("/access_tokens"))
      return response({
        token: "fixture-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    if (url.includes("/pulls?")) return response(pr ? [pr] : []);
    if (url.endsWith("/git/ref/heads/main"))
      return response({ object: { sha: "main" } });
    if (url.endsWith("/git/ref/heads/content/fixture"))
      return response({}, 404);
    if (url.endsWith("/git/commits/main"))
      return response({ tree: { sha: "base-tree" } });
    if (url.endsWith("/git/blobs")) return response({ sha: "blob" });
    if (url.endsWith("/git/trees")) {
      assert.equal(JSON.parse(String(opt?.body)).base_tree, "base-tree");
      return response({ sha: "new-tree" });
    }
    if (url.endsWith("/git/commits")) {
      assert.deepEqual(JSON.parse(String(opt?.body)).parents, ["main"]);
      return response({ sha: "new-commit" });
    }
    if (url.endsWith("/git/refs")) return response({});
    if (url.endsWith("/pulls")) {
      const body = JSON.parse(String(opt?.body));
      pr = { number: 1, head: { sha: "new-commit" }, body: body.body };
      return response(pr, 201);
    }
    throw new Error(url);
  };
  const github = new GitHub(config, transport),
    files = [
      { path: "content/memories/fixture.json", content: '{"id":"fixture"}' },
    ];
  assert.equal((await github.createChangeset("fixture", files)).number, 1);
  assert.equal((await github.createChangeset("fixture", files)).number, 1);
  assert.equal(calls.filter((c) => c.url.endsWith("/pulls")).length, 1);
  assert.equal(calls.filter((c) => c.url.endsWith("/git/trees")).length, 1);
  const token = JSON.parse(calls[0].opt.body);
  assert.deepEqual(token.repositories, ["website"]);
  assert.equal(token.permissions.contents, "write");
  assert.throws(() =>
    github.validateFiles([
      { path: ".github/workflows/exploit.yml", content: "x" },
    ]),
  );
  assert.throws(() =>
    github.validateFiles([
      {
        path: "content/memories/f.json",
        content: '{"email":"private@example.test"}',
      },
    ]),
  );
});
test("GitHub entity conflict blocks commit", async () => {
  const transport: Transport = async (url) =>
    url.endsWith("access_tokens")
      ? response({ token: "x", expires_at: "2099-01-01" })
      : url.includes("/pulls?")
        ? response([])
        : url.endsWith("/main")
          ? response({ object: { sha: "main" } })
          : url.includes("/git/commits/")
            ? response({ tree: { sha: "tree" } })
            : response({
                content: Buffer.from('{"title":"changed"}').toString("base64"),
              });
  await assert.rejects(
    new GitHub(config, transport).createChangeset("f", [
      { path: "content/memories/f.json", content: "{}", baseEntityHash: "old" },
    ]),
    /ENTITY_CONFLICT/,
  );
});
test("GitHub merged plus failed Pages deployment remains deploy_failed", async () => {
  const transport: Transport = async (url) => {
    if (url.endsWith("access_tokens"))
      return response({ token: "x", expires_at: "2099-01-01" });
    if (url.endsWith("/pulls/1"))
      return response({
        merged: true,
        merge_commit_sha: "merged",
        head: { sha: "head" },
        user: { id: 1 },
      });
    if (url.includes("check-runs"))
      return response({
        check_runs: [
          {
            name: "Validate website",
            head_sha: "head",
            status: "completed",
            conclusion: "success",
          },
        ],
      });
    if (url.includes("/status"))
      return url.includes("deployments/1")
        ? response([{ state: "failure" }])
        : response({ statuses: [] });
    if (url.includes("/deployments?"))
      return response([{ id: 1, sha: "merged" }]);
    throw new Error(url);
  };
  const state = await new GitHub(config, transport).status(1);
  assert.equal(state.state, "deploy_failed");
  assert.equal(state.deployedSha, null);
});
const account: Connector = {
  destination: "urn:li:organization:123",
  scopes: ["w_organization_social", "rw_organization_admin"],
  secret: { accessToken: "fake" },
  config: { apiVersion: "202606" },
  health: "connected",
};
test("LinkedIn checks organization then uses configured version, stores actual provider ID", async () => {
  const transport: Transport = async (url, opt) => {
    assert.equal(opt?.headers?.["LinkedIn-Version"], "202606");
    if (url.includes("organizationAcls"))
      return response({
        elements: [
          {
            organization: account.destination,
            role: "ADMINISTRATOR",
            state: "APPROVED",
          },
        ],
      });
    const body = JSON.parse(String(opt?.body));
    assert.equal(body.author, account.destination);
    return response({}, 201, { "x-restli-id": "urn:li:share:1" });
  };
  assert.equal(
    (await new LinkedIn(transport).publish(account, { text: "Approved" })).id,
    "urn:li:share:1",
  );
});
test("LinkedIn response timeout is ambiguous and missing scopes fail closed", async () => {
  const transport: Transport = async (url) =>
    url.includes("organizationAcls")
      ? response({
          elements: [
            {
              organization: account.destination,
              role: "ADMINISTRATOR",
              state: "APPROVED",
            },
          ],
        })
      : Promise.reject(new Error("lost response"));
  await assert.rejects(
    new LinkedIn(transport).publish(account, { text: "x" }),
    (e: any) => e.ambiguous === true,
  );
  await assert.rejects(
    new LinkedIn(transport).publish({ ...account, scopes: [] }, { text: "x" }),
    /CONNECTOR_NOT_READY/,
  );
});
test("YouTube resumable protocol starts private, resumes offset and persists ID", async () => {
  const youtubeAccount = {
    ...account,
    destination: "channel",
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  };
  let uploadStarted = false;
  const transport: Transport = async (url, opt) => {
    if (url.includes("/channels?"))
      return response({ items: [{ id: "channel" }] });
    if (opt?.method === "POST") {
      assert.equal(
        JSON.parse(String(opt.body)).status.privacyStatus,
        "private",
      );
      uploadStarted = true;
      return response({}, 200, {
        location: "https://www.googleapis.com/upload/session",
      });
    }
    if (opt?.headers?.["Content-Range"] === "bytes */4")
      return response({}, 308, { range: "bytes=0-1" });
    assert.equal(opt?.headers?.["Content-Range"], "bytes 2-3/4");
    return response({ id: "video" }, 200);
  };
  const youtube = new YouTube(transport);
  let state: import("../src/server/integrations/social").VideoState =
    await youtube.start(
      youtubeAccount,
      { title: "Video", description: "Approved", recordingConsent: true },
      { total: 4, mime: "video/mp4" },
    );
  assert.equal(uploadStarted, true);
  state = await youtube.resume(youtubeAccount, state);
  assert.equal(state.offset, 2);
  state = await youtube.chunk(youtubeAccount, state, Buffer.from("ab"));
  assert.equal(state.videoId, "video");
});
const source = {
  id: "fixture",
  company: "Fixture",
  adapter: "lever" as const,
  boardIdentifier: "fixture",
  enabled: true,
  reviewedAt: "2026-01-01T00:00:00Z",
  reviewReference: "review-1",
  permissionBasis: "Approved fixture",
  termsUrl: "https://example.test/terms",
  allowedHosts: ["api.lever.co"],
};
test("Lever partial pagination cannot establish source completeness", async () => {
  let calls = 0;
  const transport: Transport = async () => {
    if (calls++ === 0)
      return response(
        Array.from({ length: 100 }, (_, i) => ({
          id: String(i),
          text: "Platform Engineer",
          categories: { location: "Peru" },
          hostedUrl: `https://jobs.lever.co/fixture/${i}`,
        })),
      );
    throw new IntegrationError("TIMEOUT");
  };
  const result = await collectSource(source, transport);
  assert.equal(result.status, "incomplete");
  assert.equal(result.recordsFetched, 100);
  assert.equal(result.errorCode, "TIMEOUT");
});
test("unreviewed sources make no network request, HTML and malformed rows fail", async () => {
  let called = false;
  await collectSource({ ...source, enabled: false }, async () => {
    called = true;
    throw 0;
  });
  assert.equal(called, false);
  for (const result of [
    response("<html>", 200, { "content-type": "text/html" }),
    response([{ id: "1", text: "Job", hostedUrl: "http://127.0.0.1" }]),
  ])
    assert.equal(
      (await collectSource(source, async () => result)).status,
      "failed",
    );
});
test("job 72h freshness, exclusion, reopening and 30 percent anomaly gates", () => {
  const now = new Date("2026-01-05");
  const previous = Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    sourceId: "s",
    status: i === 0 ? "excluded" : i === 1 ? "closed" : "active",
    approved: true,
    eligibility: "peru",
    relevanceScore: 4,
    lastVerifiedAt: "2026-01-01T00:00:00Z",
  }));
  assert.equal(
    reconcileJobs(
      previous,
      { sourceId: "s", status: "failed", records: [] },
      now,
    ).jobs[3].status,
    "stale",
  );
  const records = previous.map((j) => ({
    ...j,
    lastVerifiedAt: now.toISOString(),
  }));
  const result = reconcileJobs(
    previous,
    { sourceId: "s", status: "complete", records },
    now,
  );
  assert.equal(result.jobs[0].status, "excluded");
  assert.equal(result.jobs[1].status, "needs-review");
  assert.equal(
    reconcileJobs(
      previous,
      { sourceId: "s", status: "complete", records: records.slice(0, 4) },
      now,
    ).status,
    "quarantined",
  );
});
test("YouTube revoked token and processing failure do not claim public completion", async () => {
  const a = {
    ...account,
    destination: "channel",
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  };
  const bad = new YouTube(async () => response({}, 401));
  await assert.rejects(bad.identity(a), /NEEDS_RECONNECTION/);
  const processing = new YouTube(async () =>
    response({
      items: [
        {
          id: "v",
          snippet: { channelId: "channel" },
          processingDetails: { processingStatus: "failed" },
          status: { privacyStatus: "private" },
        },
      ],
    }),
  );
  assert.equal((await processing.read(a, "v")).state, "failed");
  await assert.rejects(
    processing.visibility(a, "v", "public"),
    /VISIBILITY_SCOPE_REQUIRED/,
  );
});
test("Greenhouse duplicates use source identity; record cap marks incomplete", async () => {
  const sourceGH = {
    ...source,
    adapter: "greenhouse" as const,
    allowedHosts: ["boards-api.greenhouse.io"],
  };
  const raw = {
    id: 1,
    title: "Platform Engineer",
    location: { name: "Peru" },
    absolute_url: "https://boards.greenhouse.io/f/1",
  };
  const result = await collectSource(sourceGH, async () =>
    response({ jobs: [raw, raw] }),
  );
  assert.equal(result.records.length, 1);
  assert.equal(result.status, "complete");
  const capped = await collectSource(
    { ...sourceGH, requestLimit: 1 },
    async () => response({ jobs: [raw, { ...raw, id: 2 }] }),
  );
  assert.equal(capped.status, "incomplete");
  assert.equal(capped.errorCode, "LIMIT");
});
test("GitHub latest failed rerun invalidates an older success for same check name", async () => {
  const github = new GitHub(config);
  github.request = async (_method, path) =>
    path.includes("/pulls/")
      ? { head: { sha: "head" }, merged: false, state: "open" }
      : path.includes("check-runs")
        ? {
            check_runs: [
              {
                id: 1,
                name: "Validate website",
                head_sha: "head",
                status: "completed",
                conclusion: "success",
              },
              {
                id: 2,
                name: "Validate website",
                head_sha: "head",
                status: "completed",
                conclusion: "failure",
              },
            ],
          }
        : { statuses: [] };
  assert.equal((await github.status(1)).checksPassed, false);
});
test("GitHub merge fails closed without enforced protection", async () => {
  const github = new GitHub(config);
  github.status = async () => ({
    headSha: "head",
    checksPassed: true,
    checkResults: { "Validate website": true },
    pr: { head: { sha: "head" } },
  });
  github.request = async () => ({
    required_status_checks: { contexts: ["Validate website"] },
    enforce_admins: { enabled: false },
  });
  await assert.rejects(github.merge(1, "head"), /PROTECTION_REQUIRED/);
});
test("GitHub revert creates a reviewed deletion for an unchanged added file", async () => {
  const github = new GitHub(config);
  github.request = async (_method, path) =>
    path.endsWith("/main")
      ? { object: { sha: "current" } }
      : path.endsWith("/pulls/1")
        ? { merged: true, merge_commit_sha: "merged", base: { sha: "before" } }
        : path.endsWith("/files?per_page=100")
          ? [{ filename: "content/memories/new.json", status: "added" }]
          : { sha: "same-content" };
  github.createChangeset = async (_id, files) => files;
  const files = await github.revert("revert", 1, "current");
  assert.equal(files[0].content, null);
});
test("private S3 multipart descriptor exposes a short-lived signature, no AWS secret", async () => {
  const { S3Multipart } =
    await import("../src/server/integrations/s3-multipart");
  const backend = new S3Multipart("fixture-bucket", "us-east-1");
  backend.client.config.credentials = async () => ({
    accessKeyId: "FIXTURE_ACCESS",
    secretAccessKey: "fixture-secret-never-in-url",
    sessionToken: "fixture-session",
  });
  const url = new URL(
    await backend.signPart("community/videos/id", "upload+id", 2),
  );
  assert.equal(url.protocol, "https:");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
  assert.equal(url.searchParams.get("partNumber"), "2");
  assert.equal(url.searchParams.get("uploadId"), "upload+id");
  assert.equal(url.searchParams.get("X-Amz-Signature")?.length, 64);
  assert.equal(url.href.includes("fixture-secret-never-in-url"), false);
});
