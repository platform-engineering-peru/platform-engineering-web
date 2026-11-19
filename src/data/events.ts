import { publicRecords } from "./public-content";
import { speakerIdentity } from "./speakers";
import { eventInstant, eventEnd, limaDay } from "../modules/calendar/model";
import { langCode, type Lang } from "@i18n/config";
import type { Localized } from "@i18n/utils";

export type StatusTone = "violet" | "green" | "red" | "neutral" | "amber";

/** Estado de inscripción de un evento próximo; los pasados se marcan solos. */
export type EventStatus = "open" | "limited" | "free" | "soldout";

export interface CommunityEvent {
  id: string;
  slug: string;
  startsAt: string;
  endsAt?: string;
  communityKind?: "own" | "guest";
  communityName?: string;
  communityUrl?: string;
  activityUrl?: string;
  timeZone?: string;
  startDate?: string;
  endDate?: string;
  /** Original event-local date, YYYY-MM-DD. Calendar grouping uses startsAt in Lima. */
  date: string;
  /** Original wall-clock times in timeZone. */
  time: string;
  endTime?: string;
  city: Localized;
  venue: string;
  address?: string;
  /** Evento solo en línea (afecta a los datos estructurados). */
  online?: boolean;
  status: EventStatus;
  /** Organizador cuando no es el capítulo (eventos aliados). */
  organizer?: string;
  /** Página de inscripción (Eventbrite, Meetup…). */
  registerUrl?: string;
  title: Localized;
  description: Localized;
  /** Nombres de `speakers.ts`. */
  speakers: string[];
  recording?: string;
}

/** UUID speaker references resolve through the current public identity map. */
export const events: CommunityEvent[] = publicRecords("events").map((r) => ({
  id: r.id,
  slug: r.slug,
  startsAt: eventInstant(r as unknown as Parameters<typeof eventInstant>[0]),
  endsAt: eventEnd(r as unknown as Parameters<typeof eventEnd>[0]),
  communityKind: r.communityKind,
  communityName: r.communityName || undefined,
  communityUrl: r.communityUrl || undefined,
  activityUrl: r.activityUrl || undefined,
  timeZone: r.timeZone,
  startDate: r.startDate || undefined,
  endDate: r.endDate || undefined,
  date: r.date,
  time: r.time,
  endTime: r.endTime || undefined,
  city: r.city,
  venue: r.venue,
  address: r.address || undefined,
  online: r.online || undefined,
  status: r.eventStatus,
  organizer: r.organizer || undefined,
  registerUrl: r.registerUrl || undefined,
  title: r.title,
  description: r.description,
  speakers: r.speakerIds.map((id: string) => {
    const name = speakerIdentity.get(id);
    if (!name) throw new Error(`Unknown public speaker ${id}`);
    return name;
  }),
  recording: r.recording || undefined,
}));

/** Hoy en Lima (`YYYY-MM-DD`). En un sitio estático se evalúa al compilar. */
function todayInLima(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(
    new Date(),
  );
}

export function isUpcoming(event: CommunityEvent): boolean {
  return limaDay(event.startsAt) >= todayInLima();
}

export const upcomingEvents = () =>
  events
    .filter(isUpcoming)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

export const pastEvents = () =>
  events
    .filter((e) => !isUpcoming(e))
    .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));

const statusTone: Record<EventStatus, StatusTone> = {
  open: "green",
  limited: "amber",
  free: "violet",
  soldout: "red",
};

/** Tono de la badge: los eventos pasados son siempre neutrales. */
export function eventTone(event: CommunityEvent): StatusTone {
  return isUpcoming(event) ? statusTone[event.status] : "neutral";
}

function parts(date: string, lang: Lang, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(langCode(lang), {
    ...options,
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

/** Día y mes abreviado para el bloque de fecha (`17` / `Oct`). */
export function dateBlock(date: string, lang: Lang) {
  const month = parts(date, lang, { month: "short" }).replace(".", "");
  return {
    day: date.slice(8, 10),
    month: month.charAt(0).toUpperCase() + month.slice(1),
  };
}

/** Fecha larga (`sábado, 17 de octubre de 2026`). */
export function longDate(date: string, lang: Lang) {
  return parts(date, lang, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
