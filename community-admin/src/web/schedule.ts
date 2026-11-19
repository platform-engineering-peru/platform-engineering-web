import { ApiError } from "./client";
/** Resolve a wall-clock input against its selected IANA zone, never the browser's zone. */
export function localTimeToInstant(value: string, zone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match)
    throw new ApiError(
      422,
      "SCHEDULE_INVALID",
      "Indica fecha y hora completas.",
    );
  const [, y, m, d, h, min] = match.map(Number);
  const wall = Date.UTC(y, m - 1, d, h, min);
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new ApiError(422, "TIMEZONE_INVALID", "La zona IANA no es válida.");
  }
  const represented = (instant: number) => {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(instant))
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, Number(p.value)]),
    );
    return Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
    );
  };
  // Discover the actual offsets around this date instead of assuming a one-hour DST shift.
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = wall + hours * 3600000;
    offsets.add(represented(sample) - sample);
  }
  const candidates = [...offsets]
    .map((offset) => wall - offset)
    .filter((instant) => represented(instant) === wall);
  if (candidates.length === 0)
    throw new ApiError(
      422,
      "SCHEDULE_GAP",
      "Esta hora no existe en la zona seleccionada por un cambio horario. Elige otra hora.",
    );
  if (candidates.length > 1)
    throw new ApiError(
      422,
      "SCHEDULE_AMBIGUOUS",
      "Esta hora se repite por un cambio horario. Elige una hora fuera de esa transición.",
    );
  return new Date(candidates[0]).toISOString();
}
