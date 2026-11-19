/** Direct publication and historical changeset rendering against the built client; no provider, DB, or runtime writes. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";
import { entityDefinitions } from "../src/shared/product-contract";
const publicRecord = {
  id: "resource-fixture",
  type: "resources",
  state: "approved",
  revision: 2,
  payload: {
    title: {
      "es-pe": "Recurso público sintético",
      en: "Synthetic public resource",
    },
  },
};
let current: any = {
  id: "direct-fixture",
  state: "main_committed",
  result: {
    publicationMode: "direct",
    state: "main_committed",
    commitSha: "a".repeat(40),
    commitUrl: "https://github.com/example/site/commit/" + "a".repeat(40),
    deployment: { state: "pending" },
    canRetryExact: true,
    retrySafe: true,
  },
  files: [],
};
const historical = {
  id: "historical-fixture",
  state: "pr_open",
  pr_number: 123,
  pr_url: "https://github.com/example/site/pull/123",
  result: { publicationMode: "pull-request" },
  files: [],
};
const user = {
  id: "isolated",
  name: "Revisión aislada",
  role: "owner",
  roles: ["owner"],
  capabilities: ["*"],
  csrfToken: "isolated",
};
const app = express(),
  server = createServer(app),
  web = resolve(process.env.PRODUCT_WEB_DIST ?? "dist/web");
let mutations = 0;
let loseResponse = false;
const submissions: {
  key: string;
  ids: string[];
  versions: Record<string, number>;
}[] = [];
app.use(express.json());
app.use("/api", (req, res) => {
  if (req.method !== "GET") mutations++;
  if (req.path === "/config")
    return res.json({
      fixtureAuthEnabled: false,
      localGhAuthEnabled: true,
      editorialMode: "local",
    });
  if (req.path === "/me") return res.json(user);
  if (req.path === "/catalog") return res.json({ entities: entityDefinitions });
  if (req.path === "/media") return res.json([]);
  if (req.path === "/overview")
    return res.json({ counts: {}, reviewQueue: [], upcoming: [] });
  if (req.path === "/website/publication/status")
    return res.json({
      ready: true,
      reasons: [],
      publicationMode: "direct",
      repository: "example/site",
      branch: "main",
      remoteWritesEnabled: true,
      supportedTypes: ["resources"],
    });
  if (req.path === "/records")
    return res.json({
      items: req.query.type === "resources" ? [publicRecord] : [],
      nextCursor: null,
    });
  if (req.path === "/changesets" && req.method === "GET")
    return res.json({ items: [historical, current], nextCursor: null });
  if (req.path === "/changesets" && req.method === "POST") {
    assert.equal(req.headers["x-csrf-token"], "isolated");
    assert.ok(req.headers["idempotency-key"]);
    assert.deepEqual(req.body.recordIds, [publicRecord.id]);
    assert.deepEqual(req.body.expectedRevisions, { [publicRecord.id]: 2 });
    submissions.push({
      key: String(req.get("Idempotency-Key")),
      ids: req.body.recordIds,
      versions: req.body.expectedRevisions,
    });
    return res.status(202).json({ subject_id: current.id });
  }
  if (req.path === `/changesets/${current.id}`) return res.json(current);
  if (req.path === `/changesets/${current.id}/retry`) {
    assert.equal(req.headers["x-csrf-token"], "isolated");
    current = {
      ...current,
      state: "publishing",
      result: { ...current.result, state: "publishing", canRetryExact: false },
    };
    return res
      .status(202)
      .json({ id: "same-operation", subject_id: current.id, state: "queued" });
  }
  if (req.path === `/changesets/${current.id}/reconcile`)
    return res.json(current);
  if (req.path === `/changesets/${historical.id}`) return res.json(historical);
  if (req.method !== "GET") throw Error("Unexpected mutation " + req.path);
  return res
    .status(404)
    .json({ code: "UNEXPECTED_TEST_REQUEST", message: req.path });
});
app.use(express.static(web));
app.get("/{*path}", (_req, res) =>
  res.sendFile("index.html", { root: web, dotfiles: "allow" }),
);
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const artifacts = resolve(
  process.env.ARTIFACTS_DIR ??
    ".local/qa/direct-publication/changesets-browser",
);
await mkdir(artifacts, { recursive: true });
try {
  await page.route("**/api/changesets", async (route) => {
    if (route.request().method() === "POST" && loseResponse) {
      loseResponse = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  for (const width of [1440, 390, 320])
    for (const theme of ["light", "dark"]) {
      current = {
        id: "direct-fixture",
        state: "main_committed",
        result: {
          publicationMode: "direct",
          state: "main_committed",
          commitSha: "a".repeat(40),
          commitUrl: "https://github.com/example/site/commit/" + "a".repeat(40),
          deployment: { state: "pending" },
          canRetryExact: true,
          retrySafe: true,
        },
        files: [],
      };
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${origin}/?section=changesets`);
      await page
        .getByRole("heading", { name: "Publicación del sitio", exact: true })
        .waitFor();
      if ((await page.locator("html").getAttribute("data-theme")) !== theme)
        await page
          .getByRole("button", { name: "Cambiar tema", exact: true })
          .click();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: resolve(artifacts, `before-${width}-${theme}.png`),
        fullPage: true,
      });
      await page
        .getByLabel("Recurso público sintético · revisión 2", { exact: true })
        .check();
      await page
        .getByLabel("He revisado el contenido y su visibilidad pública.", {
          exact: true,
        })
        .check();
      loseResponse = width === 1440 && theme === "light";
      await page
        .getByRole("button", { name: "Publicar cambios en main", exact: true })
        .click();
      if (width === 1440 && theme === "light") {
        await page
          .getByRole("button", {
            name: "Recuperar estado del envío",
            exact: true,
          })
          .waitFor();
        assert.equal(
          await page
            .getByLabel("Recurso público sintético · revisión 2", {
              exact: true,
            })
            .isChecked(),
          true,
        );
        await page.reload();
        await page
          .getByRole("button", {
            name: "Recuperar estado del envío",
            exact: true,
          })
          .waitFor();
        assert.equal(submissions.length, 1, "reload never sends automatically");
        await page
          .getByRole("button", {
            name: "Recuperar estado del envío",
            exact: true,
          })
          .click();
        await page
          .getByRole("heading", {
            name: "Resultado de publicación",
            exact: true,
          })
          .waitFor();
        assert.equal(
          submissions[0].key,
          submissions[1].key,
          "uncertain HTTP recovery reuses exact original intent key",
        );
        assert.deepEqual(submissions[0].ids, submissions[1].ids);
        assert.deepEqual(submissions[0].versions, submissions[1].versions);
      }

      await page
        .getByText("Guardado en GitHub · despliegue pendiente", { exact: true })
        .last()
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: /Integrar PR|Crear PR/ })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("button", {
            name: "Reintentar el mismo envío",
            exact: true,
          })
          .count(),
        0,
        "committed result cannot retry even when historical recovery flags remain true",
      );
      const reconcile = page.getByRole("button", {
        name: "Comprobar publicación y despliegue",
        exact: true,
      });
      for (const [state, deployment, label] of [
        ["deployed", { state: "deployed" }, "Desplegando el sitio"],
        [
          "deploy_failed",
          { state: "failed" },
          "El commit está guardado; falló el despliegue",
        ],
        [
          "unknown",
          { state: "pending" },
          "Comprobando publicación · resultado por confirmar",
        ],
        [
          "conflict",
          { state: "pending" },
          "Hay cambios en GitHub · tu revisión se conserva",
        ],
        [
          "deployed",
          {
            state: "deployed",
            sha: "a".repeat(40),
            url: "https://example.org/es-pe/",
          },
          "Publicado en el sitio",
        ],
      ] as const) {
        current = {
          ...current,
          state,
          result: {
            ...current.result,
            state,
            deployment,
            canRetryExact: true,
            retrySafe: true,
          },
        };
        await reconcile.click();
        await page.getByText(label, { exact: true }).last().waitFor();
        assert.equal(
          await page
            .getByLabel("Recurso público sintético · revisión 2", {
              exact: true,
            })
            .isChecked(),
          true,
        );
        if (state === "unknown")
          assert.equal(
            await page
              .getByRole("button", {
                name: "Publicar cambios en main",
                exact: true,
              })
              .isDisabled(),
            true,
          );
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: resolve(artifacts, `${state}-${width}-${theme}.png`),
          fullPage: true,
        });
        if (state === "unknown") {
          const intentCount = submissions.length;
          await page
            .getByRole("button", {
              name: "Reintentar el mismo envío",
              exact: true,
            })
            .click();
          await page
            .getByText("Publicando en GitHub", { exact: true })
            .last()
            .waitFor();
          assert.equal(
            submissions.length,
            intentCount,
            "safe retry reuses existing operation without preparing a new intent",
          );
        } else {
          assert.equal(
            await page
              .getByRole("button", {
                name: "Reintentar el mismo envío",
                exact: true,
              })
              .count(),
            0,
          );
        }
      }
      await page
        .getByRole("button", {
          name: "Volver a las publicaciones",
          exact: true,
        })
        .click();
      await page.locator(".operation-list button").first().click();
      await page
        .getByRole("link", { name: "Abrir PR histórica", exact: false })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: /Integrar PR|Crear PR/ })
          .count(),
        0,
      );
    }
  assert.deepEqual(errors, []);
  console.log(
    "PASS direct commit/deploymentproof/failure/unknown/conflict preservation/historicalPR1440/390/320themes; simulated API only",
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
