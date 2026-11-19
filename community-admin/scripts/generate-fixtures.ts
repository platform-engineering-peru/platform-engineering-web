import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
const records = [];
for (const [index, width, height] of [
  [1, 800, 520],
  [2, 520, 760],
]) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#efedf9"/><rect x="${width * 0.12}" y="${height * 0.2}" width="${width * 0.76}" height="${height * 0.6}" rx="32" fill="#5B2EFF"/><circle cx="${width * 0.35}" cy="${height * 0.5}" r="${width * 0.12}" fill="#C4B5FD"/><circle cx="${width * 0.65}" cy="${height * 0.5}" r="${width * 0.12}" fill="#00D96E"/><path d="M ${width * 0.35} ${height * 0.5} L ${width * 0.65} ${height * 0.5}" stroke="white" stroke-width="8"/></svg>`;
  const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = `media/${sha256.slice(0, 16)}/synthetic-${index}.png`;
  await mkdir(`public/${path.slice(0, path.lastIndexOf("/"))}`, {
    recursive: true,
  });
  await writeFile(`public/${path}`, bytes);
  records.push({
    id: `20000000-0000-4000-8000-00000000000${index}`,
    path,
    sha256,
    width,
    height,
    label:
      index === 1
        ? "Encuentro sintético · horizontal"
        : "Encuentro sintético · vertical",
  });
}
await writeFile(
  "src/server/media-inventory.json",
  JSON.stringify(records, null, 2) + "\n",
);
