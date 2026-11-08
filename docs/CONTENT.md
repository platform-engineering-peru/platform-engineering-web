# Content maintenance

## Source of truth

- Community URLs and contact: `src/data/site.ts`. Unconfirmed channels remain `null`; never substitute invented links.
- Events: `src/data/events.ts`; speaker records: `src/data/speakers.ts`.
- Organizers: `src/data/organizers.ts`. Keep Josua first and ensure each profile's artwork, name, role, and links refer to the same person.
- Curated resources: `src/data/resources.ts`.
- Opportunities: `src/data/opportunities.ts`. Demonstration listings need verified replacements before they can be described as real openings.
- Home editorial copy: `src/modules/home/editorial-copy.ts`.
- Shared translations: `src/i18n/locales/`. Feature components may also contain paired locale strings.

## Add an event

Follow the existing event type and entries. Supply a unique slug, Lima-local date/time, venue or online location, both language versions, registration URL when confirmed, and names that match speaker records. Event detail routes are generated automatically. Upcoming/past classification happens at build time; the scheduled deployment refreshes it daily.

## Add a route

Create a localized page under `src/pages/[lang]/` using the shared static-path helper and `BaseLayout`. Implement the feature under `src/modules/`, update relevant navigation/search entries, and verify both languages. Keep WIP pages inside the normal site shell.

## Brand assets

The footer links to the branding library. Its approved content includes two horizontal logo treatments, mascot poses, palette values, social assets, merchandise references, and downloadable guidelines. Retain original PNG/SVG downloads even when the on-page preview uses WebP.

The official palette and usage rules are in [brand guidelines](../design/BRAND_GUIDELINES.md). Prompts in `design/` document asset provenance and should not be treated as a request to regenerate artwork.
