import { Router } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  getSession,
  requireCapability,
  requireRecentAuthentication,
  auditEvent,
  ApiError,
} from "../context";
import { transaction } from "../db";
import { IntegrationService, type IntegrationOptions } from "./service";
import { secureRequest, apiRequest, jsonBody, type Transport } from "./http";
import { LinkedIn, YouTube, type Connector } from "./social";
import {
  IntegrationError,
  integrationMessage,
  publicIntegrationError,
} from "./security";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  apiVersion?: string;
}
export function socialOAuthConfig(
  provider: "linkedin" | "youtube",
): OAuthConfig | undefined {
  const prefix = provider === "linkedin" ? "LINKEDIN" : "YOUTUBE",
    clientId = process.env[`${prefix}_CLIENT_ID`],
    clientSecret = process.env[`${prefix}_CLIENT_SECRET`],
    redirectUri = process.env[`${prefix}_REDIRECT_URI`];
  if (!clientId || !clientSecret || !redirectUri) return;
  const callback = new URL(redirectUri);
  if (
    callback.protocol !== "https:" &&
    !(
      provider === "youtube" &&
      callback.protocol === "http:" &&
      callback.hostname === "127.0.0.1"
    )
  )
    throw new IntegrationError("OAUTH_CALLBACK_INVALID");
  return {
    clientId,
    clientSecret,
    redirectUri,
    apiVersion: process.env.LINKEDIN_API_VERSION,
    scopes: (
      process.env[`${prefix}_SCOPES`] ??
      (provider === "linkedin"
        ? "w_organization_social r_organization_social rw_organization_admin"
        : "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl")
    )
      .split(" ")
      .filter(Boolean),
  };
}
export class SocialOAuth {
  constructor(
    private service: IntegrationService,
    private transport: Transport = secureRequest,
    private configFor = socialOAuthConfig,
  ) {}
  async begin(
    provider: "linkedin" | "youtube",
    communityId: string,
    actorId: string,
    destination: string,
  ) {
    if (!this.service.options.liveEnabled)
      throw new IntegrationError("INTEGRATION_DISABLED", 503);
    const config = this.configFor(provider);
    if (!config) throw new IntegrationError("OAUTH_NOT_CONFIGURED", 503);
    await this.service.actor(actorId, communityId, "members:manage");
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url");
    await this.service.pool.query(
      "INSERT INTO integration_oauth_states(state_hash,community_id,actor_id,provider,destination,verifier,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')",
      [hash(state), communityId, actorId, provider, destination, verifier],
    );
    const url = new URL(
      provider === "linkedin"
        ? "https://www.linkedin.com/oauth/v2/authorization"
        : "https://accounts.google.com/o/oauth2/v2/auth",
    );
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(" "),
      state,
      ...(provider === "youtube"
        ? {
            access_type: "offline",
            prompt: "consent",
            code_challenge: createHash("sha256")
              .update(verifier)
              .digest("base64url"),
            code_challenge_method: "S256",
          }
        : {}),
    }).toString();
    return { url: url.href };
  }
  async callback(
    provider: "linkedin" | "youtube",
    state: string,
    code: string,
  ) {
    if (!this.service.options.liveEnabled)
      throw new IntegrationError("INTEGRATION_DISABLED", 503);
    const row = (
      await this.service.pool.query(
        "DELETE FROM integration_oauth_states WHERE state_hash=$1 AND provider=$2 AND expires_at>now() RETURNING *",
        [hash(state), provider],
      )
    ).rows[0];
    if (!row) throw new IntegrationError("OAUTH_STATE_INVALID", 403);
    await this.service.actor(row.actor_id, row.community_id, "members:manage");
    const config = this.configFor(provider);
    if (!config) throw new IntegrationError("OAUTH_NOT_CONFIGURED", 503);
    const url =
      provider === "linkedin"
        ? "https://www.linkedin.com/oauth/v2/accessToken"
        : "https://oauth2.googleapis.com/token";
    const data = jsonBody(
      await apiRequest(this.transport, url, {
        hosts: [new URL(url).hostname],
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          ...(provider === "youtube" ? { code_verifier: row.verifier } : {}),
        }).toString(),
      }),
    );
    if (!data.access_token) throw new IntegrationError("OAUTH_TOKEN_INVALID");
    const scopes =
      typeof data.scope === "string"
        ? data.scope.split(/[ ,]+/)
        : config.scopes;
    const secret = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(
        Date.now() + Number(data.expires_in) * 1000,
      ).toISOString(),
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    };
    const connector: Connector = {
      destination: row.destination,
      scopes,
      secret,
      config: { apiVersion: config.apiVersion },
      health: "connected",
    };
    if (provider === "linkedin")
      await new LinkedIn(this.transport).authority(connector);
    else await new YouTube(this.transport).identity(connector);
    const connected = await this.service.connect(
      row.community_id,
      provider,
      row.destination,
      scopes,
      secret,
      { apiVersion: config.apiVersion },
    );
    await transaction(this.service.pool, (db) =>
      auditEvent(
        db,
        { id: row.actor_id, communityId: row.community_id },
        connected.id,
        "integration_connected",
        {
          provider,
          outcome: "success",
          via: "oauth",
          version: connected.version,
        },
      ),
    );
    return connected;
  }
}
export function createSocialOAuthStartRouter(options: IntegrationOptions) {
  const router = Router(),
    oauth = new SocialOAuth(new IntegrationService(options));
  router.post("/integrations/:provider/oauth/start", async (req, res, next) => {
    try {
      requireCapability(res, "members:manage");
      requireRecentAuthentication(res);
      const provider = z
          .enum(["linkedin", "youtube"])
          .parse(req.params.provider),
        destination = z.string().min(1).max(200).parse(req.body.destination),
        u = getSession(res);
      const result = await oauth.begin(
        provider,
        u.communityId,
        u.id,
        destination,
      );
      await transaction(options.pool, (db) =>
        auditEvent(db, u, randomUUID(), "oauth_connection_started", {
          provider,
          outcome: "success",
        }),
      );
      res.json(result);
    } catch (e) {
      const u = getSession(res);
      if (u)
        await transaction(options.pool, (db) =>
          auditEvent(db, u, randomUUID(), "oauth_connection_denied", {
            code:
              e instanceof ApiError || e instanceof IntegrationError
                ? e.code
                : "VALIDATION",
          }),
        );
      next(e);
    }
  });
  return router;
}
// Callback state stores actor/community; it does not depend on a cross-site session cookie.
export function createSocialOAuthCallbackRouter(options: IntegrationOptions) {
  const router = Router(),
    oauth = new SocialOAuth(new IntegrationService(options));
  router.get(
    "/integrations/:provider/oauth/callback",
    async (req, res, next) => {
      try {
        const provider = z
          .enum(["linkedin", "youtube"])
          .parse(req.params.provider);
        if (req.query.error) throw new IntegrationError("OAUTH_DENIED", 403);
        const state = z.string().min(32).max(200).parse(req.query.state),
          code = z.string().min(1).max(3000).parse(req.query.code);
        await oauth.callback(provider, state, code);
        res.set("Cache-Control", "no-store");
        res
          .type("text/plain")
          .send(
            "Connection verified. Return to the administration application.",
          );
      } catch (e) {
        if (e instanceof IntegrationError)
          return res.status(e.status).json(publicIntegrationError(e));
        next(e);
      }
    },
  );
  return router;
}
