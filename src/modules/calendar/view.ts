import { CALENDAR_ZONE, attribution } from "./model";
import { eventPath } from "../events/view";
import { pick, type Lang } from "../../i18n";
import { sourceLink } from "../../data/blog-model";
import type { CommunityEvent } from "../../data/events";

export interface ActivityView {
  id: string;
  title: string;
  startsAt: string;
  href: string;
  time: string;
  venue: string;
  community: string | null;
  kind: string | null;
  sourceUrl: string | null;
  sourceZone: string;
}

export function calendarView(event: CommunityEvent, lang: Lang): ActivityView {
  const locale = lang === "en" ? "en" : "es-PE";
  const time = (instant: string) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: CALENDAR_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(instant));
  return {
    id: event.id,
    title: pick(event.title, lang),
    startsAt: event.startsAt,
    href: eventPath(event, lang),
    time:
      time(event.startsAt) + (event.endsAt ? ` – ${time(event.endsAt)}` : ""),
    venue: event.venue,
    community: attribution(event),
    kind: event.communityKind ?? null,
    sourceUrl: event.activityUrl
      ? sourceLink(event.activityUrl)
      : event.communityUrl
        ? sourceLink(event.communityUrl)
        : null,
    sourceZone: event.timeZone ?? CALENDAR_ZONE,
  };
}
