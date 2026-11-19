export const CALENDAR_ZONE = "America/Lima";

/** Preserve a known legacy end time; absence remains unknown rather than midnight. */
export function eventEnd(
  event: Parameters<typeof eventInstant>[0] & {
    endsAt?: string | null;
    endDate?: string | null;
    endTime?: string | null;
  },
): string | undefined {
  if (!event.endsAt && !event.endDate && !event.endTime) return undefined;
  return eventInstant({
    ...event,
    startsAt: event.endsAt,
    startDate: event.endDate,
    time: event.endTime || event.time,
  });
}

/** Legacy public events have null derived instants; resolve their original wall time without guessing DST gaps. */
export function eventInstant(event: {
  startsAt?: string | null;
  startDate?: string | null;
  date: string;
  time: string;
  timeZone?: string;
}): string {
  if (event.startsAt || event.startDate) {
    const instant = event.startsAt || event.startDate!;
    if (!Number.isFinite(Date.parse(instant)))
      throw new Error("Invalid event instant");
    return instant;
  }
  const zone = event.timeZone || CALENDAR_ZONE;
  const wall = `${event.date}T${event.time}:00`;
  const guess = Date.parse(wall + "Z");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const local = (ms: number) => {
    const parts = formatter.formatToParts(new Date(ms));
    const part = (type: string) => parts.find((p) => p.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
  };
  const offsets = new Set(
    [-86400000, 0, 86400000].map(
      (delta) => Date.parse(local(guess + delta) + "Z") - (guess + delta),
    ),
  );
  const candidates = [...offsets]
    .map((offset) => guess - offset)
    .filter((candidate) => local(candidate) === wall);
  if (candidates.length !== 1)
    throw new Error("Ambiguous or nonexistent event wall time");
  return new Date(candidates[0]).toISOString();
}

/** Numeric format parts avoid locale/browser-zone-dependent day keys. */
export function limaDay(instant: string | Date): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime()))
    throw new Error("Invalid calendar instant");
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: CALENDAR_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function shiftMonth(month: string, delta: number): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 1 + delta, 1, 12))
    .toISOString()
    .slice(0, 7);
}

/** Monday-first rows with noninteractive padding, including a complete last week. */
export function monthCells(month: string): (string | null)[] {
  const first = `${month}-01`;
  const offset = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  const count =
    new Date(`${shiftMonth(month, 1)}-01T12:00:00Z`).getTime() -
    new Date(`${first}T12:00:00Z`).getTime();
  const days = count / 86400000;
  const cells: (string | null)[] = Array(offset).fill(null);
  for (let i = 0; i < days; i++) cells.push(shiftDay(first, i));
  while (cells.length % 7) cells.push(null);
  return cells;
}

export interface CalendarActivity {
  startsAt: string;
  endsAt?: string;
  communityKind?: "own" | "guest";
  communityName?: string;
  organizer?: string;
}

export function monthActivities<T extends CalendarActivity>(
  events: T[],
  month: string,
): T[] {
  return events
    .filter((e) => limaDay(e.startsAt).startsWith(month + "-"))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

export function attribution(
  event: Pick<
    CalendarActivity,
    "communityKind" | "communityName" | "organizer"
  >,
): string | null {
  return (
    event.communityName?.trim() ||
    event.organizer?.trim() ||
    (event.communityKind === "own" ? "Platform Engineering Perú" : null)
  );
}
