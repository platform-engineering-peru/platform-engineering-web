import type pg from "pg";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { transaction, migrate } from "./db";
import {
  erasePrivateKey,
  exportPrivateKey,
  restorePrivateKey,
} from "./private-data";
interface TableBackup {
  name: string;
  jsonColumns: string[];
  dependencies: string[];
  rows: Record<string, any>[];
}
const safe = (s: string) => {
  if (!/^[a-z][a-z0-9_]{0,60}$/.test(s))
    throw new Error("Unsafe schema/table identifier");
  return '"' + s + '"';
};
export async function backupSnapshot(
  pool: pg.Pool,
  schema: string,
  key: Buffer,
) {
  if (key.length !== 32) throw new Error("BACKUP_KEY_REQUIRED");
  const snapshot = await transaction(pool, async (db) => {
    await db.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    const tables = (
      await db.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' AND table_name NOT IN('sessions','oauth_states','integration_oauth_states','schema_migrations') ORDER BY table_name",
        [schema],
      )
    ).rows.map((r) => r.table_name);
    const result: TableBackup[] = [];
    for (const name of tables) {
      const columns = await db.query(
        "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
        [schema, name],
      );
      const deps = (
        await db.query(
          "SELECT DISTINCT ccu.table_name FROM information_schema.table_constraints tc JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name=ccu.constraint_name AND tc.constraint_schema=ccu.constraint_schema WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema=$1 AND tc.table_name=$2 AND ccu.table_schema=$1",
          [schema, name],
        )
      ).rows
        .map((r) => r.table_name)
        .filter((n) => n !== name);
      result.push({
        name,
        jsonColumns: columns.rows
          .filter((r) => ["json", "jsonb"].includes(r.data_type))
          .map((r) => r.column_name),
        dependencies: deps,
        rows: (await db.query(`SELECT * FROM ${safe(schema)}.${safe(name)}`))
          .rows,
      });
    }
    const records = result.find((t) => t.name === "records")?.rows ?? [];
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      tables: result,
      keys: Object.fromEntries(
        records
          .filter((r) => r.scope === "private" && r.state !== "deleted")
          .map((r) => [r.id, exportPrivateKey(r.id)])
          .filter(([, k]) => k),
      ),
    };
  });
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(snapshot)),
    cipher.final(),
  ]);
  return Buffer.from(
    JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    }),
  );
}
export async function reapplyDeletionTombstones(pool: pg.Pool) {
  let files: string[] = [];
  try {
    files = await readdir(resolve(".local/deletion-ledger"));
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  let count = 0;
  for (const file of files.filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))) {
    const entry = JSON.parse(
      await readFile(resolve(".local/deletion-ledger", file), "utf8"),
    );
    const result = await pool.query(
      "UPDATE records SET state='deleted',payload='{}',approved_hash=NULL WHERE id=$1 AND community_id=$2",
      [entry.recordId, entry.communityId],
    );
    if (result.rowCount) {
      erasePrivateKey(entry.recordId);
      count++;
    }
  }
  return count;
}
export async function restoreSnapshot(
  pool: pg.Pool,
  targetSchema: string,
  bytes: Buffer,
  key: Buffer,
) {
  if (key.length !== 32) throw new Error("BACKUP_KEY_REQUIRED");
  safe(targetSchema);
  const occupied = (
    await pool.query(
      "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=$1) AS present",
      [targetSchema],
    )
  ).rows[0].present;
  if (occupied) throw new Error("RESTORE_TARGET_MUST_BE_NEW_SCHEMA");
  const envelope = JSON.parse(bytes.toString()),
    decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64"),
    );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const snapshot = JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString(),
  );
  if (snapshot.version !== 1 || !Array.isArray(snapshot.tables))
    throw new Error("BACKUP_VERSION_UNSUPPORTED");
  await migrate(pool, targetSchema);
  await transaction(pool, async (db) => {
    const remaining: TableBackup[] = [...snapshot.tables],
      restored = new Set<string>();
    while (remaining.length) {
      const index = remaining.findIndex((t) =>
        t.dependencies.every(
          (d) =>
            restored.has(d) ||
            !snapshot.tables.some((t: TableBackup) => t.name === d),
        ),
      );
      if (index < 0) throw new Error("BACKUP_DEPENDENCY_CYCLE");
      const table = remaining.splice(index, 1)[0];
      const permitted = (
        await db.query(
          "SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2 AND table_type='BASE TABLE'",
          [targetSchema, table.name],
        )
      ).rowCount;
      if (
        !permitted ||
        [
          "sessions",
          "oauth_states",
          "integration_oauth_states",
          "schema_migrations",
        ].includes(table.name)
      )
        throw new Error("BACKUP_TABLE_NOT_ALLOWED");
      for (const row of table.rows) {
        const columns = Object.keys(row),
          values = columns.map((c) =>
            table.jsonColumns.includes(c) ? JSON.stringify(row[c]) : row[c],
          );
        const conflict =
          table.name === "users"
            ? `ON CONFLICT(id) DO UPDATE SET ${columns
                .filter((c) => c !== "id")
                .map((c) => `${safe(c)}=EXCLUDED.${safe(c)}`)
                .join(",")}`
            : "ON CONFLICT DO NOTHING";
        await db.query(
          `INSERT INTO ${safe(targetSchema)}.${safe(table.name)}(${columns.map(safe).join(",")}) VALUES(${values.map((_, i) => "$" + (i + 1)).join(",")}) ${conflict}`,
          values,
        );
      }
      restored.add(table.name);
    }
    await db.query(
      "UPDATE editorial_proposals SET state='unknown',lease_until=NULL,error_code='RESTORED_RECONCILIATION_REQUIRED' WHERE state IN('preparing','sending','unknown','retryable','proposed')",
    );
    await db.query(
      "UPDATE worker_outbox SET state='review_required',lease_owner=NULL,lease_until=NULL WHERE state IN('queued','running')",
    );
    await db.query(
      "UPDATE integration_publications SET approved_hash=NULL,state='review' WHERE state IN('approved','scheduled','sending')",
    );
  });
  for (const [id, value] of Object.entries(snapshot.keys ?? {}))
    restorePrivateKey(id, String(value));
  const tombstonesReapplied = await reapplyDeletionTombstones(pool);
  return {
    schema: targetSchema,
    tables: snapshot.tables.length,
    records:
      snapshot.tables.find((t: TableBackup) => t.name === "records")?.rows
        .length ?? 0,
    tombstonesReapplied,
    restoredFrom: snapshot.createdAt,
    pendingOperations: "review_required",
    sessionsRestored: false,
  };
}
