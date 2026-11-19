# Community administration application

Planning package · 8 November 2026 · Status: proposed, not implemented.

This describes a separate application for operating Platform Engineering Perú while keeping the existing Astro website static and GitHub-managed. These files do not provision infrastructure, create a new repository, enable scraping, or publish social content.

1. [Product and technical specification](SPECIFICATION.md): scope, architecture, workflows, security boundaries, operating rules and acceptance criteria.
2. [Implementation roadmap](ROADMAP.md): milestones, dependency order, delivery gates and initial backlog.
3. [Contracts and examples](CONTRACTS.md): public content, private data, API interfaces and job ingestion rules.

The existing website repository is `platform-engineering-peru/platform-engineering-web`. Proposed new application repository: `platform-engineering-peru/community-admin` (name not reserved or created).

## Decisions proposed

- A separate authenticated application with a server backend, private PostgreSQL database, private object storage and a durable worker.
- GitHub remains the source of truth for published website content. Drafts and private operations live outside the public repository.
- Website changes become reviewed pull requests. A successful merge is not reported as a successful deployment until Pages confirms the deployed commit.
- Public job ingestion uses reviewed GitHub Actions, source attribution and reproducible validation. Contact records and OAuth credentials never enter these public workflows.
- Social publishing uses official APIs when approved access exists, with an explicit manual-export fallback.
- Public transparency describes content and collection activity; it does not expose private community records.

## Working assumptions requiring confirmation before implementation

- One community and one managed website repository in the first release.
- GitHub identity for administrators, explicit invitations and local roles; GitHub membership alone is not sufficient authorization.
- Spanish-first administration; Spanish and English website content.
- “Sessionals” is interpreted as sessions, talk proposals and speaker scheduling. A Sessionize integration is optional and not assumed to exist.
- Initial job audience: Peru and remote roles explicitly open to candidates in Peru. Broader LATAM coverage is configurable later.
- Human approval for new job listings and external posts; automatic closure updates may be enabled for trusted sources after a monitored pilot.
- No final hosting provider or budget has been selected. Container hosting with managed PostgreSQL and S3-compatible storage is the baseline deployment shape.

## Definition of planning completeness

Every requested capability has an owner module, data boundary, workflow, failure behavior, phase and acceptance test. External provider approvals are documented as dependencies, not presented as delivered capabilities. Repository migration preserves current designs and behavior.
