import test from "node:test";
import assert from "node:assert/strict";
import {
  jobQueueStates,
  editableSourceConfig,
  validDestination,
  providerCanAuthorize,
} from "../src/web/jobs-ui";
test("review queue includes material changes and reopened jobs; lifecycle queues stay distinct", () => {
  assert.deepEqual(jobQueueStates("jobs-candidates"), [
    "candidate",
    "needs-review",
  ]);
  assert.deepEqual(jobQueueStates("jobs-closed"), ["closed"]);
});
test("source writes strip server-owned runtime but retain explicit opt-in/review", () => {
  const config = {
    id: "company",
    enabled: false,
    schedule: { enabled: false, intervalHours: 12 },
    _runtime: { actorId: "private", nextDueAt: "later" },
  };
  assert.deepEqual(editableSourceConfig(config), {
    id: "company",
    enabled: false,
    schedule: { enabled: false, intervalHours: 12 },
  });
  assert.ok("_runtime" in config);
});
test("social identity validation never accepts personal LinkedIn URLs and cannot bypass readiness", () => {
  assert.equal(
    validDestination("linkedin", "https://www.linkedin.com/in/person/"),
    false,
  );
  assert.equal(validDestination("linkedin", "urn:li:organization:123"), true);
  assert.equal(validDestination("youtube", "UC1234567890123456789012"), true);
  assert.equal(
    providerCanAuthorize(
      { ready: false },
      "linkedin",
      "urn:li:organization:123",
    ),
    false,
  );
  assert.equal(
    providerCanAuthorize(
      { ready: true },
      "linkedin",
      "urn:li:organization:123",
    ),
    true,
  );
});

test("opportunities describes employer vacancies without renaming queue routes or statuses", async () => {
  const { workspaces } = await import("../src/web/navigation");
  const { JobsWorkspace } = await import("../src/web/jobs-workspace");
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const workspace = workspaces.find((w) => w.id === "jobs")!;
  assert.equal(
    workspace.items.find((item) => item.id === "jobs-candidates")!.label,
    "Vacantes por revisar",
  );
  assert.doesNotMatch(
    workspace.description +
      workspace.items.map((item) => item.label + item.description).join(" "),
    /candidat|applicant|postulante/i,
  );
  const html = renderToStaticMarkup(
    React.createElement(JobsWorkspace, {
      section: "jobs-candidates",
      user: { capabilities: [], csrfToken: "isolated" } as any,
      onNavigate() {},
    }),
  );
  assert.match(html, /Vacantes por revisar/);
  assert.doesNotMatch(html, /Candidatos|Candidates|Applicants|Postulantes/);
  assert.deepEqual(jobQueueStates("jobs-candidates"), [
    "candidate",
    "needs-review",
  ]);
});

test("existing expiry values retain their Lima wall time when editing intake", async () => {
  const { limaDateTimeInput } = await import("../src/web/jobs-ui");
  assert.equal(limaDateTimeInput("2026-12-01T03:15:00Z"), "2026-11-30T22:15");
  assert.equal(limaDateTimeInput(null), "");
  assert.equal(limaDateTimeInput("invalid"), "");
});

test("source names distinguish full boards from supported individual vacancy links", async () => {
  const { jobSourceLabel } = await import("../src/web/jobs-ui");
  assert.equal(jobSourceLabel("lever"), "Lever");
  assert.equal(jobSourceLabel("smartrecruiters"), "SmartRecruiters · Perú");
  assert.equal(jobSourceLabel("hirehive"), "HireHive · vacante individual");
  assert.equal(jobSourceLabel("globant"), "Globant · vacante individual");
  assert.equal(jobSourceLabel("unrecognized"), "Fuente sin identificar");
});

test("website publication labels never equate a prepared change or open PR with deployment", async () => {
  const { jobPublicationLabel } = await import("../src/web/jobs-ui");
  assert.equal(
    jobPublicationLabel("prepared"),
    "Cambio preparado · sitio sin actualizar",
  );
  assert.equal(
    jobPublicationLabel("pr_open"),
    "PR abierta · pendiente de revisión",
  );
  assert.equal(
    jobPublicationLabel("merged"),
    "Integrado · despliegue pendiente",
  );
  assert.equal(jobPublicationLabel("deployed"), "Despliegue confirmado");
  assert.equal(
    jobPublicationLabel("complete"),
    "Consulta el resultado de la operación",
  );
});

