# Architecture

## Rendering

Astro builds static HTML for each supported locale. `src/layouts/BaseLayout.astro` owns metadata, font loading, shared navigation, theme initialization, footer, and the join dialog. Feature-specific client controllers enhance server-rendered content.

| Directory | Responsibility |
| --- | --- |
| `src/pages/` | Routes, redirects, robots.txt, and localized entry points |
| `src/modules/home/` | Editorial sections, discovery hero, four Ukuku peeks |
| `src/modules/community/` | About content, connected-people network, organizers |
| `src/modules/mascot/` | Ukuku story and scroll-driven seated motion |
| `src/modules/resources/` | Resource archive, filtering, covers, and geometry |
| `src/modules/memories/` | Interactive memory ribbon and fallbacks |
| `src/modules/opportunities/` | Opportunity browsing and cards |
| `src/modules/branding/` | Official downloads, palette, mascot art, applications |
| `src/modules/work-in-progress/` | Shared in-site placeholder sections |
| `src/components/layout/` | Mega-menu, search, footer, dialogs |
| `src/components/motion/` | Shared pointer and mascot motion utilities |
| `src/data/` | Community links, events, speakers, organizers, resources, opportunities |
| `src/i18n/` | Locale configuration, dictionaries, route helpers |
| `src/styles/` | Tokens, global styles, editorial refinements |
| `tests/` | Node test runner tests using tsx and Happy DOM |
| `scripts/` | Build/link verification and lossless image tooling |

## Interaction boundaries

Motion math is extracted into testable functions where practical. Canvas/WebGL experiences remain enhancements; semantic content and controls must work without depending on a continuous rendering loop. Search and resource filters operate on local data. No backend or secret is required to build the site.

The mega-menu is implemented in `Header.astro`, `mega-menu.css`, and `mega-menu.ts`. Inspect these when changing navigation; the older `navigation.ts` list is not a complete representation of the current mega-menu.

## Hosting

`astro.config.mjs` accepts `SITE` and `BASE_PATH`. The default origin is localhost for development. Production configuration normalizes non-local HTTP origins to HTTPS for canonical, sitemap, robots, and social URLs. Both locales are prefixed and generated with trailing slashes.

`public/` files are copied unchanged into the output. Optimized preview files are committed alongside original download files; they do not require conversion during deployment. See [testing](TESTING.md) for parity checks.
