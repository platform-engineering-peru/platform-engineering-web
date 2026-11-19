import test from "node:test";
import assert from "node:assert/strict";
import { publicationView } from "../src/web/publication-state";
test("a direct commit is distinct from exact deployment and historical PR state", () => {
  const committed = {
    publicationMode: "direct",
    state: "main_committed",
    commitSha: "a".repeat(40),
    commitUrl: "https://github.com/example/site/commit/" + "a".repeat(40),
    deployment: { state: "pending" },
  };
  assert.equal(
    publicationView(committed).label,
    "Guardado en GitHub · despliegue pendiente",
  );
  assert.equal(
    publicationView({
      ...committed,
      state: "deployed",
      deployment: { state: "deployed" },
    }).state,
    "deploying",
  );
  assert.equal(
    publicationView({
      ...committed,
      state: "deployed",
      deployedSha: "a".repeat(40),
      deployment: { state: "deployed", sha: "a".repeat(40) },
    }).label,
    "Publicado en el sitio",
  );
  assert.equal(
    publicationView({
      ...committed,
      state: "deploy_failed",
      deployment: { state: "failed" },
    }).label,
    "El commit está guardado; falló el despliegue",
  );
  assert.equal(
    publicationView({ state: "unknown", result: committed }).state,
    "uncertain",
  );
  assert.equal(
    publicationView({ ...committed, state: "conflict" }).label,
    "Hay cambios en GitHub · tu revisión se conserva",
  );
  assert.equal(
    publicationView({ state: "pr_open", pr_number: 12 }).mode,
    "pull-request",
  );
  assert.doesNotMatch(publicationView(committed).label, /PR|propuesta/);
});

test("uncertain result never displays an old commit as confirmed", async () => {
  const React = await import("react"),
    { renderToStaticMarkup } = await import("react-dom/server"),
    { PublicationStatus } = await import("../src/web/publication-status");
  const html = renderToStaticMarkup(
    React.createElement(PublicationStatus, {
      value: {
        state: "unknown",
        result: {
          publicationMode: "direct",
          state: "deployed",
          commitSha: "a".repeat(40),
          commitUrl: "https://github.com/example/site/commit/" + "a".repeat(40),
          deployedSha: "a".repeat(40),
        },
      },
    }),
  );
  assert.match(html, /resultado por confirmar/);
  assert.doesNotMatch(
    html,
    /Versión desplegada:|href=.*commit|<li class="done"[^>]*>Commit/,
  );
});