test("publication baselines refresh concurrency without resetting the visible PR result", async () => {
  const { jobPublicationRevision } = await import("../src/web/jobs-ui");
  const p = {
    title: "Platform Engineer",
    approved: true,
    summary: { en: "One", "es-pe": "Uno" },
  };
  assert.equal(
    jobPublicationRevision(p),
    jobPublicationRevision({
      ...p,
      baseEntityHash: "new",
      publicationBaseline: { commit: "abc" },
    }),
  );
  assert.notEqual(
    jobPublicationRevision(p),
    jobPublicationRevision({ ...p, title: "Senior Platform Engineer" }),
  );
});

test("an unchanged expiry keeps the source seconds rather than rewriting metadata", async () => {
  const { intakeExpiryInstant } = await import("../src/web/jobs-ui");
  assert.equal(
    intakeExpiryInstant("2026-11-30T22:15", "2026-12-01T03:15:42.000Z"),
    "2026-12-01T03:15:42.000Z",
  );
  assert.equal(
    intakeExpiryInstant("2026-11-30T22:16", "2026-12-01T03:15:42.000Z"),
    "2026-12-01T03:16:00.000Z",
  );
  assert.equal(intakeExpiryInstant("", null), null);
});

test("real completed collection DTO projects success and nested board evidence", async () => {
  const { jobOperationMessage, jobRunScope } =
    await import("../src/web/jobs-ui");
  const run = {
    runId: "d2fc0788-8e79-4539-8983-34f717e761d4",
    status: "complete",
    recordsFetched: 296,
    relevantRecords: 21,
    newRecords: 21,
    changedRecords: 0,
    closedRecords: 0,
    errorCode: null,
    evidence: { scope: "board", complete: true },
  };
  assert.equal(
    jobOperationMessage("complete", "OK", run.status),
    "Lectura completada sin errores.",
  );
  assert.equal(jobRunScope(run), "Lectura completa de la bolsa");
  assert.doesNotMatch(
    jobOperationMessage("complete", "OK", run.status),
    /No se pudo/,
  );
  assert.match(
    jobRunScope({ ...run, evidence: { scope: "board", complete: false } }),
    /incompleta/,
  );
  assert.match(
    jobRunScope({
      ...run,
      evidence: { scope: "single-detail", complete: false },
    }),
    /Solo la vacante enlazada/,
  );
  assert.match(
    jobOperationMessage("complete", "OK", "incomplete"),
    /incompleta/,
  );
  assert.match(
    jobOperationMessage("complete", "OK", "quarantined"),
    /comprobar/,
  );
  assert.match(
    jobOperationMessage("failed", "TIMEOUT", undefined),
    /no respondió a tiempo/,
  );
  assert.match(
    jobOperationMessage("failed", "UNEXPECTED", undefined),
    /No se pudo completar/,
  );
  assert.doesNotMatch(
    jobOperationMessage("complete", "OK", undefined),
    /sin errores|No se pudo/,
  );
});

test("geography labels use server evidence and never infer eligibility from location or curator fields", async () => {
  const { jobGeographyLabel } = await import("../src/web/jobs-ui");
  assert.equal(
    jobGeographyLabel({
      qualified: true,
      eligibility: "peru",
      reason: "explicit-peru",
    }),
    "Perú · ubicación confirmada",
  );
  assert.equal(
    jobGeographyLabel({
      qualified: true,
      eligibility: "remote-latam-confirmed",
      reason: "explicit-remote-latam",
    }),
    "Remoto LATAM · confirmado",
  );
  assert.equal(
    jobGeographyLabel({
      qualified: false,
      eligibility: "peru",
      reason: "outside-region",
    }),
    "Fuera de región",
  );
  assert.equal(
    jobGeographyLabel({ qualified: false, reason: "restricted" }),
    "Restricción de ubicación",
  );
  assert.equal(
    jobGeographyLabel({ qualified: false, reason: "location-unconfirmed" }),
    "Ubicación sin confirmar",
  );
  assert.equal(
    jobGeographyLabel({ qualified: false, reason: "eligibility-unconfirmed" }),
    "Elegibilidad sin confirmar",
  );
  assert.equal(jobGeographyLabel(undefined), "Elegibilidad sin confirmar");
});
