import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/server/app";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import { verifySeedMedia } from "../src/server/media";
const origin = "http://127.0.0.1:4455",
  subject = "10099",
  schema = "test_localgh_" + randomUUID().replaceAll("-", "");
let pool: ReturnType<typeof createPool>,
  media: Awaited<ReturnType<typeof verifySeedMedia>>;
const profile = {
  id: Number(subject),
  login: "synthetic-reviewer",
  name: "Synthetic local reviewer",
  type: "User",
  html_url: "https://github.com/synthetic-reviewer",
  avatar_url: "https://avatars.githubusercontent.com/u/10099?v=4",
  email: "PRIVATE_EMAIL",
  token: "MUST_NOT_COPY",
};
before(async () => {
  pool = createPool(process.env.DATABASE_URL!, schema);
  await migrate(pool, schema);
  media = await verifySeedMedia();
});
after(async () => {
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
});
function setup(
  runner: any = async () => ({ stdout: JSON.stringify(profile) }),
  extra: any = {},
) {
  return createApp({
    pool,
    media,
    origin,
    environment: "development",
    fixtureAuthEnabled: true,
    localGhAuthEnabled: true,
    localGhExpectedSubject: subject,
    ghRunner: runner,
    ...extra,
  });
}
const host = new URL(origin).host;
async function login(app: any) {
  const agent = request.agent(app),
    challenge = await agent
      .get("/api/auth/local-gh/challenge")
      .set("Host", host);
  const result = await agent
    .post("/api/auth/local-gh")
    .set("Host", host)
    .set("Origin", origin)
    .set("X-CSRF-Token", challenge.body.csrfToken ?? "")
    .send({});
  return { agent, result };
}
test("explicit local CLI boot pins real subject, uses opaque cookie/CSRF, and exports only public identity", async () => {
  let calls = 0;
  const app = setup(async (file: any, args: any, options: any) => {
    calls++;
    assert.equal(file, "gh");
    assert.deepEqual(args, ["api", "--hostname", "github.com", "user"]);
    assert.ok(options.timeout <= 10000);
    assert.ok(options.maxBuffer <= 65536);
    return { stdout: JSON.stringify(profile) };
  });
  const config = (await request(app).get("/api/config")).body;
  assert.equal(config.localGhAuthEnabled, true);
  assert.equal(config.fixtureAuthEnabled, false);
  const { agent, result } = await login(app);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.role, "owner");
  assert.equal(result.body.github.login, profile.login);
  assert.equal(result.body.isFixture, false);
  assert.ok(
    (result.headers["set-cookie"] as unknown as string[]).some(
      (v: string) =>
        /^ca_local_gh=[a-f0-9]{64};/.test(v) &&
        v.includes("HttpOnly") &&
        v.includes("SameSite=Strict"),
    ),
  );
  assert.ok(!JSON.stringify(result.body).includes("PRIVATE_EMAIL"));
  assert.ok(!JSON.stringify(result.body).includes("MUST_NOT_COPY"));
  const me = await agent.get("/api/me").set("Host", host);
  assert.equal(me.status, 200);
  assert.equal(me.body.github.subject, subject);
  assert.ok(calls >= 2);
  const bad = await agent
    .post("/api/auth/local-gh/reverify")
    .set("Host", host)
    .set("Origin", origin)
    .send({});
  assert.equal(bad.status, 403);
  const refreshed = await agent
    .post("/api/auth/local-gh/reverify")
    .set("Host", host)
    .set("Origin", origin)
    .set("X-CSRF-Token", me.body.csrfToken)
    .send({});
  assert.equal(refreshed.status, 200);
  const logout = await agent
    .post("/api/logout")
    .set("Host", host)
    .set("Origin", origin)
    .set("X-CSRF-Token", refreshed.body.csrfToken)
    .send({});
  assert.equal(logout.status, 204);
  assert.equal((await agent.get("/api/me").set("Host", host)).status, 401);
  assert.equal(
    (
      await request(app)
        .post("/api/dev/login")
        .set("Origin", origin)
        .send({ persona: "owner" })
    ).status,
    404,
  );
});
test("anonymous enroll rejects missing/replayed CSRF and cross origin/Host", async () => {
  const app = setup(),
    agent = request.agent(app);
  assert.equal(
    (
      await agent
        .post("/api/auth/local-gh")
        .set("Host", host)
        .set("Origin", origin)
        .send({})
    ).status,
    403,
  );
  assert.equal(
    (
      await agent
        .post("/api/auth/local-gh")
        .set("Host", host)
        .set("Origin", "https://attacker.invalid")
        .send({})
    ).status,
    403,
  );
  assert.equal(
    (
      await agent
        .get("/api/auth/local-gh/challenge")
        .set("Host", "attacker.invalid")
    ).status,
    403,
  );
  const c = (await agent.get("/api/auth/local-gh/challenge").set("Host", host))
    .body.csrfToken;
  assert.equal(
    (
      await agent
        .post("/api/auth/local-gh")
        .set("Host", host)
        .set("Origin", origin)
        .set("X-CSRF-Token", c)
        .send({})
    ).status,
    200,
  );
  assert.equal(
    (
      await agent
        .post("/api/auth/local-gh")
        .set("Host", host)
        .set("Origin", origin)
        .set("X-CSRF-Token", c)
        .send({})
    ).status,
    403,
  );
});
test("CLI failure, timeout, invalid/no-auth profile and mismatch fail closed without leaking command output", async () => {
  for (const runner of [
    async () => {
      throw new Error("TOKEN_SECRET timeout");
    },
    async () => ({ stdout: "not json TOKEN_SECRET" }),
    async () => ({ stdout: JSON.stringify({ ...profile, id: 20000 }) }),
    async () => ({ stdout: JSON.stringify({ ...profile, type: "Bot" }) }),
    async () => ({ stdout: "{}" }),
  ]) {
    const { result } = await login(setup(runner));
    assert.ok(result.status >= 400);
    assert.ok(!result.text.includes("TOKEN_SECRET"));
    assert.ok(
      !(result.headers["set-cookie"] as unknown as string[] | undefined)?.some(
        (v: string) => v.startsWith("ca_local_gh="),
      ),
    );
  }
});
test("production, nonloopback and missing pin disable local CLI authentication", async () => {
  for (const extra of [
    { environment: "production" },
    { origin: "https://admin.example.org" },
    { localGhExpectedSubject: undefined },
    { localGhAuthEnabled: false },
  ]) {
    let called = false;
    const app = setup(async () => {
      called = true;
      return { stdout: JSON.stringify(profile) };
    }, extra);
    assert.equal(
      (await request(app).get("/api/config")).body.localGhAuthEnabled,
      false,
    );
    assert.equal(
      (await request(app).get("/api/auth/local-gh/challenge").set("Host", host))
        .status,
      404,
    );
    assert.equal(called, false);
  }
});
test("account switch fails on fresh verification, does not refresh recent auth, and local cookies cannot cross modes", async () => {
  let current = { ...profile };
  const app = setup(async () => ({ stdout: JSON.stringify(current) }));
  const { agent, result } = await login(app);
  assert.equal(result.status, 200);
  const cookie = (result.headers["set-cookie"] as unknown as string[])
    .find((v) => v.startsWith("ca_local_gh="))!
    .split(";")[0];
  const me = (await agent.get("/api/me").set("Host", host)).body;
  await pool.query(
    "UPDATE sessions SET created_at=now()-interval '16 minutes' WHERE user_id=$1",
    [me.id],
  );
  const old = (await agent.get("/api/me").set("Host", host)).body;
  assert.ok(Date.now() - Date.parse(old.authenticatedAt) > 15 * 60000);
  const standard = setup(undefined, {
    localGhAuthEnabled: false,
    fixtureAuthEnabled: false,
  });
  assert.equal(
    (await request(standard).get("/api/me").set("Cookie", cookie)).status,
    401,
  );
  assert.equal(
    (
      await request(standard)
        .get("/api/me")
        .set("Cookie", cookie.replace("ca_local_gh=", "ca_session="))
    ).status,
    401,
  );
  current = {
    ...profile,
    id: 20000,
    avatar_url: "https://avatars.githubusercontent.com/u/20000?v=4",
  };
  const changed = await agent.get("/api/me").set("Host", host);
  assert.equal(changed.status, 403);
  assert.equal(changed.body.code, "GH_IDENTITY_MISMATCH");
  const logout = await agent
    .post("/api/logout")
    .set("Host", host)
    .set("Origin", origin)
    .set("X-CSRF-Token", me.csrfToken)
    .send({});
  assert.equal(
    logout.status,
    204,
    "logout remains available after CLI account switch",
  );
  current = { ...profile };
  const fresh = await login(app);
  const csrf = fresh.result.body.csrfToken;
  const reverified = await fresh.agent
    .post("/api/auth/local-gh/reverify")
    .set("Host", host)
    .set("Origin", origin)
    .set("X-CSRF-Token", csrf)
    .send({});
  assert.equal(reverified.status, 200);
  const newMe = (await fresh.agent.get("/api/me").set("Host", host)).body;
  assert.ok(Date.now() - Date.parse(newMe.authenticatedAt) < 10000);
});
test("stable subject reuse preserves reduced roles and rejects inactive/foreign/revoked authority", async () => {
  await pool.query(
    "UPDATE users SET role='viewer',roles=ARRAY['viewer'] WHERE provider_subject=$1",
    [subject],
  );
  const app = setup(),
    { result } = await login(app);
  assert.equal(result.status, 200);
  assert.equal(result.body.role, "viewer");
  assert.ok(!result.body.capabilities.includes("*"));
  await pool.query("UPDATE users SET active=false WHERE provider_subject=$1", [
    subject,
  ]);
  assert.equal((await login(setup())).result.status, 403);
  await pool.query(
    "UPDATE users SET active=true,community_id=$2 WHERE provider_subject=$1",
    [subject, randomUUID()],
  );
  assert.equal((await login(setup())).result.status, 403);
  await pool.query(
    "UPDATE users SET community_id=$2 WHERE provider_subject=$1",
    [subject, COMMUNITY_ID],
  );
  const actor = (
    await pool.query("SELECT id FROM users WHERE provider_subject=$1", [
      subject,
    ])
  ).rows[0].id;
  await pool.query(
    "INSERT INTO invitations(id,community_id,provider_subject,roles,invited_by,expires_at,revoked_at) VALUES($1,$2,$3,ARRAY['viewer'],$4,now()+interval '1 day',now())",
    [randomUUID(), COMMUNITY_ID, subject, actor],
  );
  assert.equal((await login(setup())).result.status, 403);
});

test("a pinned new account honors prior invitation roles and foreign community restrictions", async () => {
  const actor = (await pool.query("SELECT id FROM users WHERE persona='owner'"))
    .rows[0].id;
  for (const foreign of [false, true]) {
    const id = foreign ? 30088 : 30077,
      sub = String(id),
      p = {
        ...profile,
        id,
        avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
      };
    await pool.query(
      "INSERT INTO invitations(id,community_id,provider_subject,roles,invited_by,expires_at) VALUES($1,$2,$3,ARRAY['viewer'],$4,now()+interval '1 day')",
      [randomUUID(), foreign ? randomUUID() : COMMUNITY_ID, sub, actor],
    );
    const { result } = await login(
      setup(async () => ({ stdout: JSON.stringify(p) }), {
        localGhExpectedSubject: sub,
      }),
    );
    assert.equal(result.status, foreign ? 403 : 200);
    if (!foreign) assert.equal(result.body.role, "viewer");
  }
});
