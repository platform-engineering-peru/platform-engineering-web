/**
 * Datos estructurados schema.org (JSON-LD) para buscadores.
 * https://developers.google.com/search/docs/appearance/structured-data
 */
import { langCode, pick, useTranslations, type Lang } from '@i18n/index';
import { communityLinks } from '@data/site';
import type { CommunityEvent } from '@data/events';
import { speakersByName } from '@data/speakers';
import { asset } from './assets';

type JsonLd = Record<string, unknown>;

const abs = (path: string, site: URL) => new URL(path, site).href;

/** Organización + sitio web, para la página de inicio. */
export function organizationLd(lang: Lang, site: URL, homeUrl: string): JsonLd[] {
  const t = useTranslations(lang);
  const sameAs = [communityLinks.linkedin, communityLinks.youtube, communityLinks.meetup].filter(Boolean);
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: t('site.title'),
      url: homeUrl,
      logo: abs(asset('brand/logo-mark-dark.png'), site),
      description: t('site.description'),
      sameAs,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: t('site.title'),
      url: homeUrl,
      inLanguage: langCode(lang),
    },
  ];
}

/** Evento con lugar, horario, estado de entradas, organizador y speakers. */
export function eventLd(event: CommunityEvent, lang: Lang, site: URL, pageUrl: string): JsonLd {
  const t = useTranslations(lang);
  // Lima no tiene horario de verano: siempre UTC−05:00.
  const at = (time: string) => `${event.date}T${time}:00-05:00`;
  const performers = speakersByName(event.speakers).map((s) => ({
    '@type': 'Person',
    name: s.name,
    ...(s.url ? { sameAs: s.url } : {}),
  }));

  return {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: pick(event.title, lang),
    description: pick(event.description, lang),
    url: pageUrl,
    inLanguage: langCode(lang),
    startDate: at(event.time),
    ...(event.endTime ? { endDate: at(event.endTime) } : {}),
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: event.online
      ? 'https://schema.org/OnlineEventAttendanceMode'
      : 'https://schema.org/OfflineEventAttendanceMode',
    location: event.online
      ? { '@type': 'VirtualLocation', url: event.registerUrl ?? pageUrl }
      : {
          '@type': 'Place',
          name: event.venue,
          address: {
            '@type': 'PostalAddress',
            ...(event.address ? { streetAddress: event.address } : {}),
            addressLocality: pick(event.city, lang),
            addressCountry: 'PE',
          },
        },
    image: [abs(asset('og.jpg'), site)],
    organizer: event.organizer
      ? { '@type': 'Organization', name: event.organizer }
      : { '@type': 'Organization', name: t('site.title'), url: abs(asset(''), site) },
    ...(performers.length ? { performer: performers } : {}),
    ...(event.registerUrl
      ? {
          offers: {
            '@type': 'Offer',
            url: event.registerUrl,
            availability: event.status === 'soldout' ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
          },
        }
      : {}),
  };
}
