import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  readdir,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import request from "supertest";
import sharp from "sharp";
import { createApp } from "../src/server/app";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import { resolveBrandWebsiteRoot } from "../src/server/brand-assets";
const schema = "test_brand_assets_" + randomUUID().replaceAll("-", ""),
  origin = "http://127.0.0.1:4887";
let root: string,
  pool: ReturnType<typeof createPool>,
  app: ReturnType<typeof createApp>,
  owner: any,
  coordinator: any;
const configured = process.env.WEBSITE_CHECKOUT;
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
before(async () => {
  root = await mkdtemp(join(tmpdir(), "brand-assets-"));
  await mkdir(join(root, "public/brand"), { recursive: true });
  await mkdir(join(root, "content/brands"), { recursive: true });
  await mkdir(join(root, "community-admin"));
  await writeFile(join(root, "astro.config.mjs"), "export default {};");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "platform-engineering-web" }),
  );
  await copyFile(
    resolve("../public/brand/official/mark.svg"),
    join(root, "public/brand/mark.svg"),
  );
  await copyFile(
    resolve("../public/brand/official/mark.png"),
    join(root, "public/brand/mark.png"),
  );
  await copyFile(
    resolve("../public/brand/applications/hoodie-shirt.webp"),
    join(root, "public/brand/application.webp"),
  );
  await writeFile(join(root, "public/brand/archive.zip"), "not an image");
  await writeFile(
    join(root, "outside.png"),
    await sharp({
      create: { width: 2, height: 2, channels: 4, background: "red" },
    })
      .png()
      .toBuffer(),
  );
  await symlink(
    join(root, "outside.png"),
    join(root, "public/brand/escape.png"),
  );
  await writeFile(
    join(root, "public/brand/fake.png"),
    "<html>app fallback</html>",
  );
  await writeFile(
    join(root, "public/brand/script.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
  );
  await writeFile(
    join(root, "public/brand/external.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://example.com/tracker.png" width="10" height="10"/></svg>',
  );
  process.env.WEBSITE_CHECKOUT = root;
  pool = createPool(process.env.DATABASE_URL!, schema);
  await migrate(pool, schema);
  app = createApp({
    pool,
    media: [],
    origin,
    fixtureAuthEnabled: true,
    environment: "test",
  });
  owner = request.agent(app);
  coordinator = request.agent(app);
  assert.equal(
    (
      await owner
        .post("/api/dev/login")
        .set("Origin", origin)
        .send({ persona: "owner" })
    ).status,
    200,
  );
  assert.equal(
    (
      await coordinator
        .post("/api/dev/login")
        .set("Origin", origin)
        .send({ persona: "coordinator" })
    ).status,
    200,
  );
});
after(async () => {
  if (pool) {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
  if (configured === undefined) delete process.env.WEBSITE_CHECKOUT;
  else process.env.WEBSITE_CHECKOUT = configured;
  if (root) await rm(root, { recursive: true, force: true });
});
async function record(
  previewPath: string,
  path = previewPath,
  community = COMMUNITY_ID,
  type = "brands",
) {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO records(id,community_id,type,scope,author_id,payload,state,revision_hash,updated_at) VALUES($1,$2,$3,'public',$4,$5,'draft','fixture',now())",
    [
      id,
      community,
      type,
      "10000000-0000-4000-8000-000000000004",
      { previewPath, path },
    ],
  );
  return id;
}
const preview = (agent: any, id: string) =>
  agent.get(`/api/brand-assets/${id}/preview`);
