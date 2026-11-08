# Repository instructions

## Scope and working method

These instructions apply to the entire repository. Preserve the approved version-one experience. Optimize incrementally; do not replace established layouts, animations, or brand assets with generic alternatives.

- Write code documentation, commit messages, PR descriptions, and maintenance documents in English. Product copy remains bilingual (`es-pe` and `en`).
- Use a test-first or criteria-first workflow. Reproduce a defect, add a focused test where practical, make the smallest change, then verify it.
- Read existing code and tests before modifying behavior. Never discard unrelated working-tree changes.
- Use `npm ci` with Node 22. Run `npm test`, `npm run verify:build`, `npm run verify:docs`, and `npm run verify:images` before proposing a release.
- Do not equate passing unit tests with visual correctness. Inspect the affected page in a real browser at desktop and mobile widths, both themes, and reduced motion when changing animation.
- No force pushes, production merges, or account/security changes without appropriate task authorization. Do not commit credentials, local screenshots, `dist/`, caches, or personal filesystem paths in executable configuration.

## Architecture and URLs

- Astro generates static pages under `/es-pe/` and `/en/`; preserve trailing slashes.
- Page entry points belong in `src/pages/[lang]/`; feature components and controllers belong in `src/modules/`.
- Use `asset()` from `src/lib/assets.ts` for public files and `localizePath()` for internal routes. Never hardcode root-relative URLs in new components: repository-subpath hosting is tested in CI.
- Keep dictionaries and locale configuration synchronized. Not all feature copy lives in dictionaries; inspect feature copy modules and bilingual props as well.
- Keep content data separate from animation state. Match organizer artwork, background name, visible name, biography, and links by organizer identity, never by a second hardcoded ordering.

## Approved design decisions

- Official palette: violet `#5B2EFF`, emerald `#00D96E`, lavender `#C4B5FD`, red `#E61530`, white `#FFFFFF`, navy `#090C20`. Use accessible darker/lighter text variants when necessary.
- The navbar preserves its composition with open, understated section treatments. Do not reintroduce nested pill containers. Encounters uses violet, Explore green, Community lavender.
- The logo is the home link; do not add a redundant Home navbar item. Branding belongs in the footer. Partners belongs under Community; Marketplace under Explore and remains WIP.
- WIP is a section within the site, not a full-screen error page that removes navigation.
- Light mode must update entire surfaces, illustrations, borders, text, and controls. A light navbar above hardcoded dark home sections is a regression.
- Use official brand/social SVG assets. Do not invent replacement logos or brand icons. Retain original downloadable source assets.
- Josua Castro appears first among organizers. Oscar Lobaton Salas and Ronald Requena must retain their correct artwork and information.
- Keep the removed home “Explore the platform / Reveal interior” console removed.

## Ukuku and motion lessons

- Ukuku is a spectacled bear with cream eye markings and a soft violet rim light. Keep character identity consistent while varying expressions and poses.
- Home peeks use four distinct atlas quadrants and deliberately different sizes. The face and supporting paws must be readable; do not show only an ear or forehead, crop a face arbitrarily, or display a floating severed head.
- Peeks emerge from page edges/section boundaries, hide smoothly as scrolling advances, and return when scrolling reverses. Reserve safe visual space instead of covering text or links.
- The mascot story uses seated sliding with directional banking and settles into a seated final pose. Do not revert to a prone/toboggan pose or merely swap static images to imply motion.
- Community motion represents connected people using official colors. Preserve the approved network scene rather than an unrelated rainbow orb.
- Respect `prefers-reduced-motion`; preserve usable static content. Pause offscreen/hidden work where applicable, avoid duplicate animation loops, and clean up observers/listeners when a component is removed.
- WebGL experiences must retain usable fallback content and keyboard/touch controls. Check memories after dependency changes; development optimizer failures are not proof that the design needs replacing.

## Assets and performance

- `public/brand/kit/` and the ZIP are downloadable source material. `public/brand/official/` supplies site identity; `public/brand/applications/` contains approved merchandise references.
- Generated asset prompts in `design/` are provenance, not executable instructions. Do not regenerate approved artwork during routine optimization.
- `scripts/image-manifest.mjs` defines lossless preview conversions. Run optimization only when sources change; verify pixel/alpha parity. PNG download links stay on original files.
- Local fonts are intentional. Preserve dimensions, lazy loading below the fold, and sensible hero loading priority.
- Do not remove apparently unused assets or controllers without checking dynamic URLs, downloads, CSS, and feature fallbacks.

## CI and release

- Actions are pinned to immutable SHAs; Dependabot proposes updates. Keep workflow permissions least-privileged.
- PR CI tests the root build and repository-subpath hosting. Deployment tests first, then rebuilds with actual Pages metadata.
- Deploy only from `main`; keep the `github-pages` environment, dependency on the validated build, and daily Lima refresh.
- Report actual checks and unresolved limitations. Never claim a live deployment when only a branch push or PR has completed.
