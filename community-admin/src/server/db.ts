import pg, { type PoolClient } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
export const COMMUNITY_ID = "00000000-0000-4000-8000-000000000001";
export function createPool(
  connectionString: string,
  schema = "community_admin",
) {
  const url = new URL(connectionString);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("This local slice requires a loopback PostgreSQL host.");
  if (!/^[a-z][a-z0-9_]{0,60}$/.test(schema))
    throw new Error("Invalid database schema name");
  return new pg.Pool({
    connectionString,
    options: `-c search_path=${schema},public`,
    max: 8,
    connectionTimeoutMillis: 5000,
  });
}
export async function transaction<T>(
  pool: pg.Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export const requiredMigrationVersions = [1, 2, 3, 4, 7, 8, 9] as const;
export function hasRequiredMigrations(applied: number[]) {
  return requiredMigrationVersions.every((version) =>
    applied.includes(version),
  );
}
export async function hasDirectPublicationSchema(pool: pg.Pool) {
  try {
    await pool.query(
      "SELECT sequence,operation_id,attempt_id,repository,branch,subject,attempt,created_at,updated_at FROM website_publication_attempts LIMIT 0",
    );
    await pool.query(
      "SELECT publication_mode FROM editorial_proposals LIMIT 0",
    );
    await pool.query(
      "SELECT community_id,publication_id,blog_record_id,source_network,canonical_permalink_key,source_fields,confirmed_by,confirmed_at,publication_version,publication_revision_hash,method FROM social_blog_links LIMIT 0",
    );
    await pool.query(
      "SELECT community_id,request_key,actor_id,request_hash,response,created_at FROM social_blog_requests LIMIT 0",
    );
    const socialConstraints = await pool.query(
      "SELECT conname,contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN('social_blog_links'::regclass,'social_blog_requests'::regclass)",
    );
    for (const [name, kind, columns] of [
      ["social_blog_publication_once", "p", "(community_id, publication_id)"],
      ["social_blog_record_once", "u", "(community_id, blog_record_id)"],
      [
        "social_blog_source_once",
        "u",
        "(community_id, source_network, canonical_permalink_key)",
      ],
      ["social_blog_request_once", "p", "(community_id, request_key)"],
    ])
      if (
        !socialConstraints.rows.some(
          (row) =>
            row.conname === name &&
            row.contype === kind &&
            row.definition.includes(columns),
        )
      )
        return false;
    const lifecycle = await pool.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='drafts'::regclass AND conname='drafts_state_check'",
    );
    if (!lifecycle.rows[0]?.definition?.includes("'discarded'")) return false;
    return true;
  } catch (error: any) {
    if (["42P01", "42703"].includes(error.code)) return false;
    throw error;
  }
}
export async function migrate(pool: pg.Pool, schema = "community_admin") {
  if (!/^[a-z][a-z0-9_]{0,60}$/.test(schema))
    throw new Error("Invalid database schema name");
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(402315017)");
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const applied = new Set(
      (await client.query("SELECT version FROM schema_migrations")).rows.map(
        (r) => r.version,
      ),
    );
    const files = (await readdir(resolve("migrations")))
      .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
      .sort();
    for (const file of files) {
      const version = Number(file.slice(0, 3));
      if (!applied.has(version))
        await client.query(await readFile(resolve("migrations", file), "utf8"));
    }
  });
}
