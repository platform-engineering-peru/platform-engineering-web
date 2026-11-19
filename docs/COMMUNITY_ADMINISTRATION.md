# Platform Engineering Perú — Community Administration

Consolidated product plan and technical specification · 8 November 2026

Status: proposed, not implemented. This document consolidates the complete planning package.

## Contents

1. [Overview and proposed decisions](#part-1-overview-and-proposed-decisions)
2. [Product and technical specification](#part-2-product-and-technical-specification)
3. [Data and API contracts](#part-3-data-and-api-contracts)
4. [Delivery roadmap and backlog](#part-4-delivery-roadmap-and-backlog)

## Part 1: Overview and proposed decisions

Planning package · 8 November 2026 · Status: proposed, not implemented.

This describes a separate application for operating Platform Engineering Perú while keeping the existing Astro website static and GitHub-managed. These files do not provision infrastructure, create a new repository, enable scraping, or publish social content.

1. [Product and technical specification](#part-2-product-and-technical-specification): scope, architecture, workflows, security boundaries, operating rules and acceptance criteria.
2. [Implementation roadmap](#part-4-delivery-roadmap-and-backlog): milestones, dependency order, delivery gates and initial backlog.
3. [Contracts and examples](#part-3-data-and-api-contracts): public content, private data, API interfaces and job ingestion rules.

The existing website repository is `platform-engineering-peru/platform-engineering-web`. Proposed new application repository: `platform-engineering-peru/community-admin` (name not reserved or created).

### Decisions proposed

- A separate authenticated application with a server backend, private PostgreSQL database, private object storage and a durable worker.
- GitHub remains the source of truth for published website content. Drafts and private operations live outside the public repository.
- Website changes become reviewed pull requests. A successful merge is not reported as a successful deployment until Pages confirms the deployed commit.
- Public job ingestion uses reviewed GitHub Actions, source attribution and reproducible validation. Contact records and OAuth credentials never enter these public workflows.
- Social publishing uses official APIs when approved access exists, with an explicit manual-export fallback.
- Public transparency describes content and collection activity; it does not expose private community records.

### Working assumptions requiring confirmation before implementation

- One community and one managed website repository in the first release.
- GitHub identity for administrators, explicit invitations and local roles; GitHub membership alone is not sufficient authorization.
- Spanish-first administration; Spanish and English website content.
- “Sessionals” is interpreted as sessions, talk proposals and speaker scheduling. A Sessionize integration is optional and not assumed to exist.
- Initial job audience: Peru and remote roles explicitly open to candidates in Peru. Broader LATAM coverage is configurable later.
- Human approval for new job listings and external posts; automatic closure updates may be enabled for trusted sources after a monitored pilot.
- No final hosting provider or budget has been selected. Container hosting with managed PostgreSQL and S3-compatible storage is the baseline deployment shape.

### Definition of planning completeness

Every requested capability has an owner module, data boundary, workflow, failure behavior, phase and acceptance test. External provider approvals are documented as dependencies, not presented as delivered capabilities. Repository migration preserves current designs and behavior.

## Part 2: Product and technical specification

Version 0.1 · Proposed · 8 November 2026

### 1. Purpose and product outcome

Build a separate administration application that allows authorized community organizers to maintain the public website, curate learning resources and jobs, coordinate speakers and sessions, and prepare/publish communications without manually editing application source files.

The public Astro website remains independently deployable and readable when the admin application is unavailable. The admin application must not become a runtime dependency of GitHub Pages. Published content changes must remain understandable and reversible through Git history.

Primary outcomes:

- Add a memory with photos, bilingual captions, event association and accessible descriptions.
- Add or update resources and courses; manage visibility and editorial ordering.
- Update an organizer without mixing the person's name, photograph or illustrated avatar.
- Operate a job board with source attribution, freshness tracking and transparent scheduled collection.
- Prepare LinkedIn page posts and YouTube video publications, track approvals and outcomes.
- Maintain a private directory of speakers, contacts, organizations, talk proposals, sessions and follow-ups.
- See what is drafted, approved, merged, deployed, scheduled, failed or awaiting intervention.

No requirement in this specification authorizes immediate external publication. The current deliverable is a plan; the application will implement explicit publishing controls.

### 2. Existing implementation and migration constraints

The inspected repository uses Astro, TypeScript, local data modules, bilingual `es-pe`/`en` routes, Three.js experiences and GitHub Pages. Existing content locations:

| Capability | Current source | Required adaptation |
| --- | --- | --- |
| Memories | `src/modules/memories/Memories.astro`, `public/memories/` | Extract embedded titles, alt text and descriptions into records; retain ribbon and modal renderers |
| Resources/courses | `src/data/resources.ts` | Introduce stable IDs, structured records, dedicated course fields and explicit cover-art keys |
| Organizers | `src/data/organizers.ts` | Stable IDs, explicit ordering, separate photo/figurine fields |
| Speakers | `src/data/speakers.ts` | Public speaker projection separated from private contact directory |
| Events | `src/data/events.ts` | Replace speaker-name references with IDs through compatibility adapters |
| Jobs | `src/data/opportunities.ts` | Replace demonstration vacancies with verified records and real application links |
| Site configuration | `src/data/site.ts`, locale modules | Curated, typed editable fields only; no arbitrary code or CSS editing |
| Branding | `public/brand/` | Asset inventory and approval metadata; preserve original logo and official derivatives |
| Deployment | `.github/workflows/deploy.yml` | Keep main-branch Pages deployment and daily refresh; extend with content validation |

Current deployment includes a scheduled build at 05:10 UTC (00:10 Lima). This rebuild alone does not collect jobs. A distinct job-ingestion workflow is required.

Migration rules:

1. Do not let the admin write executable TypeScript supplied by users.
2. Move editable content to versioned JSON with JSON Schema; preserve typed adapters so current components need minimal changes.
3. Use one JSON file per entity to reduce Git conflicts. Use explicit ordering fields, not array position as identity.
4. Move memories first as the smallest vertical slice, then organizers, resources/courses, events/speakers, jobs.
5. Compare rendered output before/after each extraction. Preserve route slugs, translations, layout, animation hooks, asset paths and structured-data behavior.
6. Keep original media and the approved logo. Asset replacement is a versioned operation with preview and rollback.
7. Capture the current reference commit at implementation kickoff; this plan does not assume the open PR has already merged.

### 3. Scope and release boundaries

#### First usable release

Authentication, roles, content listing and editing, media upload, bilingual validation, changeset previews, GitHub PR creation/status, memories, organizers, resources/courses, private contact/speaker records, audit trail, source configuration and job collection pilot.

#### Subsequent releases

Sessions and event coordination, editorial calendar, LinkedIn API publishing, YouTube resumable uploads, publication reconciliation, richer reporting and optional permitted source adapters.

#### Explicitly excluded initially

A public social network, member passwords on the static site, course hosting/LMS, candidate applications/CV storage, payment processing, private-message automation, automated invitations, unrestricted scraping, a general-purpose website builder, mass contact harvesting, an AI system that publishes without review, and guaranteed publication at an exact second through GitHub Actions.

Adding a course initially means a curated link with learning metadata, not hosting lessons or tracking student progress.

### 4. Users, permissions and approval policy

Permission checks occur in backend services on every operation. UI hiding is supplementary. Roles are composable scopes; the first release may expose these predefined bundles:

| Role | Capabilities | Restrictions |
| --- | --- | --- |
| Viewer | Read public content inventory and redacted operational status | No CRM access by default, no writes |
| Editor | Create/revise drafts, upload media, submit changesets | Cannot merge, publish externally or connect providers |
| Content reviewer | Approve/reject content revisions, request changes | Cannot approve an older revision after content changes |
| Publisher | Merge approved website changes and approve/schedule external posts | Must satisfy branch rules and approval policy |
| Community coordinator | Read/edit permitted private contacts, speakers, sessions and follow-ups | Cannot export all contacts without export permission |
| Jobs curator | Review sources, candidates, closures and exclusions | Cannot add executable scraping code through the UI |
| Owner | Manage invitations, roles, integrations and policy | Destructive actions and exports are audited |

An owner may hold multiple roles. Default policy requires a reviewer other than the draft author for external posts and sensitive public profile changes. A documented single-maintainer mode may be enabled by an owner; self-approval then remains explicit and audited, never silently granted.

GitHub authorization and admin authorization are separate. An app installation allows server operations on a repository; it does not make every GitHub user an admin. Account linking uses provider subject IDs, never email alone. Deactivated users lose sessions and pending publishing authority immediately.

### 5. Information architecture and interaction design

Use the existing brand palette, typography and restrained visual language. The administration interface prioritizes legibility and operational clarity over decorative motion. Ukuku can support empty states and onboarding without obscuring controls.

Navigation:

- Overview: review queue, deployments, upcoming events, stale sources, scheduled posts, outstanding tasks.
- Website: Memories, Resources, Courses, Organizers, Events, Public speakers, Brand assets, selected Site settings.
- Jobs: Candidates, Published, Expiring/unknown, Sources, Collection runs, Exclusions.
- Community: Contacts, Organizations, Speakers, Talk proposals, Sessions, Follow-ups.
- Publishing: Calendar, Drafts, Approvals, LinkedIn, YouTube, Publication history.
- Operations: Changesets, Pull requests, Deployments, Audit, Integrations, Members and roles.

Standard content editor:

1. Header identifies entity, draft revision and last saved time.
2. Tabs separate content, media, metadata, translations and history.
3. Spanish/English completion indicators identify missing required fields.
4. Autosave writes private drafts after 800 ms idle; it does not create Git commits.
5. Save status distinguishes saving, saved, offline, conflict and validation failure.
6. Preview displays the public rendering; a structured change summary shows additions, edits and removals.
7. Submit for review freezes a revision hash. Further edits create a new revision and invalidate previous approval.
8. Publication timeline shows PR opened, checks pending, approved, merged and deployed as separate steps.

Lists support search, filters, archived records, sortable columns and cursor pagination. Bulk changes show affected counts and require a preview. Destructive deletion defaults to archive; permanent deletion is restricted to a separate owner workflow. All fields have keyboard-accessible labels and inline validation. Mobile supports reviewing and basic editing; full video management may favor desktop but must remain operable.

### 6. Content workflows

#### 6.1 Memories

Fields: stable ID, slug, localized title/description, media IDs, alt text per locale, optional event ID, optional known capture date/year, tags, sort order and publication state. Never infer the actual event date from a WhatsApp filename. A year-only record stores year precision, not a fabricated day.

Upload one or more photos, inspect dimensions, strip location metadata from public derivatives, choose ordering, add alt text and preview portrait/landscape layouts. The default public rendering uses contain-fit; cropping is an explicit editorial choice stored as focal-point metadata. Public photos must never rely on the admin storage URL or expiring links.

Each media item's rights record records uploader, source, permission basis and any takedown restriction privately. The public projection contains credit only when intended for publication. Removing a person/photo from the public site creates a removal PR; separately address retained originals, caches and repository history according to the incident policy.

#### 6.2 Resources and courses

Shared fields: title, description, topic, content language, external URL, type, cover art key, provider, tags, status, ordering and last link check. Preserve supplied external URLs rather than inventing them. Validate HTTP/HTTPS and detect duplicate canonical URLs.

Courses additionally support level, prerequisites, duration minutes (nullable), delivery format, price model (`free`, `paid`, `unknown`), optional currency/amount, provider and certificate information. Unknown price is not treated as free. Translated descriptions describe the linked course accurately; content language remains separate from interface language.

Cover illustration assignment is explicit by stable key and independent of filtered array position. Editors select from approved illustrations; they cannot inject SVG scripts.

#### 6.3 Organizers and public speakers

Maintain public profile fields separately from private contact details. Organizer `displayOrder` defaults to the current ordering with Josua first. Updating a name must not change the identity mapping to photo/figurine. Require all referenced media to exist and preview both navbar-independent profile and organizer carousel views.

A private speaker can have a separately approved public projection. Never serialize the entire private contact object into the website. Public affiliation/role changes require confirmation from a responsible curator; private relationship notes are not public biography material.

#### 6.4 Events and sessions

Events store start/end instants with `America/Lima` or an explicit IANA zone, venue, modality, registration link and public status. Sessions reference event IDs and speaker IDs. Existing date/time fields are supported through adapters during migration.

Talk proposals track title, abstract, language, topic, duration, audience level, format, equipment needs, review state and availability. Confirmed sessions add room, schedule and recording permissions. Detect overlapping assignments for the same speaker/room. Generate a proposed agenda; never assume a speaker is confirmed from a contact record alone.

### 7. Architecture and sources of truth

```mermaid
flowchart LR
  U[Authorized organizer] --> A[Admin web application]
  A --> API[Backend API]
  API --> DB[(Private PostgreSQL)]
  API --> OBJ[(Private media staging)]
  API --> Q[Durable work queue]
  Q --> W[Worker]
  W --> GH[GitHub App]
  GH --> PR[Public website pull request]
  PR --> CI[Validation and preview]
  CI --> MAIN[Reviewed merge]
  MAIN --> PAGES[Astro build and GitHub Pages]
  W --> SOCIAL[LinkedIn and YouTube APIs]
  ATS[Approved job sources] --> ACT[Public scheduled Actions]
  ACT --> PR
  GH --> HOOK[Signed webhook receiver]
  HOOK --> DB
```

Recommended implementation shape, subject to a short technical spike:

- TypeScript monorepo for the new application, with React web client, a TypeScript HTTP API, shared schema package and Node worker.
- PostgreSQL as transactional store for users, drafts, CRM, approvals, runs and an outbox-backed queue. Start with a PostgreSQL-backed worker queue to avoid an unnecessary Redis dependency.
- S3-compatible private object storage for media staging and video uploads. Public website images are exported as immutable assets into the website repository for the MVP.
- Containers for API/worker and static web-client hosting behind the same origin. Managed PostgreSQL recommended; provider choice remains open until budget, region and operational ownership are agreed.
- OpenAPI 3.1 contracts; JSON Schema for exported public content. Runtime validation at every trust boundary.
- Dependency versions selected and locked at implementation kickoff after compatibility testing, not inferred from the existing website's dependency versions.

Data authority:

| Data | Authority | Replicas |
| --- | --- | --- |
| Published website content | Website repository main commit | Admin read model and deployed website |
| Unpublished drafts/reviews | Private database | Preview artifacts, with access controls |
| Contacts/private sessions/notes | Private database | Encrypted backups only |
| Media before publication | Private object store | Temporary worker files |
| Public media after merge | Versioned website assets | Pages/CDN caches |
| Social publication identity/status | Provider response, reconciled locally | Private publication log |
| Job extraction evidence | Approved source response and run metadata | Redacted normalized snapshot in public Git |

Read models are rebuilt from Git when drift occurs. Editing source files manually remains supported: webhooks import changes and invalidate conflicting drafts. Do not implement dual authoritative writes between Git and PostgreSQL for published content.

### 8. GitHub integration and publication consistency

Install a GitHub App on the website repository only. Proposed repository permissions: contents read/write for approved data/assets paths, pull requests read/write, checks/actions/deployments read for status; actions write only if a deliberately supported dispatch endpoint requires it. GitHub permissions are repository-wide, so application-level allowlists are mandatory. No workflow-file or repository-administration write capability is needed for normal content editing.

Use short-lived installation tokens server-side. Store the signing key in a secret manager; never send it or installation tokens to the browser. GitHub documents installation authentication and repository-scoped access in its [installation authentication guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).

Changeset algorithm:

1. Read current main SHA and relevant file/blob SHAs.
2. Validate the approved draft revision against the current schema and media inventory.
3. Build a deterministic file set containing public fields only. Enforce path allowlists, file-count and byte limits.
4. Create one Git tree/commit with all entity changes and assets atomically; never create a partially updated organizer across separate commits.
5. Create branch `content/<changeset-id>` and PR with a public-safe summary, entity IDs and migration/schema version.
6. Record branch, head SHA, PR number and approval hash in the private database.
7. Receive signed webhooks; deduplicate by delivery ID and reconcile with GitHub API.
8. Allow merge only after required checks and applicable review rules. A reviewer cannot bypass repository protection through the admin UI.
9. On merge record `mergedSha`; on successful Pages deployment of that SHA record `deployedSha`. Display links to both PR and deployment.

Conflict policy: compare base entity version with current main. Independent files may be rebased after validation. Changes to the same entity produce a three-way diff and explicit resolution. Deleted records referenced by an event/session cause validation errors, not silent removal. If the PR is manually closed, the draft remains recoverable. If GitHub is unavailable, drafts save normally and publication is queued with visible failure state.

Changeset idempotency is keyed by community ID, changeset ID and approved revision hash. Retries find the existing branch/PR; they do not open duplicates. Merge or deployment failures never roll back unrelated Git commits. Rollback creates a revert PR targeting the affected content version.

Preview design: build the target website commit with the proposed content in a restricted ephemeral environment. Private drafts must not appear in public GitHub artifacts before submission to a public PR. The initial release may offer authenticated local rendering plus screenshots; full branch previews require hosting with authenticated access. Public PR content is public from submission, even before merge: warn clearly at that boundary.

### 9. Public job board and collection pipeline

#### 9.1 Source strategy

Prefer documented employer ATS APIs and feeds over HTML extraction. Initial adapter candidates are Greenhouse and Lever, configured for approved employer boards. Their documentation provides public job-listing interfaces; availability of an endpoint is not blanket permission for redistribution. Record source terms/attribution and reviewer approval before enabling each source. See [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html) and [Lever postings API](https://github.com/lever/postings-api).

Do not scrape LinkedIn jobs, authenticated sessions, CAPTCHA-protected pages or personal profiles in the initial release. HTML adapters require a source-specific review, robots policy check, conservative rate limits and fixtures. Do not bypass blocks or use rotating identities to evade controls. The app manages source configuration; adapter code changes require ordinary code review.

#### 9.2 Relevance and eligibility

Include Platform Engineer, SRE, Developer Experience, platform product and relevant cloud infrastructure/DevOps roles. Use deterministic weighted rules based on title, description and explicit location eligibility. Configurable initial threshold: title match 3 points, relevant duties 2, each confirmed platform skill 1 (cap 3); review candidates at 4+. Threshold is a pilot configuration, not a quality guarantee.

Exclude unrelated sales/recruitment roles and obvious scams. A remote label alone does not prove Peru eligibility. Location states: `peru`, `remote-peru`, `remote-latam-confirmed`, `restricted`, `unknown`. Unknown eligibility requires curator review. Store original language and source title; translations are derived editorial summaries, labeled accordingly. Do not infer salary, seniority or sponsorship where absent.

#### 9.3 Schedule and transparency

Proposed schedule: `17 12,21 * * *` UTC, corresponding to 07:17 and 16:17 Lima. Run on the default branch plus restricted manual dispatch. Public workflow source, normalized public snapshots, source registry, PR diffs and redacted run summaries provide transparency.

Scheduled Actions can be delayed and are not a precise scheduler. Display actual `lastSuccessfulFetchAt`, not the intended cron time. GitHub documents scheduling behavior and default-branch constraints in [workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

Public summary includes run ID/URL, schema/rules version, adapter versions, source IDs, started/finished times, counts of fetched/new/changed/closed/quarantined records and sanitized failure codes. Do not publish tokens, HTTP authorization headers, personal emails, entire HTML pages or private recruiter notes. Public normalized job data includes minimal factual fields, source link and collection timestamps; full third-party text is not copied by default.

#### 9.4 Processing steps

1. Load reviewed registry and last-known-good snapshot from main.
2. Fetch each source with timeout, bounded pagination and rate limit; validate host and redirects against allowlist.
3. Parse to a typed normalized record, sanitize text and remove tracking parameters from links while preserving functional parameters.
4. Deduplicate by `(sourceId, externalId)`; use canonical URL as secondary identity. Cross-source matching uses normalized employer/title/location as a suggestion, not automatic destructive merging.
5. Classify relevance and location eligibility; quarantine malformed or suspicious entries.
6. Compare with previous snapshot only for sources whose complete pagination succeeded.
7. Apply freshness/closure rules and preserve manual exclusions and curator overrides.
8. Produce a deterministic candidate snapshot and run summary. Sort stable IDs; ignore fetch-only timestamps when deciding whether a content PR is needed.
9. Open or update a single `content/jobs-sync` PR. Any changed content invalidates prior approvals. Update the latest source evidence without overwriting manual curated fields.
10. CI validates schemas, links, policy thresholds and renders the public job board. Approved merge triggers normal Pages deployment.

Default mode: new jobs and material changes need a Jobs curator review. After a monitored pilot, trusted sources may auto-merge narrowly scoped closure/freshness changes if required checks pass and repository policy allows. Do not auto-merge workflow changes, new domains, salary edits or mass removals.

#### 9.5 Status model and failure semantics

Job states: `candidate`, `active`, `needs-review`, `stale`, `closed`, `excluded`. Publication approval is separate from observed source status.

- `active`: source explicitly lists the job on a complete successful fetch and eligibility has been approved.
- `closed`: source explicitly marks closed, known expiry passes, or job is absent from two complete successful source snapshots at least 12 hours apart.
- `stale`: no successful verification for 72 hours; exclude from the default active view and show last verification in an optional stale view.
- Source timeout, 403, 429, parse error, interrupted pagination or abnormal empty response never closes every job.
- A source returning zero after previously returning jobs, or a proposed removal of more than 30% of its active jobs, requires quarantine and human review even if HTTP is 200.
- Source recovery resets freshness; a previously closed job that reappears becomes a review candidate unless the source identity confirms reopening.
- Manual exclusions use stable source IDs and survive future collection. Curator fields and extracted fields have distinct ownership.

Public UI states “Listed by source; checked at …”, not “guaranteed available.” Applications go to the original employer URL; no applicant data is collected. If all sources fail, retain last-known-good content with freshness warnings. A static-site outage or delayed deployment must remain visible through a collection-health timestamp; optional client-side freshness labels can be computed from the published timestamp without needing the admin backend.

#### 9.6 Workflow security and reproducibility

Use two jobs. Fetch/parse job has read-only contents permission and no publication secret. It uploads only a schema-valid normalized artifact plus checksums and provenance. A separate publish job on a trusted default-branch workflow validates the artifact again and receives scoped GitHub App credentials. Never execute downloaded HTML/scripts. Avoid `pull_request_target` for running untrusted code. Actions are pinned to SHAs; manual inputs are enumerated source IDs, not commands/URLs.

Use concurrency `jobs-sync`, `cancel-in-progress: false`, and one PR branch to prevent racing writes. Bound each source to 2 concurrent requests, 15-second request timeout, 3 transient retries with jitter, 100 pages and 2,000 records initially; a cap hit marks the source incomplete. Workflow timeout: 20 minutes. Configure limits per source only after review.

Use a GitHub App token to create/update the content PR so subsequent CI is triggered as intended; do not assume events produced with the built-in `GITHUB_TOKEN` will trigger other workflows. Validate this in an end-to-end repository fixture before rollout. Keep private CRM and social credentials out of this workflow entirely.

### 10. Private community directory

Entities: Person, Organization, ContactPoint, SpeakerProfile, Topic, Interaction, Task, TalkProposal, Session, EventParticipation and ConsentRecord.

Person holds preferred name, optional pronouns, location/time zone, languages, organization affiliation and private notes. ContactPoint supports email, phone and professional profile URL with visibility, provenance and last verification. SpeakerProfile includes topics, formats, public bio candidate, travel/remote preferences, availability notes and experience links. Sensitive preferences are optional and permission-restricted.

Interaction records channel, date, author, summary and follow-up due date. It does not send a message. Outreach execution is out of scope until separately configured and authorized. CSV import provides dry-run mapping, duplicate suggestions and row-level errors; CSV export requires permission, is audited and neutralizes spreadsheet formula injection.

Directory lifecycle: prospect → contacted → interested → proposed → confirmed → participated → follow-up, with optional declined/inactive. Do not equate pipeline status with consent to publish. The same person may hold different states for different events; store status on participation/proposal relations, not only on Person.

Public speaker export includes only approved name, bio, photo, selected links and affiliation. Emails, phones, internal notes, availability, compensation, relationship scores and invitation history never enter Git. Default exports omit contact points. A deletion request triggers review of database records, object storage, backups and any already public projection.

Proposed retention policy for owner review: recheck inactive prospects after 12 months; delete unneeded private notes after 24 months; revoke integration tokens immediately on disconnect; retain public Git history as publication history. Backup expiration and restoration procedures must reapply deletion tombstones to prevent deleted contacts reappearing. This is a product retention proposal, not a legal compliance determination.

### 11. LinkedIn publishing

Target the Platform Engineering Perú organization page first. Personal-account publishing is a separate capability, off by default. Connect through OAuth using the official provider flow, verify the selected organization and the actor's publishing authority, and expose the granted scopes and account identity.

Use LinkedIn Posts API for supported text, article/link and image posts; video publishing can be a later extension. Store the API version in configuration and monitor its retirement. Provider documentation confirms post types and permission requirements; access must be approved/configured for the actual app. See [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api) and [Community Management overview](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview).

Composer fields: organization, campaign/event reference, language, text, link, media, alt text where supported, publication time and reviewer. Preview is an approximation; do not imply exact native layout. Validate provider-supported limits against the selected API version rather than freezing undocumented limits in the design.

Publication states: draft → review → approved → scheduled → sending → published / failed / unknown. Approval binds content hash, media IDs, channel and destination. Editing any of these revokes approval. At send time verify account permission, token validity, schedule and that the referenced website content is actually deployed if the campaign depends on it.

Persist provider post ID and URL. On timeout after submission, reconcile before retrying; provider operations may not support idempotency. An ambiguous result becomes `unknown` and needs a read-back or manual resolution, not automatic duplicate posting. Retry rate limits/transient failures with bounded backoff. Invalid authorization becomes `needs-reconnection`.

If app access is denied or unavailable, allow a downloadable publishing package with copy, images and links. A user can publish manually and record the resulting URL. Label this mode clearly; it is not API automation. Do not automate a logged-in browser as an API substitute.

### 12. YouTube publishing

“Publish to YouTube” means upload/manage videos, titles, descriptions, thumbnails, playlist associations and visibility where the connected account and API permit. Community-tab text/image posts are not promised; do not treat them as video uploads.

Use user OAuth for the actual channel owner/manager. Never assume a general service account can upload to an ordinary community channel. Request the narrowest scopes needed by enabled operations and store refreshed credentials only in the backend secret store.

Upload flow:

1. Create private video draft with title, localized editorial description, language, channel, session reference, recording consent and desired visibility.
2. Upload directly from browser to private storage using short-lived multipart URLs; do not route multi-GB uploads through the API process.
3. Validate checksum, file signature, media metadata and storage quota. Default application limit: 5 GB per file, configurable after infrastructure testing; this is not the provider's maximum.
4. Worker starts resumable upload, persists resumable-session state privately and resumes interrupted transfers.
5. Upload as private initially. Persist returned video ID before updating any additional metadata.
6. Poll processing with backoff, surface processing failure, and apply thumbnail/playlist/captions only when supported and approved.
7. Publish or schedule only the approved revision. Record actual provider visibility, publication time and canonical URL; then optionally create a website recording-link PR.

YouTube's current upload documentation describes upload behavior and quotas. These requirements have changed over time, so project audit/verification, quota and visibility eligibility must be checked against the actual Google Cloud project before launch. Do not hard-code a historical quota cost or assume public upload entitlement. See [videos.insert](https://developers.google.com/youtube/data/reference/rest/v3/videos/insert).

If uploading is not available, support linking an existing video and exporting prepared metadata for YouTube Studio. The UI must distinguish queued upload, uploaded/private, processing, scheduled and public. Public completion requires a provider-confirmed video, not only a successful request to the worker.

### 13. Scheduling, background work and reliability

GitHub Actions handles public job collection and website deployment. A private durable worker handles social schedules, GitHub changeset creation, media validation and reconciliation. Do not place CRM exports, refresh tokens or social publication payloads in public Actions logs/artifacts.

Use transactional outbox: the API transaction saves the approved operation and outbox event; workers claim events with leases and heartbeat, then write attempt outcomes. Uniqueness constraints enforce one local publication intent per `(channel, destination, contentRevision, scheduledSlot)`. Exactly-once external delivery cannot be guaranteed; reconciliation handles ambiguous outcomes.

All stored instants are UTC; UI defaults to America/Lima and shows explicit zone on scheduling. Store the requested local time and IANA zone alongside the resolved instant for audit. A missed schedule beyond 30 minutes moves to review unless an owner-configured grace policy allows late publication. Cancellation works while queued; after provider submission it becomes a separate removal/unpublish request with outcome tracking.

Concurrency: one send per provider account initially; video upload concurrency one per channel. Retry transport/5xx failures at most 3 times with exponential jitter; honor Retry-After. No retries for invalid content or revoked permissions without a change. Dead-letter items appear in Operations with a safe retry action.

### 14. Security and data protection

- Session cookies: HttpOnly, Secure, same-site policy appropriate to OAuth, bounded idle/absolute expiry and server-side revocation. CSRF protections for state-changing requests; OAuth state/PKCE as applicable.
- All authorization enforced server-side; test horizontal access and ownership boundaries even in single-community mode.
- Tokens encrypted at rest with keys outside the database. Logs redact tokens, emails, phones, upload URLs and raw provider responses containing private data.
- Webhooks verify signatures over raw request bytes, reject stale/replayed events and handle out-of-order deliveries.
- SSRF defense for links/media/source fetches: HTTPS allowlist, DNS/IP validation including redirects, block private/link-local/metadata networks, cap response size and time.
- Uploaded images are decoded and re-encoded; validate actual type, dimensions and decompression limits. Do not serve untrusted SVG/HTML from the admin origin. Scan staged files and quarantine failures.
- Public export uses an explicit DTO allowlist, never object spreading from CRM records. CI scans exports for forbidden keys and secret patterns.
- Content text is escaped; any Markdown uses a restricted renderer with raw HTML disabled. No arbitrary scripts, CSS or iframe embeds through the editor.
- Audit records actor, action, entity, before/after revision hashes, correlation ID, approval identity and outcome. Private values are redacted in general activity views.
- Owner actions for role changes, connector reassignment and contact export require recent authentication and an explicit summary.
- Backups are encrypted, access-limited and restore-tested. Production secrets never appear in preview environments.

Threats to test: malicious source HTML, image bombs, modified GitHub webhook payloads, external URLs to internal services, stolen refresh tokens, publication retries causing duplicates, editor escalating to publisher, CRM fields leaked into public PRs and stale approvals reused after edits.

### 15. Operations, performance and cost controls

Proposed initial scale envelope: 10 active operators, 10,000 public content records, 5,000 contacts, 50 job sources, 20,000 normalized job records and 100 GB staged media. These are engineering test targets, not observed usage. Configure quotas before enabling uploads.

Targets under that envelope: ordinary list/read p95 under 500 ms server time, draft-save p95 under 750 ms, search under 1 second, queued operation acknowledgement under 1 second. Long provider operations return 202 plus operation ID. Website performance must not regress from loading admin code or fetching admin APIs.

Operational signals: save failure rate, queue age, provider error/rate-limit counts, jobs last-success by source, PR check failures, merge-to-deploy latency, storage growth and backup age. Alert on failed scheduled collection twice consecutively, no successful collection for 24 hours, worker backlog over 15 minutes, repeated invalid OAuth, and failed deployment. Deduplicate alerts; display them in-app and use a separately configured operator destination.

Recovery targets proposed: private database RPO 24 hours and RTO 4 hours for the pilot; evaluate point-in-time recovery for production. Restore drills quarterly and before the first production launch. Git-based public content can be rebuilt independently. A revoked connector stops only that integration.

Cost model to measure during the spike: web/API compute + worker uptime + managed database + object storage + upload/download egress + backup retention + preview builds. No monetary quote is asserted without a provider/region and observed workload. Apply per-file, per-user and total-storage caps; expire abandoned uploads after 7 days and failed previews after 48 hours. Keep large videos out of Git.

### 16. Verification and acceptance

| ID | Scenario | Required result |
| --- | --- | --- |
| AC-01 | Invited editor signs in; uninvited GitHub user signs in | Editor gets assigned capabilities; uninvited user denied |
| AC-02 | Add memory with portrait and landscape photos | Both locales render complete images, alt text and approved order |
| AC-03 | Change organizer role/photo | Correct stable identity remains bound to name, figurine and links |
| AC-04 | Add course | Schema and URL valid; course appears in correct filter without code edits |
| AC-05 | Submit approved draft twice | Exactly one changeset branch/PR for the revision |
| AC-06 | Main changes same entity during edit | Conflict surfaced; no silent overwrite |
| AC-07 | PR merged but Pages fails | UI says deployment failed, not published |
| AC-08 | Collector receives 429/empty abnormal result | Previous jobs retained; source marked degraded; no bulk closure |
| AC-09 | Job absent from two complete runs ≥12h apart | Closure candidate with evidence and correct timestamps |
| AC-10 | New source response contains HTML script or private URL | Sanitized/rejected; no execution or internal-network request |
| AC-11 | Export speaker to public site | Only approved public fields leave private store |
| AC-12 | Edit approved LinkedIn post | Approval invalidated and scheduled send blocked |
| AC-13 | LinkedIn request times out after remote success | Unknown/reconciliation path; no blind duplicate |
| AC-14 | YouTube upload interrupted | Resumes or recovers state without claiming publication |
| AC-15 | Provider access unavailable | Manual export mode works and clearly identifies manual steps |
| AC-16 | Restore private backup | Drafts/CRM recover; deletion tombstones reapplied |
| AC-17 | Migrate existing website data | Stable routes, organizer mapping, branding and animations retained |
| AC-18 | Public jobs run inspected by visitor | Sources, times, counts and change PR traceable; secrets/private CRM absent |
| AC-19 | Keyboard/mobile/reduced-motion use | Editors, dialogs, previews and review actions remain usable |
| AC-20 | Cancel queued post or deactivate actor | Worker rechecks eligibility before send and blocks revoked intent |

TDD layers: pure schema/rule tests; repository and database integration tests; mocked provider contract tests; controlled live connector smoke tests; browser end-to-end workflows; visual regression on public rendering; security boundary tests; backup/restore rehearsal. Tests must cover failure paths, not only happy-path snapshots.

Release gate: all mandatory acceptance scenarios for the enabled phase pass; no known private-data export defects; role matrix verified; rollback rehearsed; actual provider connections tested; source permissions recorded; owner receives a runbook and known limitations. Optional integrations stay disabled until their own gates pass.

### 17. Open decisions and external dependencies

Before implementation: confirm app/repository name, operator roster, approval model, hosting region/budget, initial job employers, geographic scope and whether “sessionals” means sessions or a specific provider. Before social launch: confirm LinkedIn organization ID, YouTube channel, API access, project verification requirements and who approves posts. Before CRM import: confirm fields, provenance, retention owner and public-profile consent process.

These decisions do not block authoring the specification. They do block provisioning billable services, publishing posts, importing private directories or enabling unreviewed collection sources.

## Part 3: Data and API contracts

Proposed contracts, version 0.1. Examples are illustrative; they are not production records or executable migrations. Dates in examples are placeholders and must not be inferred as actual event dates.

### 1. Public content layout

```text
content/
  schema-version.json
  memories/<id>.json
  resources/<id>.json
  organizers/<id>.json
  speakers/<id>.json
  events/<id>.json
  jobs/<id>.json
  job-sources/<id>.json
  collection/latest.json
public/
  media/<sha256-prefix>/<safe-filename>.webp
```

IDs are immutable UUIDs generated by the admin; slugs are unique within entity type and locale routing rules. Legacy IDs are mapped explicitly during migration. `schemaVersion` starts at 1 and follows explicit migrations. Import adapters resolve media paths through the existing `asset()` helper, preserving subpath hosting. New content references contain relative asset paths, not local filesystem paths or storage credentials.

Every public entity has `id`, `schemaVersion`, `slug`, `status`, `updatedAt` and applicable localized fields. Public statuses are `published` and `archived`; private draft/review states never accidentally become website records. `updatedAt` changes only for editorial/meaningful source changes, not on every no-op collector run.

#### Memory

```json
{
  "schemaVersion": 1,
  "id": "a40901aa-b723-4b13-9c5d-20be0e5325c9",
  "slug": "kcd-2026",
  "status": "published",
  "title": {"es-pe": "KCD 2026", "en": "KCD 2026"},
  "description": {"es-pe": "Un recuerdo compartido de KCD 2026.", "en": "A shared memory of KCD 2026."},
  "eventId": null,
  "capturedAt": null,
  "captureYear": 2026,
  "datePrecision": "year",
  "media": [{
    "id": "media-kcd-group",
    "path": "media/sha256-prefix/kcd-group.webp",
    "width": 1200,
    "height": 1600,
    "alt": {"es-pe": "Participantes reunidos en el auditorio de KCD 2026.", "en": "Participants gathered in the KCD 2026 auditorium."},
    "fit": "contain",
    "credit": null
  }],
  "tags": ["kubernetes", "community"],
  "displayOrder": 10,
  "updatedAt": "2026-11-08T12:00:00Z"
}
```

Validation: 1–30 media items per memory; titles 1–120 characters; descriptions up to 4,000; alt text 1–500 per locale; positive dimensions; path exists; no duplicate media IDs. Public derivative max 2,560 pixels on longest edge by default without upscaling. Original staged image upload limit 20 MB, max 40 megapixels. Explicit exception requires owner policy, not hidden truncation.

#### Resource/course

Required: ID, localized title/description, HTTPS URL, `type`, `topic`, `contentLanguage`, `coverArtKey`, publication status and display order. Allowed types: guide, article, course, report, tool. Existing topics remain fundamentals, idp, golden-paths, devex, teams, ai, career. New taxonomy values require reviewed schema changes.

Optional course object:

```json
{
  "provider": "Provider name",
  "level": "introductory",
  "durationMinutes": null,
  "format": "self-paced",
  "price": {"model": "unknown", "amount": null, "currency": null},
  "prerequisites": {"es-pe": "Conocimientos básicos de contenedores.", "en": "Basic container knowledge."},
  "certificate": "unknown"
}
```

Amount is a decimal string, not floating-point money. Currency uses ISO currency code when supplied. Price and certificate fields are nullable/unknown until verified. `coverArtKey` is selected from the approved library. Link checking records observation status and date; network failure alone does not archive a resource.

#### Organizer/public speaker

Organizer fields: `id`, `slug`, `name`, `shortName`, localized `role`, localized `company`, `photoMediaId`, `figurineMediaId`, `displayOrder`, selected public links and status. Preserve current scalar role through an explicit migration into localized text. Speaker public projection: name, bio, role, company, topics, photograph and approved links. No private contact key is permitted by schema.

#### Public job

```json
{
  "schemaVersion": 1,
  "id": "greenhouse:example-board:external-123",
  "slug": "example-platform-engineer-external-123",
  "status": "active",
  "title": "Platform Engineer",
  "company": "Example employer",
  "sourceId": "example-board",
  "externalId": "external-123",
  "sourceUrl": "https://example.org/careers/external-123",
  "applyUrl": "https://example.org/careers/external-123",
  "contentLanguage": "en",
  "workplace": "remote",
  "eligibility": "unknown",
  "locations": [],
  "seniority": null,
  "salary": null,
  "summary": {"es-pe": "Resumen editorial pendiente.", "en": "Editorial summary pending."},
  "tags": ["platform-engineering"],
  "sourcePublishedAt": null,
  "firstSeenAt": "2026-11-08T12:17:00Z",
  "lastSeenAt": "2026-11-08T12:17:00Z",
  "lastVerifiedAt": "2026-11-08T12:17:00Z",
  "expiresAt": null,
  "closureReason": null,
  "evidenceRunId": "github-run-id"
}
```

This example is not eligible for automatic publication because eligibility is unknown. Public active export requires both an approved review and acceptable eligibility. The exporter enforces this independently of the job object's status. Salary, when present, includes source currency, min/max, unit, and source evidence; no conversion is implied. Unknown values remain null.

#### Source registry

Fields: `id`, `adapter`, `boardIdentifier`, `allowedHosts`, `enabled`, `termsUrl`, `robotsReviewedAt`, `permissionBasis`, `attribution`, `reviewedAt`, `reviewReference`, `requestLimit`, `pageLimit`, `timeoutSeconds`, `expectedMinRecords`, `autoMergeClosures` and `rulesVersion`.

The public registry uses a review reference, not private reviewer contact details. `adapter` is a code-reviewed enum. A new URL/domain cannot become an arbitrary fetch target through a free-text admin field. Source changes themselves use PR review.

### 2. Private relational model

All tables include immutable primary key and timestamps. Tenant/community ID is required on operational records to prevent accidental cross-community reads if multiple communities are added later; initial UI exposes one community only.

| Table | Key fields and constraints |
| --- | --- |
| users | Unique provider subject; display name; active flag |
| memberships | Unique community/user pair; roles; version; revokedAt |
| invitations | Email hash or provider identity, expiry, acceptedAt; one-time token hash |
| drafts | Entity type/ID, baseCommitSha, baseEntityHash, revision, publicPayload JSONB, authorId |
| draft_revisions | Immutable snapshot/hash; unique draft/revision |
| approvals | Revision hash, destination, reviewerId, decision, reason, approvedAt |
| changesets | Unique revision idempotency key; base/head/merge/deploy SHAs, branch, PR, state |
| assets | SHA256, storage key, MIME, dimensions/duration, status, rights record reference |
| persons | Preferred name, location, languages, archivedAt; no implicit public projection |
| contact_points | PersonId, type, encrypted value, provenance, visibility, verifiedAt |
| organizations | Name, website, relationships; duplicate review by normalized domain |
| affiliations | Person/org, role, validity interval |
| speaker_profiles | PersonId unique, topics, formats, language, private availability |
| consent_records | Subject, purpose, evidence reference, grantedAt, revokedAt |
| interactions | PersonId, authorId, time, channel, private summary |
| tasks | AssigneeId, person/session relation, dueAt, status |
| proposals | SpeakerId, abstract, language, duration, review status |
| sessions | EventId, proposalId, start/end, room, lifecycle |
| session_speakers | SessionId/personId pair, participation status |
| integration_accounts | Provider, external account ID, scope list, encrypted secret reference, health |
| publications | Channel, destination, revisionHash, schedule, state, provider ID/URL; unique intent key |
| publication_attempts | OperationId, attempt, sanitized status, retryAfter, started/finishedAt |
| outbox | Event ID, type, payload reference, lease/attempts/availableAt |
| webhook_deliveries | Provider/delivery ID unique, payload hash, processedAt |
| audit_events | Append-only actor/action/entity/revision references, redacted metadata |
| deletion_tombstones | Subject identifier hash, scope, effectiveAt; reapplied on restore |

Database transactions atomically create a publication/changeset intent and its outbox event. Audit rows cannot be updated by ordinary application roles. Keep large media and raw private provider responses out of JSONB.

### 3. State contracts

#### Website changeset

`draft → submitted → approved → pr_open → checks_passed → merge_pending → merged → deployed`

Alternative states: `changes_requested`, `conflict`, `checks_failed`, `closed`, `deploy_failed`, `cancelled`.

The logical chain can receive out-of-order webhooks: reconcile current provider state before advancing. `checks_passed` is bound to PR head SHA; a new commit resets it. `deployed` is bound to a successful Pages deployment commit. Approvals cannot be transferred to a changed revision.

#### Job ingestion result

```ts
interface SourceResult {
  sourceId: string;
  adapterVersion: string;
  startedAt: string;
  finishedAt: string;
  status: 'complete' | 'incomplete' | 'failed' | 'quarantined';
  pagesFetched: number;
  recordsFetched: number;
  records: NormalizedJob[];
  errorCode?: 'RATE_LIMIT' | 'TIMEOUT' | 'PARSE' | 'BLOCKED' | 'LIMIT' | 'ANOMALY';
}
```

Only `complete` is eligible for absence-based closure comparison. Even complete output passes anomaly gates before reconciliation. Candidate data never deletes a manually excluded job record or overrides editorial annotations.

#### Social intent

An approved revision includes destination account ID, channel, content hash, media hashes, schedule, dependency changeset ID and approval identity. Workers verify the revision and destination immediately before submission. If a dependency changeset is not deployed, keep `waiting_for_site` rather than sending a broken-link campaign.

### 4. HTTP API surface

Base path `/api/v1`. Authentication required except login callbacks, health endpoints and signed webhooks. Errors use a consistent problem envelope: `code`, `message`, `fieldErrors`, `correlationId`; no stack traces or secrets. Return 401 unauthenticated, 403 unauthorized, 404 inaccessible entity, 409 revision conflict, 422 validation failure, 429 rate limited and 503 temporarily unavailable.

| Method and route | Input | Success / authorization |
| --- | --- | --- |
| GET /me | Session | 200 identity, roles, capabilities |
| GET /content/:type | Cursor, limit ≤100, query, state | 200 public inventory; content read |
| POST /drafts | Entity type, optional entity ID, base SHA | 201 draft; editor |
| PATCH /drafts/:id | Payload with If-Match revision | 200 new revision; editor |
| POST /drafts/:id/validate | Revision | 200 structured validation result |
| POST /drafts/:id/preview | Revision | 202 restricted preview operation |
| POST /drafts/:id/submit | Revision hash | 200 frozen submission; editor |
| POST /approvals | Subject/revision, decision, reason | 201; reviewer capability |
| POST /changesets | Approved revision IDs, Idempotency-Key | 202 operation; publisher |
| GET /changesets/:id | ID | 200 PR/check/merge/deploy state |
| POST /changesets/:id/merge | Expected head SHA | 202; publisher, all gates |
| POST /changesets/:id/revert | Reason, expected current SHA | 202 revert PR; publisher |
| POST /assets/uploads | MIME, size, checksum, purpose | 201 short-lived upload descriptor |
| POST /assets/:id/complete | Multipart result/checksum | 202 validation operation |
| GET /people | Cursor/search; restricted fields | 200; coordinator |
| POST /people | Private person payload | 201; coordinator |
| PATCH /people/:id | If-Match version, changes | 200; coordinator |
| POST /people/imports | Staged CSV asset ID | 202 dry-run report; importer |
| POST /people/exports | Filter, fields, reason | 202 private download; export permission |
| POST /proposals | Speaker ID, proposal data | 201; coordinator |
| POST /sessions | Event/proposal/time/room | 201 or 409 schedule conflict |
| GET /jobs/candidates | Source/state filters | 200; curator |
| POST /jobs/:id/review | Decision/reason/version | 200; curator |
| POST /job-sources/:id/run | Reviewed source ID | 202 dispatch; curator |
| POST /publications | Channel, draft payload | 201; editor |
| POST /publications/:id/schedule | Approved hash, instant/zone | 202; publisher |
| POST /publications/:id/cancel | Reason | 200 cancelled or 409 already sending |
| POST /publications/:id/reconcile | Operation ID | 202; publisher |
| GET /operations/:id | ID | 200 progress/outcome |
| GET /audit | Cursor, scope, date range | 200 redacted events; scoped access |
| POST /webhooks/github | Signed raw body | 202 deduplicated processing |
| GET /health/live | None | 200 process health, no internals |
| GET /health/ready | None | 200/503 bounded dependency readiness |

Create/submit/schedule operations require `Idempotency-Key` retained for at least 7 days, with request hash. Reusing a key with a different payload returns 409. Draft `If-Match` is mandatory; missing preconditions return 428. Apply pagination to all collections; do not return the whole CRM through a convenience endpoint.

### 5. Export and import invariants

- Public JSON validates with `additionalProperties: false` at sensitive boundaries.
- IDs survive title and slug changes; URL redirects are explicit when public slugs change.
- A record cannot reference unknown media or a non-public speaker projection.
- Required bilingual fields must be reviewed before publish. Machine-generated translations remain drafts.
- No private storage hostname, presigned URL, email/phone field or secret is allowed in content export.
- Public assets use content-addressed names; replacing an image does not unexpectedly alter older PR previews.
- Migration is repeatable and has a dry-run report: counts, ID mappings, missing references and render differences.
- Existing manual edits in Git remain importable without overwriting unsubmitted private drafts.

### 6. Required test fixtures

1. Existing five Memories records, including portrait KCD photo and landscape photos.
2. Organizer change where name/order differ from image order; verify identity remains stable.
3. Resource/course records with missing translation, duplicate URL, unknown price and varied cover keys.
4. Complete ATS response, second-page timeout, 429, HTML instead of JSON, malformed salary, duplicate external ID, empty result and over-limit pagination.
5. Job closure across two successful snapshots, failed snapshot in between, explicit expiration and reopening.
6. Signed/invalid/replayed/out-of-order GitHub webhooks and changed PR head SHA.
7. OAuth token revoked, provider timeout after success, duplicate schedule request and cancelled publication.
8. Private person containing email/phone/notes; export must contain none of those fields.
9. Video multipart failure, resumable interruption and processing error.
10. Root and repository-subpath builds in both locales with no visual regression of current site features.

## Part 4: Delivery roadmap and backlog

Status: planning only. Durations are planning ranges for one experienced full-stack engineer with part-time design/review support, not commitments. Provider approvals, content review and infrastructure procurement can extend calendar time independently of engineering work.

### 1. Delivery sequence

| Phase | Indicative effort | Deliverable | Exit gate |
| --- | --- | --- | --- |
| 0 — Discovery and integration spikes | 3–5 engineer-days | Confirm identity/hosting/source assumptions; GitHub App sandbox; provider capability matrix | Decisions logged; no unproven social capability advertised |
| 1 — Public content contracts | 5–8 days | Schemas, stable IDs, adapters and migration of current content | Same rendered site, validated IDs/media/locales, reversible migration |
| 2 — Admin foundation and Memories slice | 8–12 days | Auth, roles, drafts, media, preview, PR flow, deployment status | Add memory through UI and see reviewed deployed result |
| 3 — Editorial modules and private directory | 8–12 days | Organizers, resources/courses, speakers, events, CRM basics | Public/private projection tests and complete content workflows |
| 4 — Transparent jobs pilot | 7–10 days | Source registry, two adapters, Actions, review and freshness UI | Seven-day monitored pilot; failure/closure rules proven |
| 5 — Community operations and social publishing | 10–15 days | Proposals/sessions, calendar, LinkedIn and YouTube adapters | Actual provider-account smoke tests or explicit manual fallback |
| 6 — Hardening and handover | 5–8 days | Security tests, restore drill, observability, operator runbooks | Release checklist signed off |

Total planning envelope: 46–70 engineer-days before external approval delays. Deliver incremental usable releases; do not wait for YouTube or LinkedIn access before shipping the website editor. Re-estimate after Phase 0 using measured upload behavior and migration complexity.

### 2. Dependency map

```mermaid
flowchart TD
  D[Decisions and GitHub App spike] --> S[Public schemas and migration]
  D --> A[Authentication and private storage]
  S --> M[Memories end-to-end]
  A --> M
  M --> E[Resources, courses and organizers]
  A --> C[Contacts and speakers]
  C --> T[Talk proposals and sessions]
  S --> J[Jobs adapters and public Actions]
  M --> P[Publication outbox and calendar]
  P --> L[LinkedIn integration]
  P --> Y[YouTube integration]
  E --> H[Hardening and launch]
  J --> H
  T --> H
  L --> H
  Y --> H
```

Social branches can ship as manual-export mode until external access is ready. Hardening gates apply to each enabled feature; disabled integrations do not prevent earlier release.

### 3. Backlog by epic

#### E0 — Decisions and proof of feasibility

- ADM-001: Record app name, repository owner, operators, approval policy, region and cost ceiling. Acceptance: decision log distinguishes confirmed values from defaults.
- ADM-002: GitHub App sandbox installation. Acceptance: scoped app opens one fixture PR, CI runs, webhook receives signed event, and no protected-main bypass is possible.
- ADM-003: LinkedIn capability spike. Acceptance: actual app approval/scopes and organization-role requirements recorded; publish test only to an explicitly approved destination.
- ADM-004: YouTube capability spike. Acceptance: OAuth/channel identity, upload quota and actual visibility restrictions recorded; private controlled upload tested when authorized.
- ADM-005: Select first approved ATS boards. Acceptance: source owner/domain, terms basis, region relevance and public attribution are recorded; no guessed active employers.

#### E1 — Schemas and migration

- ADM-010: Versioned JSON schemas and shared TypeScript types. Acceptance: invalid URLs, unknown references, private keys and missing locale fields fail with precise paths.
- ADM-011: Stable IDs and migration tool. Acceptance: dry run plus repeatable export; names are not used as foreign keys.
- ADM-012: Memories extraction. Acceptance: exact current five records and ordering preserved, gallery remains operational.
- ADM-013: Organizer/resources extraction. Acceptance: Josua/Oscar/Ronald mappings preserved; twelve cover illustrations remain keyed to resource identity.
- ADM-014: Speakers/events adapters. Acceptance: existing event pages and structured data remain equivalent.
- ADM-015: CI content validation. Acceptance: root and repository-subpath builds pass for both locales; secret/public DTO checks block unsafe fixtures.

#### E2 — Platform and access

- ADM-020: New repository scaffold and local environment. Acceptance: web/API/worker/PostgreSQL/object-store emulator run from documented commands without production credentials.
- ADM-021: GitHub login and invitations. Acceptance: uninvited account denied; revoked user cannot use an existing session.
- ADM-022: Role/capability enforcement. Acceptance: backend tests cover every role mutation boundary.
- ADM-023: Database migrations and audit. Acceptance: reversible non-destructive migration process, append-only audit access and redaction tests.
- ADM-024: Encrypted connector credential storage. Acceptance: raw secrets absent from DB dumps available to ordinary roles, logs, browser network responses and public artifacts.
- ADM-025: Outbox/worker leases. Acceptance: worker crash and replay do not create duplicate local operations.

#### E3 — Content editing and GitHub publishing

- ADM-030: Draft list/editor with revision preconditions. Acceptance: concurrent edit returns conflict without losing either version.
- ADM-031: Media uploads and validation. Acceptance: portrait/landscape, oversized image, spoofed MIME and failed checksum handled correctly.
- ADM-032: Authenticated preview and public-boundary warning. Acceptance: draft inaccessible anonymously; submission clearly indicates public PR visibility.
- ADM-033: Revision-bound approvals. Acceptance: edit invalidates approval and cannot be published with stale reviewer decision.
- ADM-034: Atomic Git commit and PR creation. Acceptance: retry returns same PR, allowed files only, public-safe summary.
- ADM-035: PR/check/deployment reconciliation. Acceptance: failed Pages deployment remains failed even after successful merge.
- ADM-036: Conflict resolution and revert PR. Acceptance: same-entity conflict demonstrated and previous public revision restored through review.
- ADM-037: Organizers/resources/course editors. Acceptance: editable fields map to schemas; no raw code editor needed.

#### E4 — Private community operations

- ADM-040: Contact and organization directory. Acceptance: search, archive, field-level permissions and audited exports.
- ADM-041: Speaker profile and public projection. Acceptance: private notes/contact fields never appear in generated Git files.
- ADM-042: Import preview and deduplication. Acceptance: dry-run counts, row errors, formula-safe CSV exports and no automatic destructive merges.
- ADM-043: Talk proposals and event participation. Acceptance: proposal state is per event, availability is not treated as confirmation.
- ADM-044: Sessions/agenda. Acceptance: room and speaker overlaps detected; time-zone handling tested.
- ADM-045: Follow-ups and deletion process. Acceptance: reminders remain internal; deletion tombstones survive restore.

#### E5 — Jobs ingestion

- ADM-050: Adapter interface and fixtures. Acceptance: complete/incomplete/failed/quarantined results distinguish source coverage.
- ADM-051: Greenhouse adapter. Acceptance: bounded pagination, valid links, source IDs and no authenticated scraping.
- ADM-052: Lever adapter. Acceptance: same contract with provider-specific normalization fixtures.
- ADM-053: Relevance/eligibility and dedup rules. Acceptance: unknown Peru eligibility held for review; cross-source matches remain reversible.
- ADM-054: Freshness/closure reconciler. Acceptance: failure cannot close jobs; two-run missing rule and anomaly threshold tested.
- ADM-055: Public GitHub Actions pipeline. Acceptance: read-only fetch job and scoped write job, redacted run summary, one sync PR and CI trigger verified.
- ADM-056: Job review UI and overrides. Acceptance: exclusions persist across runs; manual content not overwritten by scraper.
- ADM-057: Public job board adaptation. Acceptance: demo labels removed only when real approved data exists; source links, last checks and stale states shown.
- ADM-058: Seven-day pilot report. Acceptance: review relevance precision and closure false positives, monitor source failures, decide whether trusted closure auto-merge is appropriate.

#### E6 — Publishing and integrations

- ADM-060: Editorial calendar and reusable drafts. Acceptance: date/zone, event dependency and channel variants visible.
- ADM-061: Connector health/reconnection. Acceptance: revoked credentials block sending and alert operators without exposing tokens.
- ADM-062: LinkedIn text/link/image adapter. Acceptance: correct organization, permission check, stored post ID and safe ambiguous-response handling.
- ADM-063: Manual publication package. Acceptance: copy/media/links export and manual URL recording work without provider access.
- ADM-064: YouTube multipart staging and resumable upload. Acceptance: interrupted transfer resumes; private-by-default request and provider response stored.
- ADM-065: Video metadata/processing and recording-link PR. Acceptance: processing failure cannot appear as published; public video generates a reviewed website link update.
- ADM-066: Scheduling, cancellation and reconciliation. Acceptance: approval changes, missed slots, duplicate intents and revoked actors tested.

#### E7 — Release and operations

- ADM-070: Threat-model tests and dependency scanning. Acceptance: no unresolved critical data exposure or authorization defect.
- ADM-071: Accessibility and responsive browser QA. Acceptance: keyboard-only primary workflows, contrast, visible focus, error announcements and reduced motion.
- ADM-072: Metrics, alerts and runbooks. Acceptance: simulated source outage, queue backlog and failed deployment produce actionable alerts.
- ADM-073: Backup restore drill. Acceptance: stated RPO/RTO measured, deleted contacts remain deleted after replaying tombstones.
- ADM-074: Operator onboarding and production checklist. Acceptance: a community operator completes a memory PR and reviews jobs without developer intervention.

### 4. First vertical slice in exact order

1. Freeze a baseline screenshot/data inventory of current Memories.
2. Write schema and invalid-record tests; extract records without changing output.
3. Create invited-user login, private draft storage and a simple memory editor.
4. Implement safe media staging with actual dimensions and bilingual alt text.
5. Render authenticated preview using the site's existing memory renderer contract.
6. Add revision-bound approval and deterministic content export.
7. Open a PR through the GitHub App on a sandbox repository, then the real repository after app setup is approved.
8. Observe checks and merge/deployment webhooks; demonstrate failure and retry.
9. Complete a real approved memory update; compare the public rendering with the preview.
10. Document rollback and prove a revert PR restores the previous version.

Do not start with a dashboard full of disconnected buttons. The first release must complete a real content lifecycle before adding additional modules.

### 5. Definition of done for each implementation PR

- Acceptance criteria referenced by ID; test evidence attached.
- No unreviewed changes to the public website's existing presentation.
- Public/private boundaries reviewed; no secrets or local personal paths in executable configuration.
- Database and content migrations documented with rollback/recovery behavior.
- New endpoints have runtime input/output validation and authorization tests.
- UI states include loading, empty, validation error, permission denial, offline/dependency failure and retry behavior where relevant.
- Documentation in English; public content bilingual; Spanish admin labels reviewed.
- Browser verification for visual changes; unit tests alone do not establish visual correctness.
- Provider operations disabled behind feature flags until connection and approval gates pass.

### 6. Production launch checklist

- Repository and GitHub App installed with confirmed permissions.
- Protected main branch and required checks enforced.
- Admin domain, TLS, OAuth callback URLs and session policy configured.
- PostgreSQL backups and object-storage lifecycle configured and tested.
- Owners and operators invited; role escalation tested.
- Public-content export and CRM redaction tests passing.
- First job sources reviewed; pilot metrics accepted; no demo jobs presented as real.
- LinkedIn/YouTube features accurately reflect actual approved capabilities.
- Operator alert destination configured and tested.
- Rollback and restore rehearsed; emergency connector revoke procedure documented.
- Public site remains functional during simulated admin outage.

### 7. Planning handoff

Next action is Phase 0, followed by the Memories vertical slice. A separate implementation request should authorize creating the application repository and selecting infrastructure. No current website code, production workflow, GitHub App installation, source collection or social publication has been changed by this planning package.

