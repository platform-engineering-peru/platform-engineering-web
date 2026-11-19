import type { RequestHandler } from "express";
import type pg from "pg";
import { ApiError, getSession } from "../context";
/** GitHub mode must not leave a second writable or publishable SQL Events authority. */
export function legacyEventGuard(pool: pg.Pool): RequestHandler {
  return async (req, res, next) => {
    let normalized: string;
    try {
      normalized =
        decodeURIComponent(req.path)
          .toLowerCase()
          .replace(/\/+/g, "/")
          .replace(/\/+$/, "")
          .trim() || "/";
    } catch {
      throw new ApiError(400, "INVALID_PATH", "La ruta no es válida.");
    }
    const path = normalized,
      write = !["GET", "HEAD", "OPTIONS"].includes(req.method),
      community = getSession(res).communityId;
    const deny = () => {
      throw new ApiError(
        409,
        "EDITORIAL_GITHUB_AUTHORITY",
        "Eventos usa el contenido aprobado de GitHub. Usa el espacio editorial para actualizar, guardar borradores y proponer revisiones.",
      );
    };
    if (
      path === "/content/events" ||
      (path === "/records" &&
        typeof req.query.type === "string" &&
        req.query.type.toLowerCase() === "events")
    )
      deny();
    if (
      write &&
      ["/records", "/drafts"].includes(path) &&
      [req.body?.type, req.body?.entityType].some(
        (v) => typeof v === "string" && v.toLowerCase() === "events",
      )
    )
      deny();
    const record =
      /^\/(?:records|drafts|people|organizations|proposals|sessions|participations|followups|consents)\/([a-f0-9-]{36})(?:\/|$)/.exec(
        path,
      );
    if (record) {
      const row = (
        await pool.query(
          "SELECT type FROM records WHERE id=$1 AND community_id=$2",
          [record[1], community],
        )
      ).rows[0];
      if (row?.type === "events") deny();
    }
    if (write && path === "/import/site" && req.body?.dryRun !== true) deny();
    if (write && path === "/changesets" && Array.isArray(req.body?.recordIds)) {
      const ids = req.body.recordIds.filter(
        (id: unknown) =>
          typeof id === "string" &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
            id,
          ),
      );
      if (
        ids.length &&
        (
          await pool.query(
            "SELECT id FROM records WHERE id=ANY($1::uuid[]) AND community_id=$2 AND type='events' LIMIT 1",
            [ids, community],
          )
        ).rowCount
      )
        deny();
    }
    const changeset = /^\/changesets\/([a-f0-9-]{36})\//.exec(path);
    if (write && changeset) {
      const row = (
        await pool.query(
          "SELECT files FROM integration_changesets WHERE id=$1 AND community_id=$2",
          [changeset[1], community],
        )
      ).rows[0];
      if (
        row?.files?.some((f: any) =>
          String(f.path).startsWith("content/events/"),
        )
      )
        deny();
    }
    if (write && /^\/publications\/[^/]+\/recording-link$/.test(path)) deny();
    if (write && path === "/publications" && req.body?.payload?.eventId) deny();
    const publication = /^\/publications\/([a-f0-9-]{36})(?:\/|$)/.exec(path);
    if (write && publication) {
      const row = (
        await pool.query(
          "SELECT payload FROM integration_publications WHERE id=$1 AND community_id=$2",
          [publication[1], community],
        )
      ).rows[0];
      if (row?.payload?.eventId || req.body?.payload?.eventId) deny();
    }
    next();
  };
}
