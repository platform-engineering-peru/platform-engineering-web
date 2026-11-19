import { createPool, migrate } from "../src/server/db";
if (!process.env.DATABASE_URL)
  throw new Error(
    "DATABASE_URL is required. See README for local PostgreSQL setup.",
  );
const pool = createPool(process.env.DATABASE_URL, process.env.DATABASE_SCHEMA);
try {
  await migrate(pool, process.env.DATABASE_SCHEMA);
  console.log("Local schema migrations applied or already current.");
} finally {
  await pool.end();
}
