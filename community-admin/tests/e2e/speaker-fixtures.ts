import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import manifest from "./fixtures/speaker-images.json";
/** Canonical public data and exact approved cached originals, never private DB snapshots. */
export async function speakerFixtures(repository: string, temporary: string) {
  const directory = resolve(repository, "../content/speakers"),
    rows: any[] = [];
  for (const file of (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const {
      id,
      schemaVersion: _schema,
      status: _status,
      updatedAt: _updated,
      ...payload
    } = JSON.parse(await readFile(join(directory, file), "utf8"));
    if (!id || file !== id + ".json")
      throw Error("E2E_SPEAKER_IDENTITY_INVALID");
    if (payload.photo?.startsWith("https://")) {
      const proof = manifest.images.find(
        (image) => image.id === id && image.url === payload.photo,
      );
      if (!proof || new URL(proof.url).hostname !== "img.evbuc.com")
        throw Error("E2E_SPEAKER_PHOTO_FIXTURE_STALE");
      const bytes = await readFile(
          resolve(repository, "tests/e2e/fixtures/speaker-images", proof.file),
        ),
        metadata = await sharp(bytes).metadata();
      if (
        createHash("sha256").update(bytes).digest("hex") !== proof.sha256 ||
        metadata.width !== proof.width ||
        metadata.height !== proof.height ||
        metadata.format !== "jpeg"
      )
        throw Error("E2E_SPEAKER_PHOTO_FIXTURE_CORRUPT");
    }
    rows.push({ id, type: "speakers", payload });
  }
  const path = join(temporary, "speaker-baseline.json");
  await mkdir(temporary, { recursive: true });
  await writeFile(path, JSON.stringify(rows, null, 2));
  return {
    baseline: path,
    images: resolve(repository, "tests/e2e/fixtures/speaker-images"),
    originalPhotoCount: manifest.images.length,
    canonicalSpeakerCount: rows.length,
  };
}
