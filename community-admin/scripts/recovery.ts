import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createPool } from "../src/server/db";
import {
  backupSnapshot,
  restoreSnapshot,
  reapplyDeletionTombstones,
} from "../src/server/recovery";
const connection = process.env.DATABASE_URL;
if (!connection) throw new Error("DATABASE_URL required");
const key = process.env.BACKUP_ENCRYPTION_KEY
  ? Buffer.from(process.env.BACKUP_ENCRYPTION_KEY, "base64")
  : Buffer.alloc(0);
const mode = process.argv[2],
  schema = process.argv[4] ?? process.env.DATABASE_SCHEMA ?? "community_admin",
  pool = createPool(connection, schema);
try {
  if (mode === "backup") {
    const bytes = await backupSnapshot(pool, schema, key);
    await mkdir(".local/backups", { recursive: true, mode: 0o700 });
    const file = resolve(".local/backups", `backup-${Date.now()}.enc`);
    await writeFile(file, bytes, { mode: 0o600 });
    console.log(
      JSON.stringify({
        file: ".local/backups/" + file.split("/").pop(),
        encrypted: true,
        bytes: bytes.length,
      }),
    );
  } else if (mode === "restore") {
    if (!process.argv[3] || !process.argv[4])
      throw new Error("Usage: recovery restore <encrypted-file> <new-schema>");
    console.log(
      JSON.stringify(
        await restoreSnapshot(
          pool,
          schema,
          await readFile(process.argv[3]),
          key,
        ),
      ),
    );
  } else if (mode === "reapply-tombstones") {
    console.log(
      JSON.stringify({
        tombstonesReapplied: await reapplyDeletionTombstones(pool),
      }),
    );
  } else throw new Error("Use backup, restore, or reapply-tombstones");
} finally {
  await pool.end();
}
