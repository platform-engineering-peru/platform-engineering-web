/** Editorial dates are grouped in the community zone, independently of browser timezone. */
export const calendarZone = "America/Lima";
export function calendarDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: calendarZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return ["year", "month", "day"]
    .map((type) => parts.find((p) => p.type === type)!.value)
    .join("-");
}
export function agendaMonth(value: string | null | undefined): string {
  return calendarDate(value).slice(0, 7);
}
/** Date-only arithmetic uses UTC; no DST or workstation zone can move the selected date. */
export function shiftDate(value: string, amount: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
export function shiftMonth(value: string, amount: number): string {
  const date = new Date(`${value}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + amount);
  return date.toISOString().slice(0, 7);
}
export function monthCells(month: string): string[] {
  const start = `${month}-01`;
  const weekday = new Date(`${start}T12:00:00Z`).getUTCDay();
  const offset = (weekday + 6) % 7;
  const last = shiftDate(`${shiftMonth(month, 1)}-01`, -1);
  const count = Math.ceil((offset + Number(last.slice(-2))) / 7) * 7;
  return Array.from({ length: count }, (_, i) => shiftDate(start, i - offset));
}
export type ScheduledPublication = {
  id: string;
  schedule_at?: string | null;
  scheduleAt?: string | null;
};
export function publicationInstant(
  record: ScheduledPublication,
): string | null {
  return record.schedule_at ?? record.scheduleAt ?? null;
}
export function groupPublications<T extends ScheduledPublication>(
  records: T[],
): { days: Map<string, T[]>; unscheduled: T[] } {
  const days = new Map<string, T[]>(),
    unscheduled: T[] = [];
  for (const record of [...records].sort((a, b) =>
    String(publicationInstant(a) ?? "").localeCompare(
      String(publicationInstant(b) ?? ""),
    ),
  )) {
    const day = calendarDate(publicationInstant(record));
    if (!day) unscheduled.push(record);
    else days.set(day, [...(days.get(day) ?? []), record]);
  }
  return { days, unscheduled };
}
