import test from "node:test";
import assert from "node:assert/strict";
import {
  validateDatabaseURL,
  disposableSchema,
  childEnvironment,
  cleanupAll,
  reportCoverage,
} from "./e2e/safety";

test("E2E database target is explicit, dedicated, loopback and has no schema/connection-option escape", () => {
  for (const url of [
    undefined,
    "postgresql://user@localhost/community_admin_local",
    "postgresql://user@remote.invalid/admin_e2e",
    "postgresql://user@127.0.0.1/admin_e2e?options=-csearch_path=community_admin",
    "postgresql://user@127.0.0.1/admin_e2e?host=remote.invalid",
    "https://127.0.0.1/admin_e2e",
  ])
    assert.throws(() => validateDatabaseURL(url));
  assert.equal(
    validateDatabaseURL("postgresql://e2e@127.0.0.1:55499/admin_e2e").database,
    "admin_e2e",
  );
  assert.throws(() => disposableSchema("community_admin"));
  assert.throws(() => disposableSchema("e2e_bad;DROP SCHEMA public"));
  assert.equal(
    disposableSchema("e2e_" + "a".repeat(32)),
    "e2e_" + "a".repeat(32),
  );
});
test("runner environment never inherits database, provider credentials, auth or loader configuration", () => {
  const env = childEnvironment({
    PATH: "/safe/bin",
    HOME: "/home/test",
    DATABASE_URL: "secret",
    PGOPTIONS: "-c search_path=community_admin",
    NODE_OPTIONS: "--import unsafe",
    GITHUB_TOKEN: "secret",
    DEV_FIXTURE_AUTH: "1",
    STORAGE_BACKEND: "s3",
    E2E_DATABASE_URL: "postgresql://e2e@127.0.0.1/admin_e2e",
  });
  for (const key of [
    "DATABASE_URL",
    "PGOPTIONS",
    "NODE_OPTIONS",
    "GITHUB_TOKEN",
    "DEV_FIXTURE_AUTH",
    "STORAGE_BACKEND",
  ])
    assert.equal(env[key], undefined);
  assert.equal(env.PATH, "/safe/bin");
  assert.equal(env.NODE_ENV, "test");
});
test("cleanup attempts all owned resources and surfaces every failure", async () => {
  const calls: string[] = [];
  await assert.rejects(
    cleanupAll([
      async () => {
        calls.push("first");
        throw Error("first failure");
      },
      async () => {
        calls.push("second");
        throw Error("second failure");
      },
      async () => {
        calls.push("last");
      },
    ]),
    (error: any) =>
      error instanceof AggregateError && error.errors.length === 2,
  );
  assert.deepEqual(calls, ["first", "second", "last"]);
});
test("coverage distinguishes executed real E2E, synthetic providers and missing requirements", () => {
  const report = reportCoverage(
    ["A", "B", "C"],
    [
      {
        id: "real",
        requirements: ["A"],
        status: "passed",
        providerMode: "none",
      },
      {
        id: "fixture",
        requirements: ["B"],
        status: "passed",
        providerMode: "synthetic",
      },
    ],
  );
  assert.equal(report.find((r) => r.id === "A")?.state, "real-e2e");
  assert.equal(report.find((r) => r.id === "B")?.state, "synthetic-provider");
  assert.equal(report.find((r) => r.id === "C")?.state, "not-verified");
  assert.throws(() =>
    reportCoverage(
      ["A"],
      [
        {
          id: "bad",
          requirements: ["Z"],
          status: "passed",
          providerMode: "none",
        },
      ],
    ),
  );
});

