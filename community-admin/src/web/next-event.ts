import { localTimeToInstant } from "./schedule";
/** Select by the event's wall clock, independently of the operator's browser zone. */
export function nextUpcomingEvent<
  T extends { state: string; payload: Record<string, any> },
>(records: T[], now = Date.now()): T | null {
  const candidates = records.flatMap((record) => {
    const p = record.payload;
    if (record.state === "archived" || !p.date) return [];
    try {
      // A date without a time remains upcoming through the end of its local day.
      const instant = Date.parse(
        localTimeToInstant(
          `${p.date}T${p.time || "23:59"}`,
          p.timeZone || "America/Lima",
        ),
      );
      return instant >= now ? [{ record, instant }] : [];
    } catch {
      return [];
    }
  });
  candidates.sort((a, b) => a.instant - b.instant);
  return candidates[0]?.record ?? null;
}
export async function loadEventPages<T>(
  fetchPage: (
    cursor?: string,
  ) => Promise<{ items: T[]; nextCursor?: string | null }>,
): Promise<T[]> {
  const records: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    records.push(...page.items);
    cursor = page.nextCursor || undefined;
  } while (cursor);
  return records;
}
