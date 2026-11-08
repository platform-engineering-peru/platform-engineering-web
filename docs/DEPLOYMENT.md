# Deployment and operations

## Workflows

- **Validate website** (`.github/workflows/ci.yml`): pull requests, non-main pushes, and manual runs. Clean install, build/type checks, regression tests, local links, documentation links, image parity, and a repository-subpath build.
- **Deploy to GitHub Pages** (`.github/workflows/deploy.yml`): main pushes, manual main runs, and daily at 05:10 UTC / 00:10 Lima. Tests first; then rebuilds using Pages origin/base metadata, validates local URLs, uploads the artifact, and deploys.

Production jobs are guarded to `refs/heads/main`; manually selecting another branch cannot deploy. Only the deploy job receives `pages: write` and `id-token: write`. Builds use read-only repository access. Workflow actions are SHA-pinned and updates are proposed by Dependabot.

GitHub Pages must use **GitHub Actions** as its source. The production environment is `github-pages`. The current custom domain is `platformengineering.pe`. Changing domain/base settings requires a fresh deployment; existing artifacts embed the previous path.

## Release

1. Push the delivery branch and open a PR with validation evidence.
2. Wait for the exact commit's **Validate website** check to pass.
3. Review screenshots and approve/merge according to repository policy.
4. Watch **Deploy to GitHub Pages** on `main` through both build and deploy.
5. Check production home, community, resources, branding downloads, both locales, canonical URLs, and theme behavior.

A successful branch CI run is not a production deployment. Repository administrators may configure required checks and protected environments; this workflow does not silently change those settings.

## Rollback

Revert the problematic merge/commit on `main` through a reviewed change, then let the deployment workflow rebuild the prior source state. Do not force-push shared history. A failed validation never reaches the deployment job, leaving the previous deployed artifact in place.

## Troubleshooting

- Missing assets after a domain change: rerun the main deployment so Pages metadata is refreshed.
- Stale upcoming events: check the daily scheduled workflow and event dates/time zone.
- Development optimized-dependency 504 after package changes: stop and restart the local Astro server before debugging the feature itself.
- Tests fail reading `dist/`: use `npm test`, not `test:unit`, for a clean run.
- New dependency alerts: inspect `npm audit`, apply compatible fixes, and rerun the full gates; do not force major upgrades blindly.

Workflow design follows [GitHub's custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
