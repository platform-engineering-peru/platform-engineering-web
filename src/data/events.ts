import { speakerIdentity } from './speakers';
import { publicRecords } from './public-content';
import { langCode, type Lang } from '@i18n/config';
import type { Localized } from '@i18n/utils';

export type StatusTone = 'violet' | 'green' | 'red' | 'neutral' | 'amber';

/** Estado de inscripción de un evento próximo; los pasados se marcan solos. */
export type EventStatus = 'open' | 'limited' | 'free' | 'soldout';

export interface CommunityEvent {
  slug: string;
  /** Fecha local de Lima, `YYYY-MM-DD`. */
  date: string;
  /** Hora de inicio (y opcionalmente fin), hora de Lima. */
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

/** Eventos de la comunidad; próximos y pasados se separan por fecha al compilar. */
export const events: CommunityEvent[] = publicRecords('events').map(r => ({slug:r.slug,date:r.date,time:r.time,endTime:r.endTime||undefined,city:r.city,venue:r.venue,address:r.address||undefined,online:r.online||undefined,status:r.eventStatus,organizer:r.organizer||undefined,registerUrl:r.registerUrl||undefined,title:r.title,description:r.description,speakers:r.speakerIds.map((id:string)=>speakerIdentity.get(id)!),recording:r.recording||undefined}));

/** Hoy en Lima (`YYYY-MM-DD`). En un sitio estático se evalúa al compilar. */
function todayInLima(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
}

export function isUpcoming(event: CommunityEvent): boolean {
  return event.date >= todayInLima();
}

export const upcomingEvents = () =>
  events.filter(isUpcoming).sort((a, b) => a.date.localeCompare(b.date));

export const pastEvents = () =>
  events.filter((e) => !isUpcoming(e)).sort((a, b) => b.date.localeCompare(a.date));

const statusTone: Record<EventStatus, StatusTone> = {
  open: 'green',
  limited: 'amber',
  free: 'violet',
  soldout: 'red',
};

/** Tono de la badge: los eventos pasados son siempre neutrales. */
export function eventTone(event: CommunityEvent): StatusTone {
  return isUpcoming(event) ? statusTone[event.status] : 'neutral';
}

function parts(date: string, lang: Lang, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(langCode(lang), { ...options, timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}

/** Día y mes abreviado para el bloque de fecha (`17` / `Oct`). */
export function dateBlock(date: string, lang: Lang) {
  const month = parts(date, lang, { month: 'short' }).replace('.', '');
  return { day: date.slice(8, 10), month: month.charAt(0).toUpperCase() + month.slice(1) };
}

/** Fecha larga (`sábado, 17 de octubre de 2026`). */
export function longDate(date: string, lang: Lang) {
  return parts(date, lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
