# Community administration

A separate Spanish-first administration application for the Platform Engineering Perú website. React forms, a TypeScript API and PostgreSQL persist bilingual public content and private community operations. The website consumes versioned JSON through runtime-validated adapters; the existing visual design and identity assets remain authoritative.

This checkout runs only on loopback. Fixture accounts and local PostgreSQL are for synthetic demonstrations. No production service, remote repository, OAuth application, social account or publication has been created by this implementation. External integrations remain unconfigured until an authorized operator supplies their own provider configuration.

## Start locally

Use Node 22 and PostgreSQL 14 or newer. The verified environment uses Node 22.22.3, npm 10.9.8 and PostgreSQL 14.17. Run commands from this application's root.

```sh
npm ci
cp .env.example .env
# Start the existing isolated runtime only if it is stopped:
pg_ctl -D .local/postgres/data -l .local/postgres/server.log -w -t 15 start
pg_isready -h 127.0.0.1 -p 55432 -U community_admin_local -d community_admin_local
npm run migrate
npm run build
DEV_FIXTURE_AUTH=1 npm start
```

Open http://127.0.0.1:4455/. The server binds `127.0.0.1`; keep the exact origin when signing in. `DEV_FIXTURE_AUTH` defaults to disabled and is always disabled with `NODE_ENV=production`. The fixture banner and persona selector are explicitly development-only. The legacy single-memory fixture test interface is available at `/#fixture-memories`; the normal interface contains the full product.

The prepared runtime is ignored under `.local/postgres/`. Its database and role are `community_admin_local`, port 55432, timezone UTC, no Unix socket, and no superuser, database-creation or role-creation privilege. Local trust is restricted to that database/user on IPv4 loopback. Never expose this synthetic runtime or use its trust configuration for real private information. Stop only this runtime with `pg_ctl -D .local/postgres/data -w -t 15 -m fast stop`.

For a fresh installation, provision an isolated loopback PostgreSQL database and a schema-owning application role, set `DATABASE_URL`, then run the same migration command. The application refuses non-loopback database URLs. Migrations are transactional, advisory-locked and additive: 001 preserves the earlier fixture workflow, 002 adds the full content/CRM/auth model, and 003 adds integrations and the durable outbox. Tests create and drop only their own random schemas; normal application data is never reset.

## Automatic local GitHub CLI sign-in

For local review, `LOCAL_GH_AUTH=1` uses the already authenticated GitHub CLI account automatically. Put `LOCAL_GH_EXPECTED_SUBJECT` (the expected numeric GitHub user ID) only in an ignored local environment file. Use `gh api --hostname github.com user --jq .id` to inspect the public subject; the application never invokes `gh auth token`, reads CLI token files or copies a CLI token into its own database, browser, logs or publishing adapters.

```sh
# Supply LOCAL_GH_EXPECTED_SUBJECT through your ignored environment configuration.
LOCAL_GH_AUTH=1 DEV_FIXTURE_AUTH=0 INTEGRATIONS_LIVE_ENABLED=false npm start
```

This mode requires development, exact `http://127.0.0.1:<port>` origin/Host and loopback binding. It fails closed in production, with missing/mismatched subject, unavailable/unauthenticated CLI, invalid profile or inactive/revoked/foreign-community membership. The server calls only `gh api --hostname github.com user`, with an 8 second timeout and 64 KiB output limit. It validates a personal public GitHub profile and discards all fields outside the public identity allowlist. A new pinned identity can bootstrap the local application owner; an existing identity keeps its roles and cannot be silently promoted.

Initial navigation verifies the CLI identity through a same-origin POST with a one-use CSRF challenge. No fixture persona selector appears. Local sessions use a distinct HttpOnly/SameSite=Strict opaque cookie and namespaced token hash; disabling local mode makes those sessions unusable. GitHub identity is freshly checked on sign-in, explicit reverify, `/me` and mutations, with at most 5 seconds of caching for other reads. Membership is checked on every request. The browser rechecks periodically without refreshing the session's authentication time. The **Reverificar GitHub CLI** button performs a fresh check and rotates the session for recent-auth requirements. **Cerrar sesión** revokes the session and pauses automatic sign-in in that tab, including after reload; use the explicit verification button to enter again.

This is local review authentication, not production GitHub OAuth and not permission to publish. It does not install an OAuth App, change GitHub accounts/security settings or enable connectors. Keep real private data and external publishing out of this review environment. Standard invited OAuth and explicit synthetic fixture modes remain available when local CLI mode is off.

