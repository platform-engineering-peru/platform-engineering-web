# Platform Engineering Perú

A bilingual community website for people building platforms and improving developer experience in Peru. Built with Astro and TypeScript, with static pages, local fonts, theme-aware illustrations, and progressive interactive experiences.

[Website](https://platformengineering.pe) · [Contributing](CONTRIBUTING.md) · [Architecture](docs/ARCHITECTURE.md) · [Deployment](docs/DEPLOYMENT.md) · [Brand guidelines](design/BRAND_GUIDELINES.md)

## Run locally

Use Node.js 22 (at least 22.12) and npm. `.nvmrc` matches CI.

```sh
nvm use
npm ci
npm run dev
```

Open `http://localhost:4321/es-pe/` or `http://localhost:4321/en/`.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Local development server |
| `npm run check` | Astro and TypeScript checks |
| `npm run build` | Type-check and generate `dist/` |
| `npm test` | Build first, then run all regression tests |
| `npm run test:unit` | Run tests against an existing build |
| `npm run verify:build` | Check generated local links and assets |
| `npm run verify:docs` | Check documentation links |
| `npm run verify:images` | Compare optimized image pixels and transparency with originals |
| `npm run optimize:images` | Regenerate selected lossless WebP previews |
| `npm run preview` | Serve the production build locally |

## Website

Both `/es-pe/` and `/en/` include home, events and event details, resources, community, Ukuku, memories, opportunities, and branding. Team, participate, golden paths, partners, and marketplace currently use integrated work-in-progress pages. The shared navigation remains available on these pages.

The header groups navigation under **Encounters**, **Explore**, and **Community**. The logo links home. Branding is linked from the footer. Partners belongs to Community; Marketplace belongs to Explore. The site supports light/dark themes and reduced motion.

Content is maintained in TypeScript data files and localized dictionaries. See [content editing](docs/CONTENT.md). Some opportunities and memories are demonstration content; do not present them as verified live listings. Community channels without a confirmed URL remain disabled.

## Quality and delivery

Pull requests and branch pushes run validation. Production deploys only from `main`, after tests and artifact checks pass. GitHub Pages provides the site origin and base path. A daily rebuild refreshes date-based event classification at 00:10 Lima time.

See [testing](docs/TESTING.md), [deployment and rollback](docs/DEPLOYMENT.md), and the [version-one optimization report](docs/RELEASE.md). Future coding agents should read [AGENTS.md](AGENTS.md) before changing the site.