test("network fence permits only owned loopback sockets and rejects active admin ports and subprocesses", async () => {
  const net = await import("node:net"),
    child = await import("node:child_process"),
    { installNetworkFence } = await import("./e2e/network"),
    server = (await import("node:http")).createServer((_, res) =>
      res.end("synthetic"),
    );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const violations: string[] = [],
    restore = installNetworkFence(new Set([address.port]), violations);
  try {
    assert.equal(
      await (await fetch(`http://127.0.0.1:${address.port}`)).text(),
      "synthetic",
    );
    assert.throws(() => net.connect(4455, "127.0.0.1"), /E2E_NETWORK_BLOCKED/);
    assert.throws(() => net.connect(443, "example.org"), /E2E_NETWORK_BLOCKED/);
    assert.throws(
      () => child.spawn("gh", ["api", "user"]),
      /E2E_SUBPROCESS_BLOCKED/,
    );
    assert.deepEqual(violations, [
      "blocked-node-socket",
      "blocked-node-socket",
      "blocked-subprocess",
    ]);
  } finally {
    restore();
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
});

test("requirement proof needs every mapped scenario and never calls API rules browser E2E", async () => {
  const { evaluateMatrix } = await import("./e2e/safety"),
    matrix: any = {
      requirements: [
        { id: "A", disposition: "local-required", scenarioIds: ["one", "two"] },
      ],
      scenarios: ["one", "two"].map((id) => ({
        id,
        executionLayer: "api-rules-pg",
        providerMode: "none",
        requirementIds: ["A"],
      })),
    },
    one: any = {
      id: "one",
      status: "passed",
      requirements: ["A"],
      providerMode: "none",
      executionLayer: "api-rules-pg",
    };
  assert.equal(evaluateMatrix(matrix, [one])[0].state, "not-verified");
  const complete = evaluateMatrix(matrix, [one, { ...one, id: "two" }])[0];
  assert.equal(complete.state, "verified-local");
  assert.equal(complete.realE2E, false);
  assert.throws(() => evaluateMatrix(matrix, [one, one]), /DUPLICATE/);
  assert.throws(
    () =>
      evaluateMatrix(matrix, [
        { ...one, executionLayer: "built-client-built-api-pg" },
      ]),
    /METADATA_MISMATCH/,
  );
});
test("serial run lock rejects overlapping runs and requires ownership for release", async () => {
  const { acquireRunLock } = await import("./e2e/run-lock"),
    { mkdtemp, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path"),
    dir = await mkdtemp(join(tmpdir(), "e2e-lock-"));
  try {
    const release = await acquireRunLock(dir, "first");
    await assert.rejects(acquireRunLock(dir, "second"), /E2E_RUN_IN_PROGRESS/);
    await release();
    await (
      await acquireRunLock(dir, "second")
    )();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("subprocess deadlines and cancellation fail visibly and terminate the owned child group", async () => {
  const { command } = await import("./e2e/postgres"),
    before = performance.now();
  await assert.rejects(
    command(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      env: childEnvironment(process.env),
      timeout: 80,
    }),
    /E2E_COMMAND_FAILED:.*timeout/,
  );
  assert.ok(performance.now() - before < 7000);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    command("must-not-run", [], { signal: controller.signal }),
    /E2E_COMMAND_ABORTED/,
  );
});

test("unhandled asynchronous fixture failure triggers abort and emergency cleanup instead of exiting early", async () => {
  const { spawnSync } = await import("node:child_process"),
    moduleURL = new URL("./e2e/safety.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import {captureFatalErrors} from ${JSON.stringify(moduleURL)}; const abort=new AbortController(); const fatal=captureFatalErrors(abort); let cleanup=false; try { setTimeout(()=>{Promise.reject(Error("synthetic asynchronous failure"));},0); await new Promise(done=>abort.signal.addEventListener("abort",done,{once:true})); } finally { cleanup=true; console.log(JSON.stringify({aborted:abort.signal.aborted,errors:fatal.errors.length,cleanup})); fatal.remove(); process.exitCode=1; }`,
    ],
    { encoding: "utf8", env: childEnvironment(process.env), timeout: 10000 },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stdout.trim(), result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    aborted: true,
    errors: 1,
    cleanup: true,
  });
});

test("supplemental preload registers Supertest-owned ephemeral sockets before its first request", async () => {
  const { spawnSync } = await import("node:child_process"),
    preload = new URL("./e2e/preload.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      preload,
      "--input-type=module",
      "-e",
      'import express from "express"; import request from "supertest"; const app=express(); app.get("/",(_,res)=>res.json({synthetic:true})); const response=await request(app).get("/"); if(response.status!==200) throw Error("owned local request failed"); console.log(JSON.stringify(response.body));',
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...childEnvironment(process.env),
        DATABASE_URL: "postgresql://e2e@127.0.0.1:55499/admin_e2e",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { synthetic: true });
});

test("supplemental DNS pin may resolve a synthetic hostname only to its owned loopback socket", async () => {
  const { spawnSync } = await import("node:child_process"),
    preload = new URL("./e2e/preload.ts", import.meta.url).href;
  const code =
    'import net from "node:net"; const server=net.createServer(s=>s.end()); await new Promise(done=>server.listen(0,"127.0.0.1",done)); try { await new Promise((done,reject)=>{ const socket=net.connect({host:"pinned.example",port:server.address().port,autoSelectFamily:true,lookup:(_host,opts,cb)=>opts.all?cb(null,[{address:"127.0.0.1",family:4}]):cb(null,"127.0.0.1",4)}); socket.once("error",reject);socket.once("close",done); }); console.log("owned pin verified"); } finally { await new Promise(done=>server.close(done)); }';
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", preload, "--input-type=module", "-e", code],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...childEnvironment(process.env),
        DATABASE_URL: "postgresql://e2e@127.0.0.1:55499/admin_e2e",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /owned pin verified/);
});

