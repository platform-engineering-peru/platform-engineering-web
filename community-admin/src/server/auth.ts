import { Router, type Request, type Response } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { transaction, COMMUNITY_ID } from "./db";
import {
  ApiError,
  capabilitiesFor,
  getSession,
  requireCapability,
  auditEvent,
  requireRecentAuthentication,
} from "./context";
import { roleCapabilities } from "../shared/product-contract";
export const oauthConfigured = () =>
  Boolean(
    process.env.GITHUB_OAUTH_CLIENT_ID &&
    process.env.GITHUB_OAUTH_CLIENT_SECRET &&
    process.env.GITHUB_OWNER_SUBJECT,
  );
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export async function issueSession(
  pool: pg.Pool,
  res: Response,
  user: any,
  origin: string,
  cookieName = "ca_session",
) {
  const raw = randomBytes(32).toString("hex"),
    csrfToken = randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",
    [
      sha((cookieName === "ca_local_gh" ? "local-gh:" : "") + raw),
      user.id,
      csrfToken,
    ],
  );
  res.cookie(cookieName, raw, {
    httpOnly: true,
    sameSite: "strict",
    secure: origin.startsWith("https:"),
    path: "/api",
    maxAge: 8 * 3600000,
  });
  return {
    id: user.id,
    communityId: user.community_id,
    name: user.display_name,
    role: user.role,
    roles: [...new Set([user.role, ...(user.roles ?? [])])],
    capabilities: capabilitiesFor([user.role, ...(user.roles ?? [])]),
    csrfToken,
    isFixture: user.is_fixture,
  };
}
export function createAuthRouter({
  pool,
  origin,
  fetcher = fetch,
}: {
  pool: pg.Pool;
  origin: string;
  fetcher?: typeof fetch;
}) {
  const router = Router();
  router.get("/auth/github/start", async (_req, res) => {
    if (!oauthConfigured())
      throw new ApiError(
        503,
        "OAUTH_UNCONFIGURED",
        "Configura la aplicación OAuth y el subject del owner antes de iniciar sesión.",
      );
    const state = randomBytes(32).toString("hex"),
      verifier = randomBytes(48).toString("base64url");
    await pool.query(
      "INSERT INTO oauth_states(state_hash,verifier,expires_at) VALUES($1,$2,now()+interval '10 minutes')",
      [sha(state), verifier],
    );
    res.cookie("ca_oauth", state, {
      httpOnly: true,
      sameSite: "lax",
      secure: origin.startsWith("https:"),
      path: "/api/auth",
      maxAge: 600000,
    });
    const url = new URL("https://github.com/login/oauth/authorize");
    for (const [k, v] of Object.entries({
      client_id: process.env.GITHUB_OAUTH_CLIENT_ID!,
      redirect_uri: origin + "/api/auth/github/callback",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope: "read:user",
    }))
      url.searchParams.set(k, v);
    res.redirect(url.href);
  });
  router.get("/auth/github/callback", async (req, res) => {
    if (!oauthConfigured())
      throw new ApiError(
        503,
        "OAUTH_UNCONFIGURED",
        "OAuth no está configurado.",
      );
    const { code, state } = z
      .object({
        code: z.string().min(1).max(500),
        state: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(req.query);
    const cookie = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("ca_oauth="))
      ?.slice(9);
    if (cookie !== state)
      throw new ApiError(403, "OAUTH_STATE", "La sesión OAuth no coincide.");
    const consumed = await pool.query(
      "DELETE FROM oauth_states WHERE state_hash=$1 AND expires_at>now() RETURNING verifier",
      [sha(state)],
    );
    if (!consumed.rows[0])
      throw new ApiError(
        403,
        "OAUTH_STATE",
        "El intento OAuth venció o ya fue usado.",
      );
    res.clearCookie("ca_oauth", { path: "/api/auth" });
    const tokenResponse = await fetcher(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: process.env.GITHUB_OAUTH_CLIENT_ID!,
          client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET!,
          code,
          redirect_uri: origin + "/api/auth/github/callback",
          code_verifier: consumed.rows[0].verifier,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const token = (await tokenResponse.json()) as any;
    if (!tokenResponse.ok || typeof token.access_token !== "string")
      throw new ApiError(403, "OAUTH_FAILED", "GitHub no autorizó el acceso.");
    const response = await fetcher("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(15000),
    });
    const profile = (await response.json()) as any;
    if (!response.ok || !Number.isSafeInteger(profile.id))
      throw new ApiError(
        403,
        "OAUTH_FAILED",
        "No se pudo verificar la identidad de GitHub.",
      );
    const user = await transaction(pool, async (db) => {
      const subject = String(profile.id),
        existing = await db.query(
          "SELECT * FROM users WHERE provider_subject=$1 FOR UPDATE",
          [subject],
        );
      if (existing.rows[0]) {
        if (!existing.rows[0].active)
          throw new ApiError(
            403,
            "USER_INACTIVE",
            "La membresía está revocada.",
          );
        return existing.rows[0];
      }
      const invitation = await db.query(
        "SELECT * FROM invitations WHERE provider_subject=$1 AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>now() FOR UPDATE",
        [subject],
      );
      const owner = subject === process.env.GITHUB_OWNER_SUBJECT;
      if (!owner && !invitation.rows[0])
        throw new ApiError(
          403,
          "INVITATION_REQUIRED",
          "Esta cuenta de GitHub no tiene una invitación activa.",
        );
      const roles = owner ? ["owner"] : invitation.rows[0].roles;
      const id = randomUUID();
      const r = await db.query(
        "INSERT INTO users(id,community_id,persona,display_name,role,roles,provider_subject,is_fixture) VALUES($1,$2,$3,$4,$5,$6,$7,false) RETURNING *",
        [
          id,
          invitation.rows[0]?.community_id ?? COMMUNITY_ID,
          `github:${subject}`,
          String(profile.name ?? profile.login).slice(0, 200),
          roles[0],
          roles,
          subject,
        ],
      );
      if (invitation.rows[0])
        await db.query("UPDATE invitations SET accepted_at=now() WHERE id=$1", [
          invitation.rows[0].id,
        ]);
      await auditEvent(
        db,
        { id, communityId: r.rows[0].community_id },
        id,
        "github_login_accepted",
        { subject },
      );
      return r.rows[0];
    });
    await issueSession(pool, res, user, origin);
    res.redirect("/");
  });
  return router;
}
const roleList = z
  .array(z.enum(Object.keys(roleCapabilities) as [string, ...string[]]))
  .min(1)
  .max(7);
export function createMembersRouter({ pool }: { pool: pg.Pool }) {
  const router = Router();
  router.get("/members", async (_req, res) => {
    requireCapability(res, "members:manage");
    const r = await pool.query(
      'SELECT id,display_name AS name,role,roles,active,version,provider_subject AS "providerSubject",is_fixture AS "isFixture" FROM users WHERE community_id=$1 ORDER BY display_name LIMIT 100',
      [getSession(res).communityId],
    );
    res.json({ items: r.rows, nextCursor: null });
  });
  router.patch("/members/:id", async (req, res) => {
    const user = requireCapability(res, "members:manage");
    requireRecentAuthentication(res);
    const body = z
      .object({ roles: roleList, active: z.boolean() })
      .strict()
      .parse(req.body);
    const revision = req.get("If-Match");
    if (!revision)
      throw new ApiError(
        428,
        "PRECONDITION_REQUIRED",
        "Indica la versión de la membresía.",
      );
    const id = z.string().uuid().parse(req.params.id);
    await transaction(pool, async (db) => {
      const current = (
        await db.query(
          "SELECT * FROM users WHERE id=$1 AND community_id=$2 FOR UPDATE",
          [id, user.communityId],
        )
      ).rows[0];
      if (!current)
        throw new ApiError(404, "NOT_FOUND", "Membresía no encontrada.");
      if (`"${current.version}"` !== revision)
        throw new ApiError(409, "REVISION_CONFLICT", "La membresía cambió.");
      if (id === user.id && (!body.active || !body.roles.includes("owner")))
        throw new ApiError(
          409,
          "OWNER_REQUIRED",
          "No puedes quitar tu propia autoridad de owner.",
        );
      await db.query(
        "UPDATE users SET roles=$1,role=$2,active=$3,version=version+1 WHERE id=$4",
        [body.roles, body.roles[0], body.active, id],
      );
      await db.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      await auditEvent(db, user, id, "membership_changed", {
        roles: body.roles,
        active: body.active,
      });
    });
    res.json({ id, roles: body.roles, active: body.active });
  });
  router.get("/invitations", async (_req, res) => {
    const u = requireCapability(res, "members:manage");
    requireRecentAuthentication(res);
    const r = await pool.query(
      'SELECT id,provider_subject AS "providerSubject",roles,expires_at,accepted_at,revoked_at FROM invitations WHERE community_id=$1 ORDER BY created_at DESC LIMIT 100',
      [u.communityId],
    );
    res.json({ items: r.rows, nextCursor: null });
  });
  router.post("/invitations", async (req, res) => {
    const u = requireCapability(res, "members:manage");
    requireRecentAuthentication(res);
    const body = z
      .object({
        providerSubject: z.string().regex(/^[1-9][0-9]{0,19}$/),
        roles: roleList,
      })
      .strict()
      .parse(req.body);
    const id = randomUUID();
    await transaction(pool, async (db) => {
      await db.query(
        "INSERT INTO invitations(id,community_id,provider_subject,roles,invited_by,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '7 days')",
        [id, u.communityId, body.providerSubject, body.roles, u.id],
      );
      await auditEvent(db, u, id, "invitation_created", {
        providerSubject: body.providerSubject,
        roles: body.roles,
      });
    });
    res.status(201).json({ id, ...body });
  });
  router.post("/invitations/:id/revoke", async (req, res) => {
    const u = requireCapability(res, "members:manage");
    requireRecentAuthentication(res);
    const id = z.string().uuid().parse(req.params.id);
    await transaction(pool, async (db) => {
      const result = await db.query(
        "UPDATE invitations SET revoked_at=now() WHERE id=$1 AND community_id=$2 RETURNING id",
        [id, u.communityId],
      );
      if (!result.rowCount)
        throw new ApiError(404, "NOT_FOUND", "Invitación no encontrada.");
      await auditEvent(db, u, id, "invitation_revoked");
    });
    res.json({ id, state: "revoked" });
  });
  return router;
}
