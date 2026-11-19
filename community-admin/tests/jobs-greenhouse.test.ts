import test from "node:test";
import assert from "node:assert/strict";
import {
  collectSource,
  normalizeJob,
  publicJobs,
  reconcileJobs,
} from "../src/server/jobs/engine";
import { strongVacancyDuplicates } from "../src/server/jobs/intake";
const source = {
  id: "coforge",
  adapter: "greenhouse" as const,
  boardIdentifier: "encora10",
  company: "Coforge",
  enabled: true,
  reviewedAt: "2026-11-18",
  reviewReference: "fixture",
  permissionBasis: "fixture",
  termsUrl: "https://developers.greenhouse.io/job-board.html",
  allowedHosts: ["boards-api.greenhouse.io"],
};
const now = new Date("2026-11-18T05:00:00Z");
const raw = (id = "5252570007", extra: any = {}) => ({
  id,
  title: "Senior Site Reliability Engineer",
  location: { name: "Peru" },
  absolute_url: `https://job-boards.greenhouse.io/encora10/jobs/${id}`,
  ...extra,
});
const normal = (extra: any = {}, id?: string) =>
  normalizeJob(raw(id, extra), source, now);
test("Greenhouse explicit modality and requisition survive normalization without geography inference", () => {
  const remote = normal({
    content: "&lt;p&gt;Work Mode: Remote&lt;/p&gt;",
    requisition_id: "21013-18-1",
  });
  assert.equal(remote.workplace, "remote");
  assert.equal(remote.requisitionId, "21013-18-1");
  assert.equal(remote.requisitionVerified, true);
  assert.equal(remote.eligibility, "peru");
  assert.match(remote.sourceExcerpt, /Work Mode: Remote/);
  assert.equal(
    normal({ content: "<p>Work Model: Hybrid</p>" }).workplace,
    "hybrid",
  );
  assert.equal(
    normal({ metadata: [{ name: "Workplace type", value: "On-site" }] })
      .workplace,
    "onsite",
  );
  assert.equal(
    normal({ metadata: [{ name: "Employment Type", value: "Full-time" }] })
      .workplace,
    "unknown",
  );
  assert.equal(
    normal({
      content:
        "Maintain remote systems and support hybrid cloud infrastructure.",
    }).workplace,
    "unknown",
  );
  assert.equal(
    normal({ content: "Location: Remote", location: { name: "LATAM" } })
      .eligibility,
    "remote-latam-confirmed",
  );
  const twin = normal({ requisition_id: "21013-18-1" }, "5266046007");
  assert.equal(strongVacancyDuplicates([remote, twin]).length, 1);
});
test("Greenhouse requests bounded full content, refresh invalidates old approval, failures preserve records", async () => {
  let calls = 0;
  const run = await collectSource(
    source,
    async (url, options) => {
      calls++;
      assert.equal(new URL(url).searchParams.get("content"), "true");
      assert.equal(options?.maxBytes, 4_000_000);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(
          JSON.stringify({
            jobs: [
              raw(undefined, {
                content: "<p>Work Mode: Remote</p>",
                requisition_id: "21013-18-1",
              }),
            ],
          }),
        ),
      };
    },
    now,
  );
  assert.equal(calls, 1);
  assert.equal(run.status, "complete");
  const old = {
    ...normal(),
    workplace: "onsite",
    approved: true,
    status: "active",
    summary: { "es-pe": "Revisado", en: "Reviewed" },
  };
  const refreshed = reconcileJobs([old], run, now).jobs[0];
  assert.equal(refreshed.id, old.id);
  assert.equal(refreshed.workplace, "remote");
  assert.equal(refreshed.approved, false);
  assert.equal(refreshed.status, "needs-review");
  const failed = await collectSource(
    source,
    async () => {
      throw Error("oversized provider response");
    },
    now,
  );
  assert.equal(failed.status, "failed");
  assert.equal(reconcileJobs([old], failed, now).jobs[0].status, "active");
  assert.equal(publicJobs([{ ...old, workplace: "unknown" }]).length, 1);
});
test("standalone engine retains Greenhouse evidence and lifecycle parity", async () => {
  const modulePath = "../../scripts/jobs/engine.mjs";
  const paired = await import(modulePath);
  for (const fields of [
    {},
    { content: "<p>Work Mode: Hybrid</p>", requisition_id: "21013-18-1" },
    { metadata: [{ name: "Workplace type", value: "Remote" }] },
  ])
    assert.deepEqual(
      paired.normalizeJob(raw(undefined, fields), source, now),
      normal(fields),
    );
});

test("saved Coforge provider fragments preserve Spanish hybrid and shared Peru requisitions", () => {
  // Minimal factual fragments from authorized secureRequest response SHA
  // 8e96ac050ef61d60899fab91bf4e655a53e76d4232cb99069956dab0d54221ed.
  const fixtures = [
    [
      "5284702007",
      "20801-10-3",
      "&lt;strong&gt;Modalidad:&lt;/strong&gt; Híbrida.",
      "hybrid",
    ],
    [
      "5287878007",
      "22551",
      "&lt;strong&gt;Work Mode:&lt;/strong&gt; Remote&lt;/p&gt;",
      "remote",
    ],
    [
      "5252570007",
      "21013-18-1",
      "&lt;strong&gt;Work Mode:&lt;/strong&gt; Remote&lt;/div&gt;",
      "remote",
    ],
    [
      "5266046007",
      "21013-18-1",
      "&lt;strong&gt;Work Mode:&lt;/strong&gt; Remote&lt;/div&gt;",
      "remote",
    ],
  ];
  const records = fixtures.map(([id, requisition_id, content, workplace]) => {
    const job = normal({ requisition_id, content }, id);
    assert.equal(job.workplace, workplace);
    assert.equal(job.requisitionId, requisition_id);
    assert.equal(job.eligibility, "peru");
    return job;
  });
  assert.deepEqual(strongVacancyDuplicates(records), [
    {
      ids: ["greenhouse:coforge:5252570007", "greenhouse:coforge:5266046007"],
      reason: "shared-requisition",
    },
  ]);
});

test("Spanish engineering titles and DevSecOps cover the five requested families without unrelated roles", async () => {
  const { classifyRole } = await import("../src/server/jobs/engine");
  const pairedModule = "../../scripts/jobs/engine.mjs";
  const paired = await import(pairedModule);
  for (const [title, role] of [
    ["Ingeniero de Infraestructura", "infrastructure"],
    ["Ingeniera de Plataformas", "platform"],
    ["Ingeniero de Confiabilidad de Sitios", "sre"],
    ["Ingeniero de Despliegue Avanzado", "fde"],
    ["Ingeniero DevOps", "devops"],
    ["DevSecOps Engineer", "devops"],
  ]) {
    assert.equal(classifyRole(title), role, title);
    assert.equal(paired.classifyRole(title), role, title);
  }
  for (const title of [
    "Ingeniero de infraestructura civil",
    "Ejecutivo de ventas de plataformas",
    "Soporte técnico DevOps",
    "DevSecOps Sales Engineer",
    "DevSecOps Account Executive",
    "DevSecOps Marketing Engineer",
    "Ingeniero de Infraestructura Sales",
    "Marketing de plataformas",
  ])
    assert.equal(classifyRole(title), null, title);
});
