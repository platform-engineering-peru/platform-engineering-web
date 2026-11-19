import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import inventory from "./media-inventory.json";
import type { VerifiedMedia } from "../shared/content";
/** Decode the complete image, not just headers; only these checked fixture bytes are accepted. */
export async function verifySeedMedia(
  readBytes: (path: string) => Promise<Buffer> = (path) =>
    readFile(resolve("public", path)),
): Promise<VerifiedMedia[]> {
  for (const asset of inventory) {
    if (!/^media\/[a-f0-9]{16}\/synthetic-[12]\.png$/.test(asset.path))
      throw new Error("Unsafe fixture media path");
    const bytes = await readBytes(asset.path);
    if (bytes.length > 20 * 1024 * 1024)
      throw new Error("Fixture media verification failed: oversized image");
    const metadata = await sharp(bytes, {
      limitInputPixels: 40_000_000,
    }).metadata();
    await sharp(bytes, { limitInputPixels: 40_000_000 }).raw().toBuffer();
    if (
      bytes.length > 20 * 1024 * 1024 ||
      metadata.format !== "png" ||
      metadata.width !== asset.width ||
      metadata.height !== asset.height ||
      Math.max(asset.width, asset.height) > 2560 ||
      createHash("sha256").update(bytes).digest("hex") !== asset.sha256 ||
      !asset.path.includes(asset.sha256.slice(0, 16))
    )
      throw new Error("Fixture media verification failed");
  }
  return inventory.map((asset) => ({ ...asset }));
}