## Public and private workflows

The public catalog includes Memories with multiple images, resources, courses, organizers, public speakers, events, community settings and the existing brand inventory. Forms support Spanish and English, explicit ordering, immutable UUIDs and revision-aware saves. Autosave waits 800 ms after editing; stale revisions return a conflict without overwriting local text. Bilingual completeness and references are checked before submission. A different reviewer approves the exact revision hash. Editing invalidates approval; deterministic public exports include only the approved public allowlist.

Use the website import screen first in dry-run mode. Set `WEBSITE_CHECKOUT=..` for the recommended nested layout, where `community-admin/` lives inside the website checkout. A standalone app must set an explicit path to its trusted website checkout. The server reads this setting, reports stable IDs/source hashes and imports existing versioned JSON and verified media. It does not execute uploaded source code or accept an arbitrary checkout path from a browser. Repeating an unchanged import is harmless; changed website records with conflicting local revisions are reported for reconciliation. Existing organizer photographs and figurines remain bound to organizer identity.

Private modules persist people/contact points, organizations, speaker profiles, proposals, participations, sessions, follow-ups and consent/provenance. Session checks reject overlapping rooms and speakers using actual instants and IANA time zones. CSV import supports dry runs, column validation and deduplication; a failed validation creates no partial import. CSV export requires owner capability, recent sign-in, CSRF and a reason, is audited, and escapes spreadsheet formula prefixes.

A private speaker profile becomes a public draft only through an explicit consent-checked allowlist. Emails, internal notes, availability and compensation never enter the public projection. Consent withdrawal clears public approval and creates a reviewed removal requirement. The export boundary checks linked consent again. Archived public content requires reviewed removal; private deletion is owner-only, revision-bound, reasoned and recorded in tombstones. Private record payloads and revision history use AES-256-GCM with per-record keys outside PostgreSQL. Deleting a private record erases its key; the retained deletion ledger prevents a later restore from reviving it.

## Access and authentication

The API, rather than UI visibility, enforces capabilities on every operation. Roles compose: viewer, editor, reviewer, publisher, coordinator, jobs curator and owner. Fixture logins are available for each role only when explicitly enabled. Authors cannot review their own public content.

Real GitHub sign-in is implemented separately from fixtures. Configure `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OWNER_SUBJECT` and `PUBLIC_ORIGIN`; register the callback `${PUBLIC_ORIGIN}/api/auth/github/callback` in an authorized OAuth application. The owner subject is the numeric GitHub user ID, not an organizer name, email or repository username. Other numeric subjects need an owner-created invitation. State cookies, one-use expiring PKCE state and GitHub subject verification guard callbacks. No human `gh` token is read. Provider access tokens from sign-in are not retained as publishing credentials.

Cookies are HttpOnly and SameSite=Strict (the short-lived OAuth state cookie uses Lax); HTTPS origins add Secure. Sessions expire after eight hours or 30 minutes idle, and logout, role changes and revocation remove sessions. Membership changes and contact exports require sign-in within 15 minutes. Mutations require exact Origin and CSRF. Review/hash checks and capability checks repeat when queued work executes.

## Media and actual website preview

Authenticated image uploads require source and permission basis. The server verifies bytes, MIME, dimensions and optional SHA-256, enforces 20 MiB/40-megapixel limits, strips metadata and reencodes to bounded WebP. Derived public paths use content hashes and a generic image filename. Draft bytes remain private; anonymous upload/read is denied. Default quotas are 500 MB per user and 10 GB per community. New Memories support contain or explicit focal cropping, credits and verified dimensions. Approved original website media are imported without regenerating artwork.

Local immutable storage is under `.local/storage/`; configure `STORAGE_BACKEND=s3`, `S3_BUCKET`, `S3_REGION` and optionally `S3_ENDPOINT` for the private S3 boundary. Supply authorized workload credentials through the SDK's standard credential chain. The application does not create buckets or change ACLs. Video uploads use resumable 8 MiB parts, checksums, quarantine and scoped expiry; configured S3 uses signed multipart operations. Integration workers pass the invoking community to every asset lookup before reading local or S3 bytes.

Preview builds an isolated copy of the actual Astro website with the selected revision and media overlaid, under `.local/previews/`. Install the website's own Node 22 dependencies first. The build uses a repository-subpath base and sanitized environment, and records the source commit and revision hash. Editors/reviewers can generate and open authenticated previews; viewers cannot. Builds are capped at one per community and two globally, expire after 48 hours, and fail visibly when the actual renderer rejects content. This is not an approximate card preview and does not publish.