test("speaker previews retain original local identity and restrict external photos to approved host", async () => {
  await mkdir(join(root, "public/speakers"), { recursive: true });
  const bytes = await readFile(resolve("../public/speakers/grecia-vargas.jpg"));
  await writeFile(join(root, "public/speakers/grecia-vargas.jpg"), bytes);
  const id = await record("", "", COMMUNITY_ID, "speakers");
  const photo = async (value: string) =>
    pool.query("UPDATE records SET payload=$2 WHERE id=$1", [
      id,
      { photo: value },
    ]);
  await photo("speakers/grecia-vargas.jpg");
  assert.equal(
    (await request(app).get(`/api/speaker-assets/${id}/preview`)).status,
    401,
  );
  const result = await owner.get(`/api/speaker-assets/${id}/preview`);
  assert.equal(result.status, 200);
  assert.match(result.headers["content-type"], /image\/jpeg/);
  assert.equal(hash(result.body), hash(bytes));
  await photo(
    "https://img.evbuc.com/https%3A%2F%2Fexample.com%2Fportrait.jpg?w=400",
  );
  const external = await owner.get(`/api/speaker-assets/${id}/preview`);
  assert.equal(external.status, 302);
  assert.match(external.headers.location, /^https:\/\/img.evbuc.com\//);
  for (const value of [
    "../outside.png",
    "brand/mark.png",
    "https://evil.example/a.jpg",
    "https://img.evbuc.com.evil.example/a.jpg",
  ]) {
    await photo(value);
    assert.equal(
      (await owner.get(`/api/speaker-assets/${id}/preview`)).status,
      422,
      value,
    );
  }
  await photo("speakers/grecia-vargas.jpg");
  assert.equal(
    (await owner.get(`/api/speaker-assets/${id}/preview?path=brand/mark.png`))
      .status,
    400,
  );
});
test("actual approved website SVG, PNG and WebP preserve exact bytes with correct MIME", async () => {
  for (const [file, mime] of [
    ["mark.svg", "image/svg+xml"],
    ["mark.png", "image/png"],
    ["application.webp", "image/webp"],
  ]) {
    const id = await record("brand/" + file),
      r = await preview(owner, id)
        .buffer(true)
        .parse((res: any, cb: any) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.headers["content-type"].startsWith(mime));
    assert.equal(
      hash(r.body),
      hash(await readFile(join(root, "public/brand", file))),
    );
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.match(r.headers["content-security-policy"], /sandbox/);
  }
});
test("preview lookup is authenticated, capability-gated and record/community-bound", async () => {
  const own = await record("brand/mark.png"),
    foreign = await record("brand/mark.png", "brand/mark.png", randomUUID()),
    other = await record(
      "brand/mark.png",
      "brand/mark.png",
      COMMUNITY_ID,
      "people",
    );
  assert.equal((await preview(request(app), own)).status, 401);
  assert.equal((await preview(coordinator, own)).status, 403);
  for (const id of [foreign, other, randomUUID()])
    assert.equal((await preview(owner, id)).status, 404);
  assert.equal((await preview(owner, "not-a-uuid")).status, 400);
  assert.equal(
    (await owner.get(`/api/brand-assets/${own}/preview?path=brand/mark.svg`))
      .status,
    400,
  );
  assert.equal(
    (await owner.get(`/api/brand-assets/${own}/preview?path=brand%00mark.png`))
      .status,
    400,
  );
});
test("fallback uses a safe existing image, documents stay explicitly unsupported", async () => {
  for (const first of ["brand/missing.png", "brand/archive.zip", ""]) {
    const id = await record(first, "brand/mark.png");
    assert.equal((await preview(owner, id)).status, 200);
  }
  const id = await record("brand/archive.zip"),
    r = await preview(owner, id);
  assert.equal(r.status, 415);
  assert.equal(r.body.code, "BRAND_PREVIEW_UNSUPPORTED");
  assert.equal(
    (await preview(owner, await record("brand/missing.png"))).status,
    404,
  );
});
test("unsafe paths, symlink escape, HTML masquerading as PNG and active SVG fail closed", async () => {
  for (const path of [
    "../outside.png",
    "/etc/passwd",
    "https://example.com/x.png",
    "brand/mark.png?x=1",
    "brand/mark.png#x",
    "brand/%2e%2e/x.png",
    "brand/escape.png",
    "brand/fake.png",
    "brand/script.svg",
    "brand/external.svg",
  ]) {
    const r = await preview(owner, await record(path, "brand/mark.png"));
    assert.equal(r.status, 422, path + ":" + JSON.stringify(r.body));
  }
  for (const [name, svg] of Object.entries({
    event:
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)"/>',
    entity:
      '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&xxe;</svg>',
    foreign:
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>active</div></foreignObject></svg>',
    css: '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.com/x";</style></svg>',
  })) {
    await writeFile(join(root, `public/brand/${name}.svg`), svg);
    assert.equal(
      (await preview(owner, await record(`brand/${name}.svg`))).status,
      422,
      name,
    );
  }
});
test("bounded content rejects oversized files and MIME mismatches; non-image inventory remains explicit", async () => {
  await writeFile(
    join(root, "public/brand/oversized.svg"),
    Buffer.alloc(8 * 1024 * 1024 + 1, 32),
  );
  await copyFile(
    join(root, "public/brand/mark.png"),
    join(root, "public/brand/mismatch.webp"),
  );
  for (const name of ["oversized.svg", "mismatch.webp"])
    assert.equal(
      (await preview(owner, await record("brand/" + name))).status,
      422,
      name,
    );
  for (const name of ["README.md", "sources.json", ".DS_Store"]) {
    const r = await preview(owner, await record("brand/" + name));
    assert.equal(r.status, 415, name);
    assert.equal(r.body.code, "BRAND_PREVIEW_UNSUPPORTED");
  }
});
test("current repository brand inventory resolves through actual record payloads, not invented cover paths", async () => {
  const checkout = resolve("..");
  const previous = process.env.WEBSITE_CHECKOUT;
  process.env.WEBSITE_CHECKOUT = checkout;
  let images = 0,
    files = 0;
  try {
    for (const name of (await readdir(join(checkout, "content/brands"))).filter(
      (n) => n.endsWith(".json"),
    )) {
      const source = JSON.parse(
        await readFile(join(checkout, "content/brands", name), "utf8"),
      );
      const id = await record(source.previewPath ?? "", source.path ?? "");
      const expected = [source.previewPath, source.path].some(
        (p) =>
          typeof p === "string" &&
          /\.(svg|png|jpg|jpeg|webp|gif|avif)$/i.test(p),
      )
        ? 200
        : 415;
      const response = await preview(owner, id);
      assert.equal(
        response.status,
        expected,
        name + ":" + JSON.stringify(response.body),
      );
      if (expected === 200) {
        images++;
        assert.match(response.headers["content-type"], /^image\//);
      } else files++;
    }
    assert.ok(images > 20);
    assert.ok(files > 0);
  } finally {
    process.env.WEBSITE_CHECKOUT = previous;
  }
});
test("trusted root recognizes only explicit nested topology and never hides custom invalid configuration", async () => {
  const nested = join(root, "community-admin");
  assert.equal(
    await resolveBrandWebsiteRoot({ cwd: nested, configured: undefined }),
    await import("node:fs/promises").then((f) => f.realpath(root)),
  );
  assert.equal(
    await resolveBrandWebsiteRoot({
      cwd: nested,
      configured: "../platform-engineering-peru",
    }),
    await import("node:fs/promises").then((f) => f.realpath(root)),
  );
  await assert.rejects(() =>
    resolveBrandWebsiteRoot({
      cwd: nested,
      configured: "../invalid-custom-checkout",
    }),
  );
  await assert.rejects(() =>
    resolveBrandWebsiteRoot({ cwd: root, configured: undefined }),
  );
  const escaped = await mkdtemp(join(tmpdir(), "brand-topology-"));
  try {
    await symlink(nested, join(escaped, "community-admin"));
    await assert.rejects(() =>
      resolveBrandWebsiteRoot({
        cwd: join(escaped, "community-admin"),
        configured: undefined,
      }),
    );
  } finally {
    await rm(escaped, { recursive: true, force: true });
  }

  assert.equal(
    await resolveBrandWebsiteRoot({ cwd: nested, configured: root }),
    await import("node:fs/promises").then((f) => f.realpath(root)),
  );
});
