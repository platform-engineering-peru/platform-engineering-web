# platform-engineering-web

Sitio estático multi-idioma construido con [Astro](https://astro.build) y desplegado en GitHub Pages.

## Comandos

| Comando           | Acción                                  |
| ----------------- | --------------------------------------- |
| `npm install`     | Instala dependencias                    |
| `npm run dev`     | Servidor local en `http://localhost:4321` |
| `npm run build`   | Valida tipos y genera `dist/`           |
| `npm run preview` | Sirve el build localmente               |

## Estructura

```
src/
├── i18n/                 # Núcleo de internacionalización
│   ├── config.ts         # Idiomas soportados e idioma por defecto
│   ├── locales/*.json    # Diccionarios de traducción (es.json es la referencia)
│   ├── utils.ts          # t(), localizePath(), switchLangPath()
│   └── paths.ts          # getStaticPaths compartido para páginas [lang]
├── layouts/              # Estructura HTML común (head, header, footer)
├── components/
│   ├── layout/           # Header, Footer, navigation.ts (menú)
│   └── ui/               # Componentes genéricos reutilizables (Card, LanguagePicker)
├── modules/              # Secciones por funcionalidad, cada una autocontenida
│   ├── home/             # Hero, Features
│   └── about/
├── pages/
│   ├── index.astro       # Redirige al idioma del navegador
│   ├── 404.astro
│   └── [lang]/           # Una página por ruta, generada para cada idioma
└── styles/global.css     # Tokens de diseño (claro/oscuro)
```

URLs resultantes: `/<base>/es/`, `/<base>/en/about/`, etc.

## Cómo extender

**Añadir un idioma**
1. Agregar la entrada en `src/i18n/config.ts` (`languages`) y en `astro.config.mjs` (`i18n.locales`).
2. Crear `src/i18n/locales/<código>.json` con las mismas claves que `es.json`.
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
