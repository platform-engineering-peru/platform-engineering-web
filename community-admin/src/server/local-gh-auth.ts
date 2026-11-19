import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { z } from "zod";
import { ApiError, auditEvent, getSession } from "./context";
import { COMMUNITY_ID, transaction } from "./db";
import { issueSession } from "./auth";
export type GhRunner = (
  file: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;
const run: GhRunner = promisify(execFile);
export const localGhCookie = "ca_local_gh";
export const readCookie = (req: Request, name: string) =>
  req.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(name + "="))
    ?.slice(name.length + 1) ?? "";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const profileSchema = z.object({
  id: z.number().int().positive().safe(),
  login: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/),
  name: z.string().max(200).nullable(),
  type: z.literal("User"),
  html_url: z.string().url(),
  avatar_url: z.string().url(),
});
export function createLocalGhAuth({
  pool,
  origin,
  requested = false,
  expectedSubject,
  environment,
  runner = run,
}: {
  pool: pg.Pool;
  origin: string;
  requested?: boolean;
  expectedSubject?: string;
  environment?: string;
  runner?: GhRunner;
}) {
  const url = new URL(origin),
    enabled =
      requested &&
      environment !== "production" &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.origin === origin &&
      /^[1-9][0-9]{0,19}$/.test(expectedSubject ?? "");
  const router = Router(),
    challenges = new Map<string, number>();
  let cached: { profile: any; at: number } | undefined,
    pending: Promise<any> | undefined;
  function guard(req: Request) {
    if (!enabled)
      throw new ApiError(
        404,
        "LOCAL_GH_DISABLED",
        "El acceso local con GitHub CLI está deshabilitado.",
      );
    if (
      (req.get("Host") !== url.host && req.get("Host") !== "localhost:" + url.port) ||
      !["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(
        req.socket.remoteAddress ?? "",
      )
    )
      throw new ApiError(
        403,
        "LOCAL_GH_ORIGIN",
        "Este acceso requiere la dirección local127.0.0.1 configurada.",
      );
  }
  async function profile(force = false) {
    if (!enabled)
      throw new ApiError(
        401,
        "LOCAL_GH_DISABLED",
        "El acceso local con GitHub CLI está deshabilitado.",
      );
    if (!force && cached && Date.now() - cached.at < 5000)
      return cached.profile;
    if (pending) return pending;
    pending = (async () => {
      let stdout: string;
      try {
        ({ stdout } = await runner(
          "gh",
          ["api", "--hostname", "github.com", "user"],
          { encoding: "utf8", timeout: 8000, maxBuffer: 65536 },
        ));
      } catch {
        cached = undefined;
        throw new ApiError(
          503,
          "GH_CLI_UNAVAILABLE",
          "No se pudo verificar GitHub CLI. Comprueba gh en este equipo y vuelve a verificar.",
        );
      }
      let p: z.infer<typeof profileSchema>;
      try {
        p = profileSchema.parse(JSON.parse(stdout));
        const avatar = new URL(p.avatar_url);
        if (
          p.html_url !== `https://github.com/${p.login}` ||
          avatar.protocol !== "https:" ||
          avatar.hostname !== "avatars.githubusercontent.com" ||
          avatar.username ||
          avatar.password ||
          avatar.port ||
          avatar.pathname !== `/u/${p.id}`
        )
          throw new Error("profile");
      } catch {
        cached = undefined;
        throw new ApiError(
          503,
          "GH_PROFILE_INVALID",
          "GitHub CLI no devolvió un perfil personal válido. Vuelve a verificar.",
        );
      }
      if (String(p.id) !== expectedSubject) {
        cached = undefined;
        throw new ApiError(
          403,
          "GH_IDENTITY_MISMATCH",
          "La cuenta activa de GitHub CLI no coincide con la cuenta autorizada para esta revisión local.",
        );
      }
      const result = {
        subject: String(p.id),
        login: p.login,
        name: p.name?.trim() || p.login,
        profileUrl: p.html_url,
        avatarUrl: p.avatar_url,
        source: "local-gh" as const,
        verifiedAt: new Date().toISOString(),
      };
      cached = { profile: result, at: Date.now() };
      return result;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  }
  async function member(p: any) {
    return transaction(pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "local-gh:" + expectedSubject,
      ]);
      const revoked = await db.query(
        "SELECT * FROM invitations WHERE provider_subject=$1 ORDER BY created_at DESC LIMIT 1",
        [expectedSubject],
      );
      if (revoked.rows[0]?.revoked_at)
        throw new ApiError(
          403,
          "USER_REVOKED",
          "El acceso de esta cuenta fue revocado.",
        );
      const existing = (
        await db.query(
          "SELECT * FROM users WHERE provider_subject=$1 FOR UPDATE",
          [expectedSubject],
        )
      ).rows[0];
      if (existing) {
        if (
          !existing.active ||
          existing.is_fixture ||
          existing.community_id !== COMMUNITY_ID
        )
          throw new ApiError(
            403,
            "USER_INACTIVE",
            "La membresía no está activa en esta comunidad.",
          );
        await db.query("UPDATE users SET display_name=$2 WHERE id=$1", [
          existing.id,
          p.name,
        ]);
        return { ...existing, display_name: p.name };
      }
      const invitation = revoked.rows[0];
      if (
        invitation &&
        (invitation.community_id !== COMMUNITY_ID ||
          invitation.accepted_at ||
          new Date(invitation.expires_at).getTime() <= Date.now())
      )
        throw new ApiError(
          403,
          "INVITATION_REQUIRED",
          "La invitación no está activa en esta comunidad.",
        );
      const roles: string[] = invitation ? invitation.roles : ["owner"];
      const id = randomUUID();
      const user = (
        await db.query(
          "INSERT INTO users(id,community_id,persona,display_name,role,roles,provider_subject,is_fixture) VALUES($1,$2,$3,$4,$5,$6,$7,false) RETURNING *",
          [
            id,
            COMMUNITY_ID,
            "github:" + p.subject,
            p.name,
            roles[0],
            roles,
            p.subject,
          ],
        )
      ).rows[0];
      if (invitation)
        await db.query("UPDATE invitations SET accepted_at=now() WHERE id=$1", [
          invitation.id,
        ]);
      await auditEvent(
        db,
        { id, communityId: COMMUNITY_ID },
        id,
        invitation
          ? "local_gh_invitation_accepted"
          : "local_gh_owner_bootstrapped",
        { subject: p.subject },
      );
      return user;
    });
  }
  async function signIn(req: Request, res: Response, reverify = false) {
    guard(req);
    z.object({}).strict().parse(req.body);
    const p = await profile(true),
      user = await member(p);
    if (reverify && getSession(res).id !== user.id)
      throw new ApiError(
        403,
        "GH_IDENTITY_MISMATCH",
        "La sesión ya no coincide con GitHub CLI.",
      );
    const old = readCookie(req, localGhCookie);
    if (/^[a-f0-9]{64}$/.test(old))
      await pool.query("DELETE FROM sessions WHERE token_hash=$1", [
        hash("local-gh:" + old),
      ]);
    const dto = await issueSession(pool, res, user, origin, localGhCookie);
    await transaction(pool, (db) =>
      auditEvent(
        db,
        { id: user.id, communityId: user.community_id },
        user.id,
        reverify ? "local_gh_reverified" : "local_gh_login",
        { subject: p.subject, login: p.login },
      ),
    );
    res.json({ ...dto, github: p, authMethod: "local-gh" });
  }
  router.get("/auth/local-gh/challenge", (req, res) => {
    guard(req);
    for (const [k, until] of challenges)
      if (until < Date.now()) challenges.delete(k);
    while (challenges.size >= 100)
      challenges.delete(challenges.keys().next().value!);
    const csrfToken = randomBytes(32).toString("hex");
    challenges.set(hash(csrfToken), Date.now() + 300000);
    res.cookie("ca_gh_init", csrfToken, {
      httpOnly: true,
      sameSite: "strict",
      path: "/api/auth/local-gh",
      maxAge: 300000,
    });
    res.json({ csrfToken });
  });
  router.post("/auth/local-gh", async (req, res) => {
    guard(req);
    const csrf = req.get("X-CSRF-Token") ?? "",
      cookie = readCookie(req, "ca_gh_init"),
      expires = challenges.get(hash(csrf));
    if (
      !/^[a-f0-9]{64}$/.test(csrf) ||
      cookie !== csrf ||
      !expires ||
      expires < Date.now()
    )
      throw new ApiError(
        403,
        "CSRF_DENIED",
        "Vuelve a iniciar la verificación local.",
      );
    challenges.delete(hash(csrf));
    res.clearCookie("ca_gh_init", { path: "/api/auth/local-gh" });
    await signIn(req, res);
  });
  return {
    router,
    enabled,
    requested,
    reverify: (req: Request, res: Response) => signIn(req, res, true),
    async verifySession(req: Request, user: any) {
      guard(req);
      if (
        user.is_fixture ||
        user.provider_subject !== expectedSubject ||
        user.community_id !== COMMUNITY_ID
      )
        throw new ApiError(
          401,
          "GH_SESSION_MISMATCH",
          "Vuelve a verificar la cuenta autorizada de GitHub CLI.",
        );
      const revoked = await pool.query(
        "SELECT revoked_at FROM invitations WHERE provider_subject=$1 ORDER BY created_at DESC LIMIT 1",
        [expectedSubject],
      );
      if (revoked.rows[0]?.revoked_at)
        throw new ApiError(403, "USER_REVOKED", "El acceso fue revocado.");
      return profile(
        req.path === "/me" || !["GET", "HEAD", "OPTIONS"].includes(req.method),
      );
    },
  };
}
