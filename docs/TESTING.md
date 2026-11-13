# Testing and acceptance

## Automated release gates

```sh
npm ci
npm test
npm run verify:build
npm run verify:docs
npm run verify:images
npm audit
```

`npm test` builds and type-checks before running Node tests. Tests cover interface behavior, resource geometry/filtering, organizer selection, branding downloads, motion bounds and reduced-motion states, peek diversity, and CI contracts.

`verify:build` checks relative/local image, script, stylesheet, and anchor destinations in all generated HTML pages. It does not fetch external websites or validate every CSS URL. `verify:docs` checks local Markdown links. `verify:images` compares decoded pixels and alpha channels with the original assets, proving the conversion does not alter visible artwork.

Validate repository-subpath hosting separately:

```sh
SITE=https://platform-engineering-peru.github.io BASE_PATH=/platform-engineering-web/ npm run build
BASE_PATH=/platform-engineering-web/ npm run verify:build
```

Run `npm test` again when returning to root-based tests: DOM fixture tests intentionally use a root build.

## Visual acceptance

For affected pages, inspect desktop (approximately 1280 px) and mobile (approximately 390 px), light/dark themes, keyboard navigation, and reduced motion. Confirm:

- No clipped text, overlapping decoration, horizontal overflow, or hidden controls.
- Navbar remains visible on WIP pages; theme changes update entire sections.
- Each organizer's image, large background name, details, and links agree.
- Four different home peek expressions and sizes are legible, with paws at an edge; scrolling hides/reveals them smoothly.
- Ukuku slides seated, banks directionally, and settles naturally.
- Memories remain usable with the fallback and normal WebGL rendering.
- Branding previews load and original downloads work.

Automated checks cannot certify artistic quality, browser GPU performance, or external link availability. Capture screenshots and describe any unverified behavior instead of reporting a blanket pass.

## Dependency compatibility

Dependabot groups Three.js with its type definitions and the Astro toolchain together.
Validate dependency updates with Node 22, a clean `npm ci`, the full test suite,
root and repository-subpath builds, and image/documentation checks. Three.js changes
also require a browser review of Memories and its fallback; successful compilation
alone does not establish rendering compatibility.

TypeScript 7.x updates are temporarily excluded. The attempted 7.0.2 upgrade fails
`npm ci` because `@astrojs/check` requires `typescript` in `^5.0.0 || ^6.0.0`.
Keep TypeScript 6 and do not bypass this contract with `--force` or
`--legacy-peer-deps`. Revisit the exclusion when Astro's checker supports the new
compiler API. Microsoft documents the API transition in the
[TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).