## Integrations and operations

GitHub App publication creates deterministic content-only changesets and PRs, checks drift and expected checks/approvals, and tracks merge and Pages deployment separately. Configure the application credentials and webhook listed in `.env.example`; keep `INTEGRATIONS_LIVE_ENABLED=false` until explicit external-action authorization. Missing configuration reports unconfigured, never success. The application uses provider APIs and installation credentials; maintenance work on GitHub must use `gh` rather than borrowing a person's token for the runtime.

LinkedIn and YouTube implement separate state-bound OAuth connections, encrypted connector secrets, destination locking, exact-revision approvals, scheduling, cancellation, retries, uncertain-delivery reconciliation and resumable video. Providers can reject scopes or require account/product approval; those external permissions have not been granted or tested here. The manual publication channel supports a reviewable fallback. Jobs supports source configuration, manual/curated input, deduplication, dry-run/sync history, freshness and review states; the website jobs workflow and feed remain separate from private CRM data.

The durable PostgreSQL outbox leases work, records attempts and idempotency, retries bounded failures, and rechecks authority, revision and destination. Operations screens show persisted status and audit history. A merged PR, an uploaded video and a successful website deployment are distinct states. Sensitive error details and connector secrets are not returned to browsers.

## API and source map

`/api/v1/` aliases `/api/`. `/api/openapi.json` describes the implemented routes and strict form schemas. `/api/catalog` supplies serializable form definitions; `/api/records` is the common typed collection API. Writes use CSRF, `Idempotency-Key` where required and `If-Match: "<revision>"` for revision changes. `/api/health/live` and `/api/health/ready` expose runtime readiness without private data.

- `src/shared/product-contract.ts`: form definitions, capabilities and client types.
- `src/server/product-schema.ts`, `contracts/`: input and public-output validation.
- `src/server/product-router.ts`, `auth.ts`, `uploads.ts`: content/CRM, access and media APIs.
- `src/server/export.ts`, `import-site.ts`, `preview.ts`: public projection, trusted import and real renderer.
- `src/server/integrations/`, `jobs/`: provider clients, worker, publishing and jobs.
- `src/web/`: responsive Spanish-first editor and operations screens.
- `migrations/`: additive PostgreSQL schema and immutable audit/history constraints.

Generate synchronized website schemas from the nested app with `WEBSITE_SCHEMA_DIR=../content/schemas npm run export:schemas`. The website's data adapters validate JSON at build time and preserve bilingual routes, existing ordering, artwork and rendering hooks. Runtime content never becomes executable TypeScript.

## Backup, restore and deletion

Keep `.local/record-keys/` and the deletion ledger outside public storage, with restricted permissions. Backups are encrypted with a separately supplied 32-byte base64 `BACKUP_ENCRYPTION_KEY`. Keep that key separately; losing it makes backups unreadable.

```sh
npm run recovery -- backup
npm run recovery -- restore .local/backups/backup-EXAMPLE.enc new_restore_schema
npm run recovery -- reapply-tombstones
```

Restore refuses an occupied schema. It restores records and per-record keys, replays retained deletion tombstones, excludes sessions/OAuth state, and returns queued external work to review rather than resuming side effects. Retain the current deletion ledger alongside every recovery procedure. The automated synthetic drill measures restore time in ignored `.local/qa/restore-drill.json`; it is evidence of a local recovery path, not a production RPO/RTO guarantee. Object-store retention, offsite encrypted backup scheduling, production incident ownership and sustained operational monitoring still need deployment-specific setup and approval.

