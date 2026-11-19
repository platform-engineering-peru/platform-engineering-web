import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createPool, migrate } from "../src/server/db";
import { createApp } from "../src/server/app";
import { verifySeedMedia } from "../src/server/media";
test("real OAuth path uses state/PKCE and GitHub subject invitations; no fixture authority or provider token export", async () => {
  const schema = `test_oauth_${randomUUID().replaceAll("-", "")}`,
    pool = createPool(process.env.DATABASE_URL!, schema),
    origin = "http://127.0.0.1:4455";
  const keys = [
      "GITHUB_OAUTH_CLIENT_ID",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "GITHUB_OWNER_SUBJECT",
    ],
    prior = keys.map((k) => process.env[k]);
  Object.assign(process.env, {
    GITHUB_OAUTH_CLIENT_ID: "synthetic-client",
    GITHUB_OAUTH_CLIENT_SECRET: "SYNTHETIC_CLIENT_SECRET",
    GITHUB_OWNER_SUBJECT: "10001",
  });
  let subject = 10001;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://github.com/login/oauth/access_token") {
      const body = new URLSearchParams(String(init!.body));
      assert.ok(body.get("code_verifier")!.length >= 43);
      assert.equal(
        body.get("redirect_uri"),
        origin + "/api/auth/github/callback",
      );
      return new Response(
        JSON.stringify({ access_token: "SYNTHETIC_AUTH_TOKEN" }),
        { status: 200 },
      );
    }
    assert.equal(url, "https://api.github.com/user");
    assert.equal(
      (init!.headers as any).Authorization,
      "Bearer SYNTHETIC_AUTH_TOKEN",
    );
    return new Response(
      JSON.stringify({
        id: subject,
        login: "synthetic-user",
        name: subject === 30003 ? "Josua Castro" : "Synthetic OAuth account",
      }),
    );
  };
  try {
    await migrate(pool, schema);
    const app = createApp({
      pool,
      media: await verifySeedMedia(),
      origin,
      fixtureAuthEnabled: false,
      environment: "test",
      oauthFetch: fetcher,
    });
    const login = async (agent: any) => {
      const start = await agent.get("/api/auth/github/start");
      assert.equal(start.status, 302);
      const target = new URL(start.headers.location);
      assert.equal(target.origin, "https://github.com");
      assert.equal(target.searchParams.get("code_challenge_method"), "S256");
      assert.ok(target.searchParams.get("code_challenge"));
      return {
        state: target.searchParams.get("state"),
        finish: () =>
          agent.get("/api/auth/github/callback").query({
            code: "synthetic-code",
            state: target.searchParams.get("state"),
          }),
      };
    };
    const owner = request.agent(app),
      first = await login(owner);
    assert.equal((await first.finish()).status, 302);
    const me = await owner.get("/api/me");
    assert.equal(me.body.role, "owner");
    assert.equal(me.body.isFixture, false);
    assert.ok(!JSON.stringify(me.body).includes("SYNTHETIC_AUTH_TOKEN"));
    assert.equal((await first.finish()).status, 403);
    const invite = await owner
      .post("/api/invitations")
      .set("Origin", origin)
      .set("X-CSRF-Token", me.body.csrfToken)
      .send({ providerSubject: "20002", roles: ["editor"] });
    assert.equal(invite.status, 201, JSON.stringify(invite.body));
    subject = 20002;
    const editor = request.agent(app),
      flow = await login(editor);
    assert.equal((await flow.finish()).status, 302);
    const editorMe = await editor.get("/api/me");
    assert.equal(editorMe.body.role, "editor");
    assert.ok(editorMe.body.capabilities.includes("content:write"));
    assert.ok(!editorMe.body.capabilities.includes("members:manage"));
    subject = 30003;
    const denied = request.agent(app),
      uninvited = await login(denied);
    assert.equal((await uninvited.finish()).status, 403);
    const stateAgent = request.agent(app),
      tamper = await login(stateAgent);
    assert.equal(
      (
        await stateAgent
          .get("/api/auth/github/callback")
          .query({ code: "synthetic", state: "0".repeat(64) })
      ).status,
      403,
    );
    assert.equal(calls.filter((c) => c.includes("access_token")).length, 3);
    assert.equal(
      (
        await request(app)
          .post("/api/dev/login")
          .set("Origin", origin)
          .send({ persona: "owner" })
      ).status,
      404,
    );
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
    keys.forEach((k, i) => {
      if (prior[i] === undefined) delete process.env[k];
      else process.env[k] = prior[i];
    });
  }
});
