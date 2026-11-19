import type pg from "pg";
import { jobGeography } from "./geography";
/** Bounded evidence filtering keeps raw cursor offsets stable without dropping later qualified jobs. */
export async function geographicQueue(
  pool: pg.Pool,
  community: string,
  state: string,
  query: string,
  scope: "qualified" | "ineligible" | "all",
  limit: number,
  offset: number,
) {
  const items: any[] = [];
  let cursor = offset,
    scanned = 0;
  while (scanned < 1000) {
    const rows = (
      await pool.query(
        `SELECT * FROM job_records WHERE community_id=$1 AND ($2='' OR payload->>'status'=$2) AND ($3='' OR payload->>'title' ILIKE '%'||$3||'%' OR payload->>'company' ILIKE '%'||$3||'%') ORDER BY id LIMIT 100 OFFSET $4`,
        [community, state, query, cursor],
      )
    ).rows;
    for (const row of rows) {
      const geography = jobGeography(row.payload);
      const matches =
        scope === "all" ||
        (scope === "qualified" ? geography.qualified : !geography.qualified);
      if (matches && items.length === limit)
        return { items, nextCursor: String(cursor), scope };
      cursor++;
      scanned++;
      if (matches) items.push({ ...row, geography });
      if (scanned >= 1000) return { items, nextCursor: String(cursor), scope };
    }
    if (rows.length < 100) return { items, nextCursor: null, scope };
  }
  return { items, nextCursor: String(cursor), scope };
}
