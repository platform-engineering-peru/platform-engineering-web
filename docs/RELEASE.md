# Version-one optimization and release record

## Scope

Preserve the accepted bilingual site, artwork, navigation, animation behavior, and content while preparing the complete working version for GitHub review. This pass deliberately avoids layout redesign, animation rewrites, destructive asset cleanup, or major framework migrations.

## Changes

- Nine large PNG previews now have lossless WebP counterparts. Original images remain available for download.
- Total encoded size for those previews decreased from **16,320,429 bytes to 9,227,380 bytes**, a **43.5% reduction**. This is an asset-size measurement, not a measured page-speed or Core Web Vitals score.
- Pixel and transparency comparisons verify the optimized previews retain their visible artwork.
- Compatible dependency updates resolved the audit findings present at the start of this pass.
- Pull-request/branch CI now checks tests, generated links, documentation links, image parity, and repository-subpath hosting.
- Production deployment now tests first, guards the main branch, limits write permissions to the deploy job, and uses immutable action SHAs.
- Dependabot covers npm and GitHub Actions updates.
- English maintenance documentation and repository-specific agent guidance replace the outdated README. Brand-kit Markdown documentation is also in English; the downloadable ZIP includes the updated documents and original artwork.

## Validation surfaces

The baseline had 47 passing behavior tests. Release regression tests additionally cover CI/deployment contracts and preview/download URLs. Run the commands in [TESTING.md](TESTING.md) for the current test count and results.

Generated-link validation covers all 34 static pages in root and repository-subpath configurations. Image validation covers all nine conversions. A clean Node 22 installation in GitHub Actions is the final remote compatibility gate.

## Release boundary

The delivery is pushed as a branch and opened for review. Production remains on the current main revision until the PR is merged. Consult the PR's exact commit checks for authoritative remote status; local test success alone does not establish that production was deployed.

External links, GPU-specific rendering, field performance, and content accuracy are not exhaustively certified by these automated checks. The existing approved visuals are preserved through lossless conversion rather than re-generated artwork.
