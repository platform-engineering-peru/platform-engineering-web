# platform-engineering-web

Sitio de **Platform Engineering Perú**, el capítulo peruano de la comunidad global de platform engineering. Sitio estático en español de Perú (`es-PE`) e inglés, construido con [Astro](https://astro.build) y desplegado en GitHub Pages.

El diseño implementa el sistema de diseño *Platform Engineering Perú* (Claude Design): tokens en `src/styles/tokens/`, componentes en `src/components/ui/`, tema oscuro por defecto y tema claro opcional (se recuerda en `localStorage`). Tipografías Archivo y JetBrains Mono desde Google Fonts; íconos Lucide embebidos en `src/components/ui/icons.ts`.

Páginas: Inicio, Eventos (lista y detalle), Recursos y Comunidad, cada una en `/es-pe/` y `/en/`.

## Comandos

| Comando           | Acción                                  |
| ----------------- | --------------------------------------- |
| `npm install`     | Instala dependencias                    |
| `npm run dev`     | Servidor local en `http://localhost:4321` |
| `npm run build`   | Valida tipos y genera `dist/`           |
| `npm run preview` | Sirve el build localmente               |

## Estructura

```
public/
├── brand/                # Logos (oscuro / claro / isotipo) e ilustración del hero (WebP)
├── og.jpg                # Imagen para vistas previas en redes (1200×630)
└── favicon.png
src/
├── i18n/                 # Núcleo de internacionalización
│   ├── config.ts         # Idiomas (es-pe, en) e idioma por defecto
│   ├── locales/*.json    # Diccionarios (es-pe.json es la referencia)
│   ├── utils.ts          # t(), localizePath(), switchLangPath(), pick()
│   └── paths.ts          # getStaticPaths compartido para páginas [lang]
├── data/                 # Contenido editable
│   ├── site.ts           # Enlaces de la comunidad (WhatsApp, LinkedIn…) y de platformengineering.org
│   ├── events.ts         # Eventos (próximos/pasados se calculan al compilar)
│   ├── speakers.ts       # Speakers (fotos, cargo, charla, LinkedIn)
│   └── resources.ts      # Recursos curados y temas del filtro
├── lib/                  # asset() para rutas con base y datos estructurados (JSON-LD)
├── layouts/              # Estructura HTML común (head/SEO, header, footer, diálogo Únete)
├── components/
│   ├── layout/           # Header, Footer, JoinDialog, navigation.ts (menú)
│   └── ui/               # Componentes del sistema de diseño (Button, Badge, Card, EventCard…)
├── modules/              # Secciones por funcionalidad, cada una autocontenida
│   ├── home/             # Hero, NextMeetup, Pillars, WhatIs, University, Speakers, CfpBand
│   │                     # (Speakers muestra los del evento más cercano)
│   ├── events/           # Lista con pestañas y detalle de evento
│   ├── resources/        # Recursos curados con filtro por tema
│   └── community/
├── pages/
│   ├── index.astro       # Redirige al idioma del navegador
│   ├── 404.astro
│   ├── robots.txt.ts     # robots.txt con la URL absoluta del sitemap
│   └── [lang]/           # Una página por ruta, generada para cada idioma
└── styles/
    ├── tokens/           # Tokens del sistema de diseño (color, tipografía, espacio, efectos)
    └── global.css        # Base, layout y motivos de marca (layer stripe, retícula blueprint)
```

URLs resultantes: `/<base>/es-pe/`, `/<base>/en/events/`, `/<base>/es-pe/events/<slug>/`, etc.

## Contenido

- **Enlaces de la comunidad** (`src/data/site.ts`): LinkedIn está configurado. WhatsApp, Meetup, YouTube, el formulario de call for papers y el de sponsors siguen en `null` y se muestran como "Próximamente"; mientras no haya formulario, "Proponer charla" y "Sé sede o sponsor" abren el diálogo "Únete".
- **Eventos** (`src/data/events.ts`): KubeFest #02 (datos de su página en Eventbrite). No hay contenido de ejemplo.
- **Speakers** (`src/data/speakers.ts`): los de KubeFest #02; sus fotos se cargan desde el CDN de Eventbrite, así que dejarán de verse si el organizador las cambia.
- **Recursos** (`src/data/resources.ts`): enlaces verificados a platformengineering.org, con resumen propio en español.

Los eventos se clasifican en próximos/pasados **al compilar**, así que hay que volver a desplegar después de cada evento (por ejemplo, un push o *Run workflow* en GitHub Actions).

## SEO

- **Sitemap**: `@astrojs/sitemap` genera `sitemap-index.xml` con las alternativas `hreflang` (es-PE / en) de cada página; excluye la raíz (solo redirige) y la 404.
- **robots.txt**: permite todo y apunta al sitemap. Los buscadores solo lo leen en la raíz del dominio, así que en `usuario.github.io/<repo>/` no se usa; con dominio propio sí. En ese caso, envía el sitemap a mano en Google Search Console.
- **Metadatos** (`BaseLayout.astro`): título y descripción por página, `canonical`, `hreflang` (incluido `x-default`), Open Graph y Twitter Card con `public/og.jpg`. La 404 lleva `noindex`.
- **Datos estructurados** (`src/lib/structured-data.ts`): `Organization` y `WebSite` en el inicio; `Event` en cada evento (fecha con zona horaria de Lima, lugar, organizador, speakers y estado de las entradas). Se pueden validar con la [prueba de resultados enriquecidos](https://search.google.com/test/rich-results).

## Cómo extender

**Añadir un evento**
1. Agregar una entrada a `events` en `src/data/events.ts`: `slug`, `date` (`YYYY-MM-DD`, hora de Lima), `time`/`endTime`, `city`, `venue`, `address`, `status` (`open`, `limited`, `free`, `soldout`), `title` y `description` en ambos idiomas, y opcionalmente `organizer` (si no lo organiza el capítulo), `registerUrl`, `recording` y `online` (evento solo en línea).
2. Si tiene speakers, añadirlos en `src/data/speakers.ts` y listar sus nombres en `speakers` del evento.
3. La página `/<idioma>/events/<slug>/` se genera sola; el inicio muestra el próximo evento y sus speakers.

**Añadir un idioma**
1. Agregar la entrada en `src/i18n/config.ts` (`languages`) y en `astro.config.mjs` (`i18n.locales`).
2. Crear `src/i18n/locales/<código>.json` con las mismas claves que `es-pe.json`.
3. Registrarlo en `dictionaries` dentro de `src/i18n/utils.ts`. TypeScript avisará si faltan claves.

**Añadir una página**
1. Crear el módulo en `src/modules/<nombre>/` con un `index.ts` que exporte sus componentes.
2. Crear `src/pages/[lang]/<nombre>.astro` usando `getLangPaths` y `BaseLayout`.
3. Añadir las claves de texto a cada `locales/*.json` y, si procede, la entrada en `components/layout/navigation.ts`.

## Despliegue en GitHub Pages

1. Subir el repositorio a GitHub (rama `main`).
2. En **Settings → Pages → Build and deployment**, elegir **Source: GitHub Actions**.
3. Cada push a `main` ejecuta `.github/workflows/deploy.yml`, que obtiene `SITE` y `BASE_PATH`
   automáticamente con `actions/configure-pages`, por lo que funciona tanto en
   `usuario.github.io/<repo>/` como con dominio propio.

**Dominio propio (platformengineering.pe)**: la ruta base se toma de la configuración de Pages *en el momento del build*. Si se agrega o cambia el dominio, hay que volver a desplegar (**Actions → Deploy to GitHub Pages → Run workflow**); si no, el sitio sigue compilado para `/<repo>/` y no carga. Como el dominio pasa por Cloudflare y "Enforce HTTPS" está desactivado, GitHub informa `http://`; `astro.config.mjs` lo cambia a `https://` para canonical, sitemap y robots.txt.
