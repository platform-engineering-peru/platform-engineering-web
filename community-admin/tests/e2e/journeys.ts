import type { Journey } from "./harness";
import { communityJourney } from "./journeys/community";
import { publicContentJourney } from "./journeys/public-content";
import { permissionsJourney } from "./journeys/permissions";
import { observabilityJourney } from "./journeys/observability";
import { relationsConsentJourney } from "./journeys/relations-consent";
import { consoleControlsJourney } from "./journeys/console-controls";

import { socialBlogJourney } from "./journeys/social-blog";
import { socialStaleJourney } from "./journeys/social-stale";
import { calendarAttributionJourney } from "./journeys/calendar-attribution";

export const journeys: Journey[] = [
  communityJourney,
  publicContentJourney,
  permissionsJourney,
  observabilityJourney,
  relationsConsentJourney,
  consoleControlsJourney,
  socialBlogJourney,
  socialStaleJourney,
  calendarAttributionJourney,
];
