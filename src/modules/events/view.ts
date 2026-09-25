import { localizePath, pick, useTranslations, type Lang } from '@i18n/index';
import { dateBlock, eventTone, isUpcoming, type CommunityEvent } from '@data/events';

/** Props de `EventCard` para un evento, en el idioma dado. */
export function eventCardProps(event: CommunityEvent, lang: Lang) {
  const t = useTranslations(lang);
  const upcoming = isUpcoming(event);
  return {
    ...dateBlock(event.date, lang),
    title: pick(event.title, lang),
    meta: [pick(event.city, lang), event.venue, event.time],
    status: upcoming ? t(`event.status.${event.status}` as const) : t('event.status.past'),
    statusTone: eventTone(event),
    href: eventPath(event, lang),
  };
}

export function eventPath(event: CommunityEvent, lang: Lang) {
  return localizePath(lang, `/events/${event.slug}`);
}
