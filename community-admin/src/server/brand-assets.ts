import { Router } from "express";
import { open, readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type pg from "pg";
import { ApiError, requireCapability } from "./context";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const formats: Record<string, { mime: string; format: string }> = {
  ".svg": { mime: "image/svg+xml", format: "svg" },
  ".png": { mime: "image/png", format: "png" },
  ".jpg": { mime: "image/jpeg", format: "jpeg" },
  ".jpeg": { mime: "image/jpeg", format: "jpeg" },
  ".webp": { mime: "image/webp", format: "webp" },
  ".gif": { mime: "image/gif", format: "gif" },
  ".avif": { mime: "image/avif", format: "heif" },
};
const unsafe = () =>
  new ApiError(
    422,
    "BRAND_PREVIEW_UNSAFE",
    "La vista previa no es una imagen pública segura.",
  );
const unavailable = () =>
  new ApiError(
    503,
    "BRAND_ASSET_ROOT_UNAVAILABLE",
    "No se pudo verificar el repositorio del sitio. Revisa su ubicación local.",
  );
function contained(root: string, file: string) {
  const path = relative(root, file);
  return (
    path !== "" &&
    !isAbsolute(path) &&
    path !== ".." &&
    !path.startsWith(".." + sep)
  );
}
async function verifiedCheckout(candidate: string) {
  try {
    const root = await realpath(candidate);
    if (!(await stat(resolve(root, "astro.config.mjs"))).isFile())
      throw unavailable();
    const pkg = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    );
    if (pkg.name !== "platform-engineering-web") throw unavailable();
    for (const path of ["public", "content/brands"]) {
      const target = await realpath(resolve(root, path));
      if (!contained(root, target) || !(await stat(target)).isDirectory())
        throw unavailable();
    }
    return root;
  } catch {
    throw unavailable();
  }
}
/** Explicit checkout settings are authoritative; no filesystem search is performed. */
export async function resolveBrandWebsiteRoot(
  options: { cwd?: string; configured?: string } = {},
) {
  const cwd = options.cwd ?? process.cwd();
  const configured = Object.hasOwn(options, "configured")
    ? options.configured
    : process.env.WEBSITE_CHECKOUT;
  if (configured && configured !== "../platform-engineering-peru")
    return verifiedCheckout(resolve(cwd, configured));
  // Only the known nested deployment replaces the historical sibling default.
  // An explicit custom checkout never falls back to another filesystem location.
  if (basename(cwd) === "community-admin") {
    try {
      const parent = await realpath(resolve(cwd, ".."));
      const actualCwd = await realpath(cwd);
      if (actualCwd === resolve(parent, "community-admin"))
        return await verifiedCheckout(parent);
    } catch {
      /* A standalone deployment may still use the valid sibling checkout. */
    }
  }
  return verifiedCheckout(
    resolve(cwd, configured ?? "../platform-engineering-peru"),
  );
}
function safeAssetPath(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    isAbsolute(value) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9/_ .-]*$/.test(value) ||
    value
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          (p.startsWith(".") && p !== ".DS_Store"),
      )
  )
    throw unsafe();
  return value;
}
function validateSvg(bytes: Buffer) {
  const svg = bytes.toString("utf8");
  // Reject active XML/CSS features before the image decoder sees the document.
  if (
    !/^\s*(?:<\?xml\s[^?]*\?>\s*)?<svg\b/i.test(svg) ||
    /<!DOCTYPE|<!ENTITY|<\?(?!xml\s)|<!\[CDATA\[|\son[a-z]+\s*=|@import|javascript\s*:|\\/i.test(
      svg,
    )
  )
    throw unsafe();
  const tags = new Set([
    "svg",
    "title",
    "desc",
    "defs",
    "g",
    "image",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "linearGradient",
    "radialGradient",
    "stop",
    "text",
    "tspan",
    "clipPath",
    "mask",
    "pattern",
    "use",
  ]);
  for (const m of svg.matchAll(/<\/?([\w:.-]+)/g))
    if (!tags.has(m[1])) throw unsafe();
  for (const m of svg.matchAll(/(?:\b|:)(?:href|src)\s*=\s*(["'])(.*?)\1/gis)) {
    if (
      !/^#[A-Za-z_][\w.-]*$/.test(m[2]) &&
      !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(m[2])
    )
      throw unsafe();
  }
  for (const m of svg.matchAll(/url\s*\((.*?)\)/gis))
    if (!/^\s*["']?#[A-Za-z_][\w.-]*["']?\s*$/.test(m[1])) throw unsafe();
}
async function image(root: string, path: string) {
  const expected = formats[extname(path).toLowerCase()];
  if (!expected) return null;
  const publicRoot = await realpath(resolve(root, "public"));
  let target: string;
  try {
    target = await realpath(resolve(publicRoot, path));
  } catch (error: any) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw unsafe();
  }
  if (!contained(publicRoot, target)) throw unsafe();
  const file = await open(target, "r");
  let bytes: Buffer;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES)
      throw unsafe();
    bytes = await file.readFile();
    if (bytes.length > MAX_BYTES) throw unsafe();
  } finally {
    await file.close();
  }
  try {
    if (expected.format === "svg") validateSvg(bytes);
    const decoder = sharp(bytes, {
      limitInputPixels: MAX_PIXELS,
      failOn: "warning",
    });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== expected.format ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > MAX_PIXELS ||
      (metadata.pages ?? 1) > 1
    )
      throw unsafe();
    // Full decode rejects truncated/corrupt content without altering approved source bytes.
    await decoder.raw().toBuffer();
  } catch {
    throw unsafe();
  }
  return { bytes, mime: expected.mime };
}
export function createBrandAssetsRouter({ pool }: { pool: pg.Pool }) {
  const router = Router();
  router.get("/speaker-assets/:recordId/preview", async (req, res) => {
    const user = requireCapability(res, "content:read"),
      id = String(req.params.recordId);
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        id,
      ) ||
      Object.keys(req.query).length
    )
      throw new ApiError(
        400,
        "INVALID_SPEAKER_PREVIEW_REQUEST",
        "Selecciona un ponente del inventario.",
      );
    const row = (
      await pool.query(
        "SELECT payload FROM records WHERE id=$1 AND community_id=$2 AND type='speakers' AND scope='public' AND state<>'deleted'",
        [id, user.communityId],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND", "Ponente no encontrado.");
    const photo = row.payload.photo;
    res.set({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    if (typeof photo === "string" && photo.startsWith("https://")) {
      const url = new URL(photo);
      if (
        url.hostname !== "img.evbuc.com" ||
        url.username ||
        url.password ||
        url.port ||
        url.hash ||
        photo.length > 2000
      )
        throw unsafe();
      // Existing record-bound original CDN URL only; never a generic remote-image proxy.
      res.redirect(302, url.href);
      return;
    }
    const path = safeAssetPath(photo);
    if (!path?.startsWith("speakers/")) throw unsafe();
    const result = await image(await resolveBrandWebsiteRoot(), path);
    if (!result)
      throw new ApiError(
        404,
        "SPEAKER_PREVIEW_UNAVAILABLE",
        "La foto original no está disponible en el sitio.",
      );
    res.set({
      "Content-Security-Policy":
        "sandbox; default-src 'none'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      ETag: '"' + createHash("sha256").update(result.bytes).digest("hex") + '"',
    });
    res.type(result.mime).send(result.bytes);
  });
  router.get("/brand-assets/:recordId/preview", async (req, res) => {
    const user = requireCapability(res, "content:read"),
      id = String(req.params.recordId);
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        id,
      ) ||
      Object.keys(req.query).length
    )
      throw new ApiError(
        400,
        "INVALID_BRAND_PREVIEW_REQUEST",
        "Selecciona un archivo del inventario de marca.",
      );
    const record = (
      await pool.query(
        "SELECT payload FROM records WHERE id=$1 AND community_id=$2 AND type='brands' AND scope='public' AND state<>'deleted'",
        [id, user.communityId],
      )
    ).rows[0];
    if (!record)
      throw new ApiError(404, "NOT_FOUND", "Archivo de marca no encontrado.");
    const candidates = [
      ...new Set(
        [
          safeAssetPath(record.payload.previewPath),
          safeAssetPath(record.payload.path),
        ].filter((p): p is string => Boolean(p)),
      ),
    ];
    if (!candidates.some((p) => formats[extname(p).toLowerCase()]))
      throw new ApiError(
        415,
        "BRAND_PREVIEW_UNSUPPORTED",
        "Este archivo no tiene vista previa de imagen. Conserva el archivo original.",
      );
    const root = await resolveBrandWebsiteRoot();
    for (const path of candidates) {
      const result = await image(root, path);
      if (!result) continue;
      res.set({
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "Cache-Control": "private, no-store",
        "Cross-Origin-Resource-Policy": "same-origin",
        ETag:
          '"' + createHash("sha256").update(result.bytes).digest("hex") + '"',
      });
      res.type(result.mime).send(result.bytes);
      return;
    }
    throw new ApiError(
      404,
      "BRAND_PREVIEW_UNAVAILABLE",
      "No se encontró una imagen de vista previa en el repositorio del sitio.",
    );
  });
  return router;
}
