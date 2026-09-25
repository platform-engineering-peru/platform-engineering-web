// @ts-check
import process from 'node:process';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// En GitHub Actions, SITE y BASE_PATH se inyectan desde el workflow.
// Localmente se usa la raíz para que `npm run dev` funcione sin configuración.
const site = process.env.SITE ?? 'http://localhost:4321';
const base = process.env.BASE_PATH ?? '/';

// Páginas que no deben indexarse: la raíz (solo redirige al idioma) y la 404.
const rootUrl = new URL(base, site).href;
/** @param {string} page */
const excluded = (page) => page === rootUrl || /\/404\/?$/.test(page);

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  output: 'static',
  i18n: {
    // Mantener sincronizado con `src/i18n/config.ts`.
    locales: ['es-pe', 'en'],
    defaultLocale: 'es-pe',
    routing: {
      prefixDefaultLocale: true,
      redirectToDefaultLocale: false,
    },
  },
  integrations: [
    sitemap({
      filter: (page) => !excluded(page),
      // Genera las alternativas hreflang de cada URL dentro del sitemap.
      i18n: {
        defaultLocale: 'es-pe',
        locales: { 'es-pe': 'es-PE', en: 'en' },
      },
    }),
  ],
});
