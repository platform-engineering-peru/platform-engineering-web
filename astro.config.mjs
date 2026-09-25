// @ts-check
import process from 'node:process';
import { defineConfig } from 'astro/config';

// En GitHub Actions, SITE y BASE_PATH se inyectan desde el workflow.
// Localmente se usa la raíz para que `npm run dev` funcione sin configuración.
const site = process.env.SITE ?? 'http://localhost:4321';
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  output: 'static',
  i18n: {
    locales: ['es', 'en'],
    defaultLocale: 'es',
    routing: {
      prefixDefaultLocale: true,
      redirectToDefaultLocale: false,
    },
  },
});
