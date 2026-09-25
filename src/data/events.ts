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
export const events: CommunityEvent[] = [
  {
    slug: 'kubefest-02',
    date: '2026-09-26',
    time: '09:00',
    endTime: '13:00',
    city: { 'es-pe': 'Lima', en: 'Lima' },
    venue: 'Universidad ESAN',
    address: 'Jr. Alonso de Molina 1652, Santiago de Surco',
    status: 'soldout',
    organizer: 'KubeFest',
    registerUrl: 'https://www.eventbrite.co/e/kubefest-02-tickets-1997093130313?aff=ebdssbdestsearch',
    title: { 'es-pe': 'KubeFest #02', en: 'KubeFest #02' },
    description: {
      'es-pe': 'Una mañana de charlas técnicas sobre las tecnologías cloud native que están transformando la industria: comunidades cloud native en el Perú, procesamiento en el borde con KubeEdge, Java con Quarkus y OpenShift, Model Context Protocol para interactuar con Kubernetes y desarrollo de aplicaciones con IA sobre Kubernetes.',
      en: 'A morning of technical talks on the cloud native technologies transforming the industry: cloud native communities in Peru, edge processing with KubeEdge, Java with Quarkus and OpenShift, the Model Context Protocol for interacting with Kubernetes and AI application development on Kubernetes.',
    },
    speakers: ['Carlos Ortiz', 'Diego Del Castillo & Cristhian Vargas', 'Henry Tarazona', 'Miguel Villa', 'Jose Luis Buga'],
  },
];

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
