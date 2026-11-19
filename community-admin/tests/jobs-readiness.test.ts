import test from "node:test";
import assert from "node:assert/strict";
import { providerReadiness } from "../src/server/integrations/readiness";
test("provider readiness remains sanitized and truthful for absent and malformed configuration", () => {
  const r = providerReadiness({ liveEnabled: false }, {});
  assert.equal(r.linkedin.ready, false);
  assert.ok(r.youtube.reasons.includes("LIVE_DISABLED"));
  assert.ok(r.linkedin.reasons.includes("CONNECTOR_KEY_MISSING"));
  const env = {
    LINKEDIN_CLIENT_ID: "client-secret-value",
    LINKEDIN_CLIENT_SECRET: "not-for-response",
    LINKEDIN_REDIRECT_URI: "malformed",
    LINKEDIN_API_VERSION: "202699",
    CONNECTOR_ENCRYPTION_KEY: "broken",
  };
  const bad = providerReadiness({ liveEnabled: true }, env);
  assert.equal(bad.linkedin.ready, false);
  assert.ok(bad.linkedin.reasons.includes("REDIRECT_URI_INVALID"));
  assert.ok(bad.linkedin.reasons.includes("API_VERSION_INVALID"));
  assert.ok(!JSON.stringify(bad).includes("not-for-response"));
  const good = providerReadiness(
    { liveEnabled: true, secretKey: Buffer.alloc(32) },
    {
      ...env,
      LINKEDIN_REDIRECT_URI:
        "https://admin.example/api/integrations/linkedin/oauth/callback",
      LINKEDIN_API_VERSION: "202611",
      YOUTUBE_CLIENT_ID: "x",
      YOUTUBE_CLIENT_SECRET: "x",
      YOUTUBE_REDIRECT_URI:
        "http://127.0.0.1:4455/api/integrations/youtube/oauth/callback",
    },
  );
  assert.equal(good.linkedin.ready, true);
  assert.equal(good.youtube.ready, true);
  assert.equal(good.linkedin.destinationKind, "organization-urn");
});
test("malformed encryption configuration disables provider use without breaking status configuration", async () => {
  const { integrationEnvironment } =
    await import("../src/server/integrations/runtime");
  const old = {
    key: process.env.CONNECTOR_ENCRYPTION_KEY,
    mode: process.env.EDITORIAL_MODE,
    live: process.env.INTEGRATIONS_LIVE_ENABLED,
  };
  try {
    process.env.CONNECTOR_ENCRYPTION_KEY = "malformed-not-secret";
    process.env.EDITORIAL_MODE = "github";
    process.env.INTEGRATIONS_LIVE_ENABLED = "false";
    const options = integrationEnvironment({} as any);
    assert.equal(options.secretKey, undefined);
    assert.ok(
      providerReadiness(options).linkedin.reasons.includes(
        "CONNECTOR_KEY_INVALID",
      ),
    );
  } finally {
    for (const [key, value] of Object.entries({
      CONNECTOR_ENCRYPTION_KEY: old.key,
      EDITORIAL_MODE: old.mode,
      INTEGRATIONS_LIVE_ENABLED: old.live,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
