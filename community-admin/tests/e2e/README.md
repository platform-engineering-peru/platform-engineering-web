# Isolated administration regression runner

Run with Node 22.22.3 and installed local dependencies:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The command does not load `.env`, start the normal administration service, or use `DATABASE_URL`. It builds the current client, exported API and startup entry into an ignored run directory. It starts PostgreSQL in a temporary cluster when `initdb`, `pg_ctl` and `createdb` are available. Each new journey receives a fresh migrated schema, loopback server on an operating-system-assigned port, browser context, and temporary keys/storage/video/deletion ledger. Port 4455 and external Node/browser requests are blocked. Provider behavior uses explicitly injected fixtures; the controlled-live local GitHub browser script is excluded.

CI may provide `E2E_DATABASE_URL` explicitly. It must name a dedicated `e2e` database on loopback, without connection-option query parameters. The runner never creates or drops this supplied database. It owns only generated schemas and fails if cleanup leaves unexpected resources. Do not point it at a production or shared administration database. `E2E_PG_BIN` selects a local PostgreSQL binary directory. The default browser is installed bundled Chromium; `E2E_BROWSER_CHANNEL=chrome` explicitly selects installed Chrome and fails if unavailable.

Run a single registered scenario while developing:

```sh
npm run test:e2e -- --filter=community-stale-permissions
```

A filtered pass proves only that selection. It reports `complete: false`; it cannot certify the entire administrator. Runs are serial and protected by an ownership lock. A stale lock after an ungraceful process termination must be investigated using its saved PID before removal. Normal interruption and subprocess deadlines trigger cleanup and a failing report.

`journeys.ts` is the explicit built-client/built-API/PostgreSQL registry. `supplemental.ts` reuses explicitly named existing browser suites and the fixed `api-files.json` test allowlist. These retain honest execution layers: source-API browser journeys, synthetic-API UI checks, pure/API/domain rules, and compiled startup checks are reported separately. No old browser filename glob is executed. The one optional historical Inetum corpus replay is explicitly reported as unverified when its ignored source evidence is unavailable; other unexpected skips fail.

`matrix.json`, maintained by QA, maps every requirement to all required scenarios. Every mapped scenario must pass. Unknown IDs, duplicate IDs, metadata disagreements and missing local proof fail the aggregate. Provider fixtures never prove live GitHub, Pages, social delivery, provider entitlement, current vacancy availability, or production operational objectives. `completeAllOriginal` and `originalRequirementsComplete` remain false while external proof or observed unimplemented product requirements remain. `complete` concerns the implemented local assertion scope only.

Each run writes `.local/qa/e2e/<run-id>/report.json` plus logs, screenshots, trace and cleanup evidence. `.local/qa/e2e/latest.json` is only a convenience pointer; cite a specific run report. Private fixture keys/uploads and PostgreSQL data stay in the temporary tree and are removed. Playwright traces contain disposable fixture session cookies and CSRF values: keep them local. CI uploads only the report and synthetic failure screenshots, never private temporary files, traces, environment files or build directories.

The runner changes no installed runtime, application configuration, existing user records, accounts, publication targets or real providers. Application defects found by a scenario require a separate focused regression and scoped correction; do not weaken the scenario, drop a required mapping or classify a failed local requirement as external to obtain a pass.
