import { cp, mkdir, symlink, writeFile, stat, rm } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { Request, Response } from "express";
import type pg from "pg";
import { projectPublicRecord, publicMediaIds } from "./export";
import { websiteRoot } from "./import-site";
import { mediaBytes } from "./uploads";
import { verifySeedMedia } from "./media";
import { ApiError, type Session } from "./context";
const run = promisify(execFile);
const building = new Set<string>();
export function requirePreviewPermission(user: Session) {
  if (
    !user.capabilities.some((c) =>
      ["*", "content:write", "content:review"].includes(c),
    )
  )
    throw new ApiError(
      403,
      "PREVIEW_PERMISSION",
      "Solo editores y revisores pueden generar o abrir vistas previas privadas.",
    );
}
export async function createPreview(
  pool: pg.Pool,
  user: Session,
  row: any,
  origin: string,
) {
  requirePreviewPermission(user);
  if (building.has(user.communityId) || building.size >= 2)
    throw new ApiError(
      429,
      "PREVIEW_BUSY",
      "Hay una vista previa en construcción. Vuelve a intentar al terminar.",
    );

  const id = randomUUID(),
    root = websiteRoot(),
    base = resolve(".local/previews", id),
    site = resolve(base, "site"),
    relative = `.local/previews/${id}/site/dist`;
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  await pool.query(
    "INSERT INTO previews(id,community_id,record_id,revision_hash,state,path,source_commit) VALUES($1,$2,$3,$4,'building',$5,$6)",
    [id, user.communityId, row.id, row.revision_hash, relative, sourceCommit],
  );
  building.add(user.communityId);
  try {
    const record = await projectPublicRecord(pool, user.communityId, row);
    await mkdir(site, { recursive: true, mode: 0o700 });
    for (const name of [
      "src",
      "public",
      "content",
      "astro.config.mjs",
      "package.json",
      "tsconfig.json",
    ])
      await cp(resolve(root, name), resolve(site, name), { recursive: true });
    await symlink(
      resolve(root, "node_modules"),
      resolve(site, "node_modules"),
      "dir",
    );
    const target = resolve(site, "content", row.type, `${row.id}.json`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(record, null, 2) + "\n");
    const ids = await publicMediaIds(pool, user.communityId, row);
    for (const mediaId of ids) {
      const data = await mediaBytes(
        pool,
        user.communityId,
        mediaId,
        await verifySeedMedia(),
      );
      const path = resolve(site, "public", data.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data.bytes);
    }
    await run(
      process.execPath,
      [resolve(site, "node_modules/astro/bin/astro.mjs"), "build"],
      {
        cwd: site,
        timeout: 90000,
        maxBuffer: 1_000_000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          BASE_PATH: `/api/previews/${id}/`,
          SITE: origin,
          NODE_ENV: "production",
          ASTRO_TELEMETRY_DISABLED: "1",
        },
      },
    );
    await pool.query("UPDATE previews SET state='ready' WHERE id=$1", [id]);
    const path =
      row.type === "events"
        ? `es-pe/events/${record.slug}/`
        : row.type === "memories"
          ? "es-pe/memories/"
          : ["resources", "courses"].includes(row.type)
            ? "es-pe/resources/"
            : row.type === "organizers"
              ? "es-pe/community/"
              : row.type === "brands"
                ? "es-pe/branding/"
                : "es-pe/";
    return {
      previewId: id,
      url: `/api/previews/${id}/${path}`,
      state: "ready",
      sourceCommit,
      revisionHash: row.revision_hash,
      renderer: "Astro website build",
    };
  } catch (error) {
    await pool.query("UPDATE previews SET state='failed' WHERE id=$1", [id]);
    await rm(base, { recursive: true, force: true });
    throw new ApiError(
      422,
      "PREVIEW_FAILED",
      "El sitio rechazó esta revisión o el entorno de build no está disponible. Revisa referencias, slugs e imágenes; no se publicó nada.",
    );
  } finally {
    building.delete(user.communityId);
  }
}
export async function servePreview(
  pool: pg.Pool,
  user: Session,
  id: string,
  req: Request,
  res: Response,
) {
  requirePreviewPermission(user);
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new ApiError(404, "PREVIEW_NOT_FOUND", "Vista previa no encontrada.");
  const row = (
    await pool.query(
      "SELECT * FROM previews WHERE id=$1 AND community_id=$2 AND state='ready' AND created_at>now()-interval '48 hours'",
      [id, user.communityId],
    )
  ).rows[0];
  if (!row)
    throw new ApiError(
      404,
      "PREVIEW_NOT_FOUND",
      "La vista previa no existe o venció.",
    );
  const raw = req.params.path,
    part = Array.isArray(raw) ? raw.join("/") : String(raw ?? "");
  if (part.includes("..") || part.includes("\0"))
    throw new ApiError(404, "NOT_FOUND", "Ruta no encontrada.");
  const root = resolve(row.path),
    file = resolve(root, part || "index.html");
  if (!file.startsWith(root + "/"))
    throw new ApiError(404, "NOT_FOUND", "Ruta no encontrada.");
  let target = file;
  try {
    if ((await stat(target)).isDirectory())
      target = resolve(target, "index.html");
  } catch {
    throw new ApiError(404, "NOT_FOUND", "Archivo no encontrado.");
  }
  res.set("Cache-Control", "no-store");
  res.sendFile(target, { dotfiles: "allow" });
}
