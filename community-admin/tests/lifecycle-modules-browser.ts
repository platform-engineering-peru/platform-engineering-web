/** Exact built console, synthetic lifecycle evidence, no real provider or main database effects. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import { entityDefinitions } from "../src/shared/product-contract";
const app = express(),
  server = createServer(app);
const user = {
  id: "synthetic-owner",
  name: "Synthetic owner",
  role: "owner",
  roles: ["owner"],
  capabilities: ["*"],
  csrfToken: "isolated",
};
let job: any,
  source: any,
  publications: any[] = [],
  uploads: any[] = [],
  cleanup = false;
const writes: any[] = [];
function reset() {
  job = {
    id: "job-one",
    version: 3,
    geography: {
      qualified: true,
      eligibility: "peru",
      reason: "explicit-peru",
    },
    payload: {
      id: "job-one",
      title: "SRE Peru synthetic",
      company: "Synthetic employer",
      status: "excluded",
      sourceClosed: false,
      approved: false,
      eligibility: "peru",
      workplace: "remote",
      locations: ["Lima Peru"],
      sourceUrl: "https://example.org/source",
      applyUrl: "https://example.org/job",
      summary: { "es-pe": "", en: "" },
      lastVerifiedAt: "2026-11-18T15:00:00Z",
    },
  };
  source = {
    id: "source-one",
    version: 4,
    retired: false,
    config: {
      id: "source-one",
      company: "Synthetic source",
      adapter: "greenhouse",
      boardIdentifier: "synthetic",
      careersUrl: "https://example.org/careers",
      enabled: true,
      schedule: { enabled: false },
    },
    runtime: {},
  };
  publications = ["queued", "unknown", "published"].map((state, i) => ({
    id: "pub-" + state,
    version: 5,
    revision_hash: "hash-" + state,
    state,
    channel: "youtube",
    destination: "synthetic-channel",
    payload: {
      title: "Synthetic " + state,
      description: "Synthetic description",
      media: [],
      desiredVisibility: "private",
      recordingConsent: false,
    },
    local_time: null,
    timezone: "America/Lima",
    dependency_id: null,
  }));
  uploads = [
    {
      id: "upload-one",
      version: "upload-token-1",
      state: "complete",
      sha256: "a".repeat(64),
      bytes: 123,
      mime: "video/mp4",
    },
  ];
  cleanup = false;
}
const action = (
  action: string,
  effect: string,
  allowed = true,
  reason: string | null = null,
) => ({
  action,
  effect,
  allowed,
  reason,
  blockers: [],
  requiresReason: true,
  requiresRecentAuth: false,
});
app.use(express.json());
app.use("/api", (req, res) => {
  if (req.method !== "GET") {
    writes.push({ path: req.path, body: req.body, token: req.get("If-Match") });
    assert.equal(req.get("X-CSRF-Token"), "isolated");
  }
  if (req.path === "/config")
    return res.json({
      fixtureAuthEnabled: false,
      localGhAuthEnabled: true,
      editorialMode: "local",
    });
  if (req.path === "/me") return res.json(user);
  if (req.path === "/catalog") return res.json({ entities: entityDefinitions });
  if (req.path === "/overview")
    return res.json({ counts: {}, reviewQueue: [], upcoming: [] });
  if (req.path === "/media") return res.json([]);
  if (req.path === "/jobs/status")
    return res.json({ collectionEnabled: true, processRunning: true });
  if (req.path === "/job-sources")
    return res.json({ items: [source], nextCursor: null });
  if (req.path === "/jobs/runs")
    return res.json({ items: [], nextCursor: null });
  if (req.path === "/jobs/publication/status")
    return res.json({ ready: false, reasons: ["UNCONFIGURED"] });
  if (req.path === "/jobs/candidates")
    return res.json({
      items: req.query.state === job.payload.status ? [job] : [],
      nextCursor: null,
    });
  if (req.path === "/publications")
    return res.json({ items: publications, nextCursor: null });
  if (req.path === "/editorial/status")
    return res.json({ mode: "local", configured: false });
  if (req.path === "/video/uploads") return res.json({ items: uploads });
  if (req.path === "/records") return res.json({ items: [], nextCursor: null });
  const parts = req.path.split("/");
  if (parts[1] === "lifecycle") {
    const module = parts[2],
      id = parts[3];
    let row: any, actions: any[];
    if (module === "jobs") {
      row = job;
      actions = [
        action("withdraw", "public-withdrawal"),
        action("reopen", "review-required"),
      ];
    } else if (module === "job-sources") {
      row = source;
      actions = [
        action(
          "retire",
          "source-retirement",
          !source.retired,
          source.retired ? "SOURCE_RETIRED" : null,
        ),
      ];
    } else if (module === "publications") {
      row = publications.find((p) => p.id === id);
      actions = [
        action(
          "cancel",
          "unsent-cancellation",
          row.state === "queued",
          "ALREADY_SENDING",
        ),
      ];
    } else if (module === "video-assets") {
      row = uploads.find((a) => a.id === id);
      actions = [action("remove", "owned-upload-removal")];
    } else return res.status(404).json({ message: "No synthetic capability" });
    return res.json({
      module,
      id,
      version: row.version,
      revisionHash: row.revision_hash,
      state:
        row.state ??
        row.payload?.status ??
        (row.retired ? "retired" : "active"),
      actions,
      remoteEffect: module === "jobs" ? "publication-required" : "none",
      retentionReason: null,
    });
  }
  if (req.method === "POST" && req.path === "/jobs/job-one/review") {
    assert.equal(req.body.version, job.version);
    assert.equal(req.body.decision, "withdraw");
    job = {
      ...job,
      version: job.version + 1,
      payload: {
        ...job.payload,
        status: "closed",
        closureReason: "curator-withdrawn",
      },
    };
    assert.equal(job.payload.sourceClosed, false);
    return res.json(job);
  }
  if (req.method === "POST" && req.path === "/job-sources/source-one/retire") {
    assert.equal(req.body.version, source.version);
    source = {
      ...source,
      version: source.version + 1,
      retired: true,
      config: { ...source.config, enabled: false },
    };
    return res.json(source);
  }
  if (parts[1] === "publications" && parts[2]) {
    const row = publications.find((p) => p.id === parts[2]);
    assert.ok(row);
    if (req.method === "GET") return res.json(row);
    assert.equal(parts[3], "cancel");
    assert.equal(row.state, "queued");
    assert.equal(req.body.version, row.version);
    assert.equal(req.body.revisionHash, row.revision_hash);
    row.state = "cancelled";
    row.version++;
    return res.json(row);
  }
  if (
    req.method === "DELETE" &&
    parts[1] === "video" &&
    parts[2] === "uploads"
  ) {
    const row = uploads.find((a) => a.id === parts[3]);
    assert.ok(row);
    assert.equal(req.get("If-Match"), `"${row.version}"`);
    if (!cleanup) {
      cleanup = true;
      row.state = "cleanup-pending";
      row.version = "upload-token-2";
      return res.json({ cleanupPending: true });
    }
    uploads = [];
    return res.json({ removed: true, cleanupPending: false });
  }
  return res
    .status(404)
    .json({ code: "UNEXPECTED_TEST_REQUEST", message: req.path });
});
const web = resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web");
app.use(express.static(web));
app.get("/{*path}", (_, res) =>
  res.sendFile("index.html", { root: web, dotfiles: "allow" }),
);
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const artifacts = resolve(
  process.env.ARTIFACTS_DIR ?? ".local/qa/deletion-actions/module-captures",
);
await mkdir(artifacts, { recursive: true });
async function go(section: string, theme: string) {
  await page.goto(`${origin}/?section=${section}`);
  await page.locator(".product-main").waitFor();
  if ((await page.locator("html").getAttribute("data-theme")) !== theme)
    await page
      .getByRole("button", { name: "Cambiar tema", exact: true })
      .click();
}
async function expand() {
  const details = page.locator(".lifecycle-actions").first();
  if (!(await details.evaluate((e) => (e as HTMLDetailsElement).open)))
    await details.locator("summary").click();
}
async function confirm(label: string, submit: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Motivo de la acción")
    .fill("Synthetic exact entity action");
  await dialog.getByRole("button", { name: submit, exact: true }).click();
}
try {
  for (const width of [1440, 390, 320])
    for (const theme of ["light", "dark"]) {
      reset();
      await page.setViewportSize({ width, height: 1000 });
      await go("job-exclusions", theme);
      await page
        .locator(".jobs-manager-list button")
        .filter({ hasText: "SRE Peru synthetic" })
        .click();
      await expand();
      const before = writes.length;
      await page
        .getByRole("button", { name: "Retirar del sitio…", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Volver sin cambios" })
        .click();
      assert.equal(writes.length, before);
      await confirm("Retirar del sitio…", "Preparar retirada");
      await page
        .getByText(/«SRE Peru synthetic»: Retirada preparada/)
        .waitFor();
      assert.equal(job.payload.sourceClosed, false);
      assert.equal(job.payload.status, "closed");
      await go("job-sources", theme);
      await page
        .locator(".jobs-manager-list button")
        .filter({ hasText: "Synthetic source" })
        .click();
      await expand();
      await confirm("Retirar fuente…", "Retirar fuente");
      await page.getByText(/Fuente retirada: no se habilitan/).waitFor();
      assert.equal(
        await page
          .getByRole("button", {
            name: "Revisar fuente y horario",
            exact: true,
          })
          .isDisabled(),
        true,
      );
      assert.equal(source.retired, true);
      await go("youtube", theme);
      await page
        .locator("#publication-list button")
        .filter({ hasText: "Synthetic unknown" })
        .click();
      await expand();
      assert.equal(
        await page
          .getByRole("button", {
            name: "Cancelar trabajo pendiente…",
            exact: true,
          })
          .count(),
        0,
      );
      await go("youtube", theme);
      await page
        .locator("#publication-list button")
        .filter({ hasText: "Synthetic published" })
        .click();
      assert.equal(
        await page
          .getByRole("button", {
            name: "Cancelar trabajo pendiente…",
            exact: true,
          })
          .count(),
        0,
      );
      await go("youtube", theme);
      await page
        .locator("#publication-list button")
        .filter({ hasText: "Synthetic queued" })
        .click();
      await expand();
      await confirm(
        "Cancelar trabajo pendiente…",
        "Cancelar trabajo pendiente",
      );
      await page.getByText(/Trabajo pendiente cancelado/).waitFor();
      assert.equal(publications[0].state, "cancelled");
      const uploadsPanel = page.getByText(
        "Cargas propias conservadas en almacenamiento privado",
        { exact: true },
      );
      await uploadsPanel.click();
      const uploadSection = page
        .locator("section")
        .filter({
          has: page.getByRole("heading", {
            name: "Video privado · upload-one",
            exact: true,
          }),
        })
        .last();
      await uploadSection.locator(".lifecycle-actions summary").click();
      await confirm("Eliminar archivo sin uso…", "Eliminar archivo sin uso");
      await page.getByText(/La limpieza sigue pendiente/).waitFor();
      assert.equal(uploads.length, 1);
      assert.equal(uploads[0].version, "upload-token-2");
      await page
        .getByRole("button", { name: "Eliminar archivo sin uso…", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByLabel("Motivo de la acción")
        .fill("Explicit retry new displayed token");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Eliminar archivo sin uso", exact: true })
        .click();
      await page
        .getByText(/Archivo privado retirado del almacenamiento/)
        .waitFor();
      assert.equal(uploads.length, 0);
      await page.screenshot({
        path: resolve(artifacts, `retained-history-${width}-${theme}.png`),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
    }
  assert.deepEqual(errors, []);
  console.log(
    "PASS excluded-job withdrawal preserves employer-open; source terminal retirement; known-unsent cancellation only; retained video cleanupPending explicit new-token retry; cancel0effects; six width/theme variants, no provider or real records",
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