## Verification and limits

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run verify:media
PLAYWRIGHT_CHANNEL=chrome npm run test:browser
PLAYWRIGHT_CHANNEL=chrome npm run test:product-browser
npm run format:check
npm audit
# Only with an already running opt-in local CLI review server:
PLAYWRIGHT_CHANNEL=chrome node --env-file=.local/review.env --import tsx tests/local-gh-browser.ts
```

Tests use real PostgreSQL transactions and HTTP sessions in isolated schemas, including conflicts, strict private/public boundaries, consent withdrawal, fail-closed access, OAuth callback behavior with mocked official endpoints, provider/outbox behavior, media validation, actual website preview and encrypted restore/tombstones. Browser checks use built assets in Chrome, desktop/mobile widths, both themes and reduced motion; captures stay ignored under `.local/qa/`. Provider mocks verify protocol behavior; they do not prove a real account has approved access.

The product is implemented for local review. Real OAuth registration, authorized invitations, production infrastructure, real CRM imports, private storage policy, real GitHub/App/social permissions, offsite recovery and the sustained pilot/operating acceptance remain external gates. Nothing in this checkout claims a live deployment or a completed production security review.

### Distributed Events editorial mode

The optional `EDITORIAL_MODE=github` mode treats validated JSON in the configured
`EDITORIAL_REPOSITORY` and `EDITORIAL_BRANCH` as the Events authority. The repository
must be selected explicitly in ignored local configuration; the example does not
activate a remote. `EDITORIAL_MODE=local` remains the default. The backend refuses
GitHub editorial mode outside a non-production loopback runtime. Legacy SQL Events mutation/export/preview/import and event-linked legacy changeset/
publication paths are refused in GitHub mode, including path case, encoded UUIDs, and
trailing-slash variants. The legacy live integration worker is incompatible with this
mode: startup rejects `INTEGRATIONS_LIVE_ENABLED=true`, so queued legacy event effects
cannot bypass the new authority. Other public
modules and private CRM keep their existing local behavior; they are not implicitly
synchronized. No legacy SQL records are automatically imported, exported, or deleted.

The first supported write collection is `content/events/{stable UUID}.json`.
A pull reads the complete Events collection and public Speaker reference collection
from one immutable commit. All records, identities, schemas, references, slugs, and
editorial orders must validate before replacing the cache. Truncated trees, missing
blobs, invalid JSON, permission failures, and network failures retain the last complete
cache, its successful fetch timestamp, and every local draft. The cache is marked stale;
failed reads never mean an empty collection. Existing legacy records in unrelated
collections are outside this first synchronization scope.

Each operator installs the app locally and authenticates their own GitHub CLI account.
Credentials remain in that operator's `gh` credential store. The adapter uses fixed
`gh api --hostname github.com` argument arrays and JSON on standard input; it never
invokes a shell or a token-printing command. Token environment overrides and CLI debug
output are excluded from child processes. The numeric GitHub identity must match the
local session, and the adapter checks it again before each remote mutation. Do not
switch CLI accounts during a submission. Browser requests cannot choose the repository,
branch, command, token, or arbitrary file path.

Local drafts live in separate `editorial_drafts` tables and keep their original base
commit and record hash. Saving a draft is an offline-capable local operation, not
publication or shared truth. Pulling approved changes never discards or rebases a dirty
draft. A changed canonical record produces an explicit three-way conflict containing
the base, current remote value, and preserved local payload. Resolve it deliberately
by creating a new draft against the freshly pulled baseline. There is no automatic
field merge or blind approved-branch overwrite.

New administrator website publication commits validated content directly to the pinned
`platform-engineering-peru/platform-engineering-web` `main` branch. It creates no PR.
Events drafts use `EDITORIAL_REMOTE_WRITES=1`; jobs and generic public changesets use
the independent `JOBS_WEBSITE_*` scope. Neither path enables legacy global-live or
social integrations. Existing account permissions and repository rules remain in force;
a policy rejection preserves the local intent and never changes repository security.

Generic requests must include `expectedRevisions` for exactly the selected record IDs;
jobs require `expectedVersions`. The server compares these displayed versions under
ordered row locks before binding the administrator's explicit publish action to that
validated revision. Public schema, source attribution, eligibility, duplicate, consent,
owned-media, and current-actor checks still apply. Events retain draft version guards.
Generic SQL Events are refused while GitHub draft authority is active.

The fixed GitHub GraphQL mutation uses `createCommitOnBranch` with `expectedHeadOid`.
One immutable batch is one commit, including required owned media. A durable attempt
journal records its parent and exact payload digest before mutation. Disjoint head
changes can retry at most three times after fresh target-hash and semantic validation;
same-record changes preserve the local draft as a conflict. No force update, deletion,
PR creation, merge, or automatic rollback is performed.

A timeout is not proof of failure. Reconciliation verifies reachable history, the exact
parent, authenticated author, complete changed-file set, and intended bytes. An unchanged
head is still potentially in flight: preserve the original uncertain intent and allow
only an explicit replay of its identical expected-head mutation. Do not refresh the base,
edit the submitted intent, or create a new key to evade an uncertain result. Incomplete
history remains uncertain. Historical PR submissions remain identifiable as legacy PRs;
their state is never reinterpreted as a direct commit.

A verified commit is persisted before deployment polling. `committed` is not `deployed`;
failed deployment leaves the commit and local history intact. A later deployed descendant
is accepted only after ancestry and intended-content checks; changed content is superseded.
Generic and Events publication additionally require the reviewed, byte-pinned descriptor
at `content/publication-compatibility.json`, matched against the shipped contract and
its public schemas/adapters at the immutable target head. The shipped descriptor pins
the reviewed canonical bootstrap and blocks publication until those exact public readers
and schemas are present on the configured branch. Never clear imported source hashes to bypass a missing or conflicting baseline.

Submission history remains discoverable after later edits or a local discard. A changed
draft creates a different submission and does not inherit an old approval. Overlapping
batches cannot overwrite an existing pending claim. A per-submission PostgreSQL session
lock serializes send/reconcile operations across remote I/O; a stale reconciler cannot
clear a new lease, and lease expiry cannot supersede a still-running sender. After a
process crash, the database session lock is released, but a persisted sending lease
may require waiting up to ten minutes before explicit reconciliation. This delay is
intentional; it is not evidence that the proposal failed or permission to resend it
under a different identity.
Closed PRs remain closed; the app does not reopen them automatically. A merged state
requires a verified GitHub merge plus matching event content at the merge commit.
Other installs see that content only when they successfully pull the approved branch.

Migration `004_editorial_sync.sql` creates local cache/draft/proposal/request tables.
Migration `007_direct_publication.sql` adds the durable direct-attempt journal and an
explicit publication-mode column without changing existing PR history.
The existing encrypted recovery snapshot discovers these tables and their dependencies;
no credential-store data or shared GitHub App key is added to backups. Back up the
local database before an explicitly authorized runtime migration. Restoring a backup preserves local bases and submission history, clears active editorial
leases, and marks nonterminal submissions unknown/reconciliation-required without
calling a provider: do not treat restored proposal state as
current until reconciled, and do not discard local work merely because a pull is stale.
Repository/branch changes select a separate cache and draft scope. A restore or migration
must never execute a remote proposal or merge.

Backend validation without GitHub network access:

```sh
node --env-file=.env --import tsx --test tests/editorial-sync.test.ts tests/editorial-stores.test.ts tests/editorial-github.test.ts
```

The integration harness creates three disposable PostgreSQL schemas and a fake GitHub
transport, then drops only those schemas. It covers approved pulls, independent local
drafts, conflicting/disjoint edits, atomic multi-record invariants, offline retention,
partial/invalid remote reads, ambiguous-send recovery, idempotency, local role/CSRF gates,
and identity changes. It neither uses the main database schema nor performs real remote
writes. Main runtime migrations, remote activation, real PR creation, merges and deployment
remain separate explicitly authorized operations.

## Social confirmation and blog drafts

The publishing manager can copy an approved revision and open LinkedIn through an explicit user gesture. Copying, opening a composer or downloading a manual package never marks a social post as published. After posting, an operator supplies the actual permalink, original publication time with an offset, original language, and reviewed title/excerpt/plain-text body in both supported languages. The confirmation explicitly attests to the operator's observation; it performs no remote verification or scraping.

Confirmation requires current publishing and content permissions, the captured approved publication version/hash, and an idempotency key. It creates one local `blog` draft atomically with private confirmation provenance. Canonical source uniqueness prevents duplicate local indexing; direct-publication snapshot validation also rejects the same source under different blog IDs from separate installations. Generic record creation cannot forge confirmation, and generic editing cannot replace confirmed source facts. Edited bilingual copy uses the normal revision, review and website publication flow; withdrawing a blog entry does not remove its social post. A confirmation receipt describes its original local result, not current website visibility.

Migration 009 adds durable linkage/request journals and uniqueness constraints. Startup/readiness require its version, physical columns and integrity constraints. Use the normal migration runner only during an authorized runtime delivery. This change does not activate social providers or install/restart the application.

The public calendar reuses canonical Events. Optional community attribution identifies own or invited communities; guests require a name and public community URL. Existing records retain absent attribution fields and legacy organizer labels. Dates remain timed same-day events in their original IANA zone; the website groups instants in Lima and keeps missing end times unknown. Blog/calendar publication remains blocked until the target contains the reviewed schemas, readers and exact compatibility descriptor.
