/** Built main client; mocked authentication/records, actual approved checkout image bytes. No live DB or provider writes. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import { entityDefinitions } from "../src/shared/product-contract";
import { stableUuid } from "../src/server/import-site";
const site = resolve(process.env.WEBSITE_CHECKOUT ?? ".."),
  web = resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web");
const rows: any[] = [],
  assets = new Map<string, string>();
for (const type of ["speakers"]) {
  const definition = entityDefinitions.find((d) => d.type === type)!;
  for (const filename of (await readdir(resolve(site, "content", type))).filter(
    (f) => f.endsWith(".json"),
  )) {
    const record = JSON.parse(
      await readFile(resolve(site, "content", type, filename), "utf8"),
    );
    const payload = { ...structuredClone(definition.defaults), ...record };
    if (type === "organizers") {
      for (const key of ["photo", "figurine"]) {
        const id = stableUuid("asset:" + record[key]);
        assets.set(id, record[key]);
        payload[key + "AssetId"] = id;
      }
    }
    rows.push({
      id: record.id,
      type,
      payload,
      state: "approved",
      revision: 1,
      updatedAt: "2026-11-17T00:00:00Z",
    });
  }
}
rows.sort((a, b) => a.payload.displayOrder - b.payload.displayOrder);
let preparations = 0;
let phase = "prepared",
  configured = true,
  remoteEnabled = true;
const job = {
  id: "manual:original-detail:abcdef",
  version: 1,
  payload: {
    title: "DevOps Engineer",
    company: "Empresa de prueba",
    status: "active",
    approved: true,
    eligibility: "peru",
    locations: ["Lima, Perú"],
    summary: { "es-pe": "Resumen revisado", en: "Reviewed summary" },
    sourceUrl: "https://example.org/job",
    applyUrl: "https://example.org/job",
  },
};
const created: any[] = [];
const app = express(),
  server = createServer(app),
  mutations: string[] = [];
let authenticated = true,
  failReverify = false;
const user = {
  id: "isolated-review",
  name: "Revisión aislada",
  role: "owner",
  roles: ["owner"],
  capabilities: ["*"],
  csrfToken: "fixture-only",
  github: {
    subject: "123",
    login: "isolated",
    name: "Revisión aislada",
    source: "local-gh",
    profileUrl: "https://github.com/isolated",
    avatarUrl: "",
    verifiedAt: "2026-11-17T00:00:00Z",
  },
};
app.use(express.json());
app.use("/api", (req, res, next) => {
  if (req.method !== "GET") mutations.push(req.path);
  if (req.path === "/jobs/candidates")
    return res.json({
      items: req.query.state === "active" ? [job] : [],
      nextCursor: null,
    });
  if (req.path === "/jobs/publication/status")
    return res.json({
      ready: configured && remoteEnabled,
      reasons: remoteEnabled ? [] : ["JOBS_PUBLICATION_WRITES_DISABLED"],
      repository: configured
        ? "platform-engineering-peru/platform-engineering-web"
        : null,
      branch: "main",
      remoteWritesEnabled: remoteEnabled,
    });
  if (req.path === "/jobs/changeset") {
    preparations++;
    assert.equal(req.get("X-CSRF-Token"), "fixture-only");
    assert.deepEqual(req.body, {
      jobIds: [job.id],
      expectedVersions: { [job.id]: job.version },
    });
    return res.status(202).json({
      id: "publication-op",
      subject_id: "publication-cs",
      state: "queued",
      publication: { state: "prepared" },
    });
  }
  if (req.path === "/operations/publication-op")
    return res.json({
      id: "publication-op",
      subject_id: "publication-cs",
      state:
        phase === "unknown"
          ? "unknown"
          : phase === "prepared"
            ? "queued"
            : "complete",
      result:
        phase === "prepared"
          ? null
          : {
              publicationMode: "direct",
              state: phase,
              changesetId: "publication-cs",
              commitSha: "a".repeat(40),
              commitUrl:
                "https://github.com/example/site/commit/" + "a".repeat(40),
              deployment: {
                state:
                  phase === "deployed"
                    ? "deployed"
                    : phase === "deployment_failed"
                      ? "failed"
                      : "pending",
                sha: phase === "deployed" ? "a".repeat(40) : null,
              },
            },
    });
  if (req.path === "/changesets/publication-cs/retry") {
    assert.equal(req.get("X-CSRF-Token"), "fixture-only");
    phase = "prepared";
    return res.status(202).json({
      id: "publication-op",
      subject_id: "publication-cs",
      state: "queued",
    });
  }
  if (req.path === "/changesets/publication-cs/reconcile") {
    assert.equal(req.get("X-CSRF-Token"), "fixture-only");
    return res.json({
      publicationMode: "direct",
      state: phase,
      changesetId: "publication-cs",
      canRetryExact: phase === "unknown",
      commitSha: "a".repeat(40),
      commitUrl: "https://github.com/example/site/commit/" + "a".repeat(40),
      deployment: {
        state:
          phase === "deployed"
            ? "deployed"
            : phase === "deployment_failed"
              ? "failed"
              : "pending",
        sha: phase === "deployed" ? "a".repeat(40) : null,
      },
    });
  }
  if (req.path === "/config")
    return res.json({
      fixtureAuthEnabled: false,
      localGhAuthEnabled: true,
      localGhAuthRequested: true,
      editorialMode: "local",
    });
  if (req.path === "/me")
    return authenticated
      ? res.json(user)
      : res
          .status(401)
          .json({ code: "UNAUTHENTICATED", message: "Sesión vencida." });
  if (req.path === "/auth/local-gh/challenge")
    return res.json({ csrfToken: "challenge-only" });
  if (req.path === "/auth/local-gh") {
    authenticated = true;
    return res.json(user);
  }
  if (req.path === "/auth/local-gh/reverify")
    return failReverify
      ? res.status(503).json({
          code: "AUTH_UNAVAILABLE",
          message: "GitHub CLI no está disponible.",
        })
      : res.json(user);
  if (req.path === "/logout") {
    authenticated = false;
    return res.sendStatus(204);
  }
  if (req.path === "/jobs/status")
    return res.json({
      collectionEnabled: true,
      publishingEnabled: false,
      execution: "local-process",
      processRunning: true,
      sources: 0,
      queued: 0,
      running: 0,
    });
  if (
    req.path === "/job-sources" ||
    req.path === "/jobs/runs" ||
    req.path === "/jobs/candidates"
  )
    return res.json({ items: [], nextCursor: null });
  if (req.path === "/jobs/intake/preview")
    return res.json({
      support: "manual-required",
      reason: "UNSUPPORTED_CAREERS_PAGE",
      draft: {
        company: req.body.company,
        locations: [],
        eligibility: "unknown",
      },
      evidence: {
        checkedAt: new Date().toISOString(),
        active: "unknown",
        method: "manual-required",
      },
      previewHash: "actor-bound-server-token",
    });
  if (req.path === "/jobs/intake") {
    created.push(req.body);
    return res.json({
      created: true,
      item: { id: "local-test", payload: req.body },
      duplicateSuggestions: [],
    });
  }
  if (req.path === "/catalog") return res.json({ entities: entityDefinitions });
  if (req.path === "/media")
    return res.json(
      [...assets].map(([id, path]) => ({
        id,
        path,
        label: path,
        width: 100,
        height: 100,
      })),
    );
  if (req.path.startsWith("/media/")) {
    const path = assets.get(req.path.slice(7));
    return path
      ? res.sendFile(path, { root: resolve(site, "public") })
      : res.sendStatus(404);
  }
  if (/^\/brand-assets\/[^/]+\/preview$/.test(req.path)) {
    const record = rows.find(
      (r) => r.type === "brands" && r.id === req.path.split("/")[2],
    );
    const path = record?.payload.previewPath || record?.payload.path;
    return path
      ? res.sendFile(path, { root: resolve(site, "public") })
      : res.sendStatus(404);
  }
  if (/^\/speaker-assets\/[^/]+\/preview$/.test(req.path)) {
    const record = rows.find((r) => r.id === req.path.split("/")[2]);
    return record?.payload.photo?.startsWith("speakers/")
      ? res.sendFile(record.payload.photo, { root: resolve(site, "public") })
      : res.sendStatus(404);
  }
  if (req.path === "/records")
    return res.json({
      items: rows.filter((r) => r.type === req.query.type),
      nextCursor: null,
    });
  if (req.path.endsWith("/audit")) return res.json([]);
  if (req.path.startsWith("/records/"))
    return res.json(rows.find((r) => r.id === req.path.slice(9)));
  if (req.path === "/overview")
    return res.json({ counts: {}, reviewQueue: [], upcoming: [] });
  return next();
});
app.use(express.static(web));
app.get("/{*path}", (_req, res) =>
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
page.setDefaultTimeout(10000);
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const artifacts = resolve(
  process.env.ARTIFACTS_DIR ?? ".local/qa/sticky-speakers/publication-browser",
);
await mkdir(artifacts, { recursive: true });
try {
  for (const width of [1440, 390, 320])
    for (const dark of [false, true]) {
      phase = "prepared";
      configured = true;
      remoteEnabled = true;
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${origin}/?section=jobs-active`);
      await page
        .locator(".jobs-manager-list button")
        .filter({ hasText: "DevOps Engineer" })
        .click();
      if (
        ((await page.locator("html").getAttribute("data-theme")) === "dark") !==
        dark
      )
        await page
          .getByRole("button", { name: "Cambiar tema", exact: true })
          .click();
      const panel = page.getByRole("region", {
        name: "Publicación de la vacante en el sitio",
      });
      await panel
        .getByLabel("Confirmo los datos públicos de esta oportunidad")
        .check();
      await panel
        .getByRole("button", {
          name: "Publicar oportunidad",
          exact: true,
        })
        .click();
      await panel.getByText("Publicando en GitHub", { exact: true }).waitFor();
      phase = "unknown";
      await panel
        .getByText("Comprobando publicación · resultado por confirmar", {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await panel
          .getByRole("button", {
            name: "Publicar oportunidad",
            exact: true,
          })
          .count(),
        0,
      );
      assert.equal(
        await panel
          .getByRole("button", {
            name: "Reintentar el mismo envío",
            exact: true,
          })
          .count(),
        0,
      );
      await panel
        .getByRole("button", {
          name: "Comprobar publicación y despliegue",
          exact: true,
        })
        .click();
      const preparedBeforeRetry = preparations;
      await panel
        .getByRole("button", { name: "Reintentar el mismo envío", exact: true })
        .click();
      await panel.getByText("Publicando en GitHub", { exact: true }).waitFor();
      assert.equal(
        preparations,
        preparedBeforeRetry,
        "safe retry retains the same operation",
      );
      phase = "committed";
      await panel
        .getByRole("button", {
          name: "Comprobar publicación y despliegue",
          exact: true,
        })
        .click();
      await panel
        .getByText("Guardado en GitHub · despliegue pendiente", { exact: true })
        .waitFor();
      assert.equal(
        await panel.getByRole("link", { name: /Abrir PR/ }).count(),
        0,
      );
      phase = "deployment_failed";
      await panel
        .getByRole("button", {
          name: "Comprobar publicación y despliegue",
          exact: true,
        })
        .click();
      await panel
        .getByText("El commit está guardado; falló el despliegue", {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await panel.getByText("Publicado en el sitio", { exact: true }).count(),
        0,
      );
      phase = "deployed";
      await panel
        .getByRole("button", {
          name: "Comprobar publicación y despliegue",
          exact: true,
        })
        .click();
      await panel.getByText("Publicado en el sitio", { exact: true }).waitFor();
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${artifacts}/publication-${width}-${dark ? "dark" : "light"}.png`,
      });
      assert.ok(
        await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      );
    }
  remoteEnabled = false;
  await page.goto(`${origin}/?section=jobs-active`);
  await page
    .locator(".jobs-manager-list button")
    .filter({ hasText: "DevOps Engineer" })
    .click();
  await page
    .getByText("Los envíos al repositorio web están deshabilitados.", {
      exact: true,
    })
    .waitFor();
  await page
    .getByLabel("Confirmo los datos públicos de esta oportunidad")
    .check();
  assert.equal(
    await page
      .getByRole("button", {
        name: "Publicar oportunidad",
        exact: true,
      })
      .isDisabled(),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS explicit direct-send/unknown/commit/deployfailure/deploy, CSRF, write-disabled, mobile/themed publication UI; simulated remote only",
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
