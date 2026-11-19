import type pg from "pg";
import { readFile } from "node:fs/promises";
import { exportApprovedRecords } from "./export";
import { integrationEnvironment } from "./integrations/runtime";
import { S3Multipart } from "./integrations/s3-multipart";
import { VideoAssets } from "./integrations/video";
import type { ExportFile } from "./integrations/github";
export function fullIntegrationOptions(pool: pg.Pool) {
  return {
    ...integrationEnvironment(pool),
    exportRecords: async (
      db: pg.PoolClient,
      communityId: string,
      ids: string[],
    ) => {
      const result = await exportApprovedRecords(db, communityId, ids);
      const files: ExportFile[] = [];
      for (const file of result.files) {
        const id = file.path.split("/").pop()!.replace(".json", "");
        const source = (
          await db.query(
            "SELECT source_hash FROM records WHERE id=$1 AND community_id=$2",
            [id, communityId],
          )
        ).rows[0];
        files.push({
          ...file,
          encoding: "utf-8",
          baseEntityHash: source?.source_hash ?? null,
        });
      }
      for (const asset of result.assets) {
        if (!asset.path.startsWith("public/media/")) continue;
        files.push({
          path: asset.path,
          content: (await readFile(asset.sourcePath)).toString("base64"),
          encoding: "base64",
        });
      }
      return { files, revisionHashes: result.revisionHashes };
    },
    readAsset: async (
      id: string,
      offset: number,
      length: number,
      communityId?: string,
    ) => {
      if (!communityId) throw new Error("VIDEO_COMMUNITY_REQUIRED");
      const row = (
        await pool.query(
          "SELECT community_id FROM integration_video_assets WHERE id=$1 AND community_id=$2",
          [id, communityId],
        )
      ).rows[0];
      if (!row) throw new Error("VIDEO_NOT_FOUND");
      const backend =
        process.env.STORAGE_BACKEND === "s3"
          ? new S3Multipart(
              process.env.S3_BUCKET ?? "",
              process.env.S3_REGION ?? "",
              process.env.S3_ENDPOINT,
            )
          : undefined;
      return new VideoAssets(pool, backend).read(
        communityId,
        id,
        offset,
        length,
      );
    },
  };
}