test("isolated legacy fixture rewrites only top-level imports, retaining generated component-relative imports", async () => {
  const { rewriteLegacyEntry } = await import("./e2e/legacy-entry"),
    original =
      'import {x} from "../src/x";\nconst generated = `import {ProductPage} from "./product";`;\nconst origin="http://127.0.0.1:4468";',
    rewritten = rewriteLegacyEntry(
      original,
      new URL("file:///fixture/tests/editorial.ts"),
      55991,
    );
  assert.match(rewritten, /from "file:\/\/\/fixture\/src\/x"/);
  assert.ok(rewritten.includes('from "./product"'));
  assert.ok(rewritten.includes("127.0.0.1:55991"));
  assert.throws(() =>
    rewriteLegacyEntry(original, new URL("file:///fixture/test.ts"), 4455),
  );
});

test("source provenance includes the website files copied into supplemental sandboxes", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path"),
    { inputManifest, changedInputs } = await import("./e2e/provenance"),
    root = await mkdtemp(join(tmpdir(), "e2e-provenance-")),
    admin = join(root, "community-admin");
  try {
    for (const directory of [
      "src",
      "migrations",
      "contracts",
      "tests",
      "scripts",
    ])
      await mkdir(join(admin, directory), { recursive: true });
    for (const file of [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "vite.config.ts",
      "scripts/test-e2e.ts",
    ])
      await writeFile(join(admin, file), "synthetic");
    for (const directory of ["public", "content", "src", "scripts"])
      await mkdir(join(root, directory), { recursive: true });
    for (const file of [
      "package.json",
      "package-lock.json",
      "astro.config.mjs",
      "tsconfig.json",
      "content/fixture.json",
    ])
      await writeFile(join(root, file), "synthetic");
    const before = await inputManifest(admin);
    await writeFile(join(root, "content/fixture.json"), "changed");
    assert.deepEqual(changedInputs(before, await inputManifest(admin)), [
      "../content/fixture.json",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser temporaries stay short and private despite long inherited TMPDIR and are removed on success or failure", async () => {
  const { withBrowserTemporary } = await import("./e2e/browser-temporary");
  const { mkdtemp, mkdir, stat, access, writeFile, rm } =
    await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const inherited = process.env.TMPDIR;
  const root = await mkdtemp(join(tmpdir(), "browser-path-test-"));
  const long = join(root, "nested-workspace-".repeat(12));
  const paths: string[] = [];
  try {
    await mkdir(long, { recursive: true });
    process.env.TMPDIR = long;
    assert.ok(
      Buffer.byteLength(
        join(long, "org.chromium.Chromium.123456/SingletonSocket"),
      ) > 107,
    );
    for (const fails of [false, true]) {
      const run = withBrowserTemporary(async (directory: string) => {
        paths.push(directory);
        if (process.platform !== "win32") {
          assert.equal((await stat(directory)).mode & 0o777, 0o700);
          const profile = join(directory, "org.chromium.Chromium.123456");
          await mkdir(profile);
          const socket = join(profile, "SingletonSocket");
          assert.ok(Buffer.byteLength(socket) < 104, socket);
          const server = (await import("node:net")).createServer();
          await new Promise<void>((done, reject) => {
            server.once("error", reject);
            server.listen(socket, done);
          });
          await new Promise<void>((done, reject) =>
            server.close((error) => (error ? reject(error) : done())),
          );
        }
        await writeFile(
          join(directory, "private-browser-fixture"),
          "synthetic",
        );
        if (fails) throw Error("synthetic browser launch failure");
        return "passed";
      });
      if (fails) await assert.rejects(run, /synthetic browser launch failure/);
      else assert.equal(await run, "passed");
      await assert.rejects(access(paths.at(-1)!), { code: "ENOENT" });
    }
    assert.notEqual(paths[0], paths[1]);
  } finally {
    if (inherited === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = inherited;
    await rm(root, { recursive: true, force: true });
  }
});
