import { IntegrationError } from "./security";
export function localTimeFor(date: Date, timezone: string) {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .format(date)
      .replace(" ", "T");
  } catch {
    throw new IntegrationError("INVALID_TIMEZONE");
  }
}
export function verifySchedule(
  date: Date,
  timezone: string,
  localTime: string,
) {
  if (!Number.isFinite(date.getTime()))
    throw new IntegrationError("INVALID_SCHEDULE");
  const resolved = localTimeFor(date, timezone);
  if (
    localTime &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(localTime) ||
      resolved.slice(0, localTime.length) !== localTime)
  )
    throw new IntegrationError("SCHEDULE_ZONE_MISMATCH");
  return resolved;
}
