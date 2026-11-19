/** Isolated web acceptance: synthetic HTTP fixtures, copied source, no live app/DB/providers. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stableJson } from "../src/web/editorial-state";
import { cp, mkdir, writeFile, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer, build, preview } from "vite";
import { chromium } from "playwright";
import { entityDefinitions } from "../src/shared/product-contract";
const built = process.env.EDITORIAL_BROWSER_BUILT === "1";
const root = resolve(".local/qa/editorial-preview"),
  artifacts = resolve(
    `.local/qa/editorial-brand-calendar${built ? "-built" : ""}`,
  );
await mkdir(root, { recursive: true });
await mkdir(artifacts, { recursive: true });
await cp("src", `${root}/src`, { recursive: true });
await cp("public", `${root}/public`, { recursive: true });
try {
  await symlink(resolve("node_modules"), `${root}/node_modules`, "dir");
} catch {}
await writeFile(
  `${root}/src/web/qa.html`,
  '<!doctype html><html lang="es-PE"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/qa.tsx"></script></html>',
);
await writeFile(
  `${root}/src/web/qa.tsx`,
  `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{ProductPage}from'./product';import{ProductNavigation,ShellHeader}from'./navigation';import './style.css';import './design.css';import './shell.css';const user={id:'fixture',name:'Revisión visual aislada',role:'owner',roles:['owner'],capabilities:new URLSearchParams(location.search).has('viewer')?['content:read']:['*'],csrfToken:'fixture-only',isFixture:true};function App(){const[active,setActive]=useState(new URLSearchParams(location.search).get('section')||'calendar'),[dark,setDark]=useState(false);const select=(id)=>{setActive(id);return true};return <div className="admin-shell"><a className="skip-link" href="#main-content">Ir al contenido</a><ProductNavigation active={active} onSelect={select}/><div className="admin-stage"><ShellHeader active={active} onSelect={select} user={user} darkTheme={dark} onTheme={()=>{document.documentElement.dataset.theme=dark?'light':'dark';setDark(!dark)}} onLogout={()=>{}} onReverify={()=>{}} busy={false} localMode={true} fixtureMode={false}/><div className="admin-content"><ProductPage section={active} user={user} onNavigate={select}/></div></div></div>}createRoot(document.getElementById('root')).render(<App/>);`,
);
let stop: () => Promise<void>;
if (built) {
  const outDir = `${root}/dist-ui`;
  await build({
    configFile: false,
    root: `${root}/src/web`,
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: { input: `${root}/src/web/qa.html` },
    },
  });
  const builtServer = await preview({
    configFile: false,
    root: `${root}/src/web`,
    build: { outDir },
    preview: { host: "127.0.0.1", port: 4468, strictPort: true },
  });
  stop = () =>
    new Promise((resolve, reject) =>
      builtServer.httpServer.close((error) =>
        error ? reject(error) : resolve(),
      ),
    );
} else {
  const server = await createServer({
    configFile: false,
    root: `${root}/src/web`,
    server: {
      host: "127.0.0.1",
      port: 4468,
      strictPort: true,
      fs: { allow: [root, resolve("node_modules")] },
    },
  });
  await server.listen();
  stop = () => server.close();
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1100 },
  timezoneId: "Asia/Tokyo",
  reducedMotion: "reduce",
});
await page.clock.setFixedTime(new Date("2026-11-16T18:00:00Z"));
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const defaults = entityDefinitions.find((d) => d.type === "events")!.defaults;
const event = {
  schemaVersion: 1,
  id: "d4f11efe-7c37-40fc-ab4c-237067fe65d5",
  status: "published",
  updatedAt: null,
  ...defaults,
  slug: "encuentro-aislado",
  title: { "es-pe": "Encuentro de plataformas", en: "Platform gathering" },
  date: "2026-11-16",
  time: "18:00",
  startsAt: "2026-11-16T23:00:00Z",
  description: {
    "es-pe": "Fixture de aceptación aislada",
    en: "Isolated acceptance fixture",
  },
};
let drafts: any[] = [];
let state = "online";
let writes = true;
let pending = false;
let pullCount = 0;
let conflict = false;
let uncertain = false;
let putConflict = false;
let empty = false;
const apiPaths: string[] = [];
const snapshot = () => ({
  recordHashes: {
    [event.id]: createHash("sha256").update(stableJson(event)).digest("hex"),
  },
  commit: "a".repeat(40),
  fetchedAt: "2026-11-16T18:00:00Z",
  records: empty ? [] : [event],
  references: {
    speakers: [
      { id: "30000000-0000-4000-8000-000000000041", name: "Speaker de GitHub" },
    ],
  },
  stale: state === "offline",
});
const status = () => ({
  mode: "github",
  configured: state !== "unconfigured",
  remoteWritesEnabled: writes,
  repository: "fixture/editorial",
  branch: "main",
  supportedTypes: ["events"],
  identity: { login: "fixture", subject: "1" },
  headCommit: "a".repeat(40),
  lastFetchedAt: "2026-11-16T18:00:00Z",
  connection: state,
});
const publications = [
  {
    id: "publication1",
    channel: "youtube",
    state: "scheduled",
    schedule_at: "2026-11-16T20:00:00Z",
    destination: "Canal de prueba",
    payload: { title: "Conversaciones de plataforma" },
  },
  {
    id: "publication2",
    channel: "linkedin",
    state: "draft",
    schedule_at: null,
    payload: { text: "Ideas para el siguiente encuentro" },
  },
  {
    id: "boundary",
    channel: "linkedin",
    state: "scheduled",
    schedule_at: "2026-11-01T04:59:00Z",
    payload: { text: "Límite de octubre en Lima" },
  },
];
await page.route("**/api/**", async (route) => {
  const req = route.request(),
    url = new URL(req.url()),
    p = url.pathname.replace("/api", "");
  let body: any = {};
  try {
    body = req.postDataJSON() ?? {};
  } catch {}
  apiPaths.push(p);
  const ok = (value: any) => route.fulfill({ json: value });
  if (p === "/catalog") return ok({ entities: entityDefinitions });
  if (p === "/config") return ok({ editorialMode: "github" });
  if (p === "/media") return ok([]);
  if (p === "/publications")
    return ok({ items: empty ? [] : publications, nextCursor: null });
  if (p === "/editorial/status") return ok(status());
  if (p === "/editorial/events") return ok(snapshot());
  if (p === "/editorial/drafts") return ok({ items: drafts });
  if (p === "/editorial/pull") {
    pullCount++;
    if (state === "offline")
      return route.fulfill({
        status: 503,
        json: { code: "REMOTE_UNAVAILABLE", message: "GitHub no disponible" },
      });
    return ok(snapshot());
  }
  if (p.startsWith("/editorial/drafts/") && req.method() === "PUT") {
    if (putConflict)
      return route.fulfill({
        status: 409,
        json: {
          code: "DRAFT_VERSION_CONFLICT",
          message: "Otra sesión guardó este borrador",
        },
      });
    const id = p.split("/")[3],
      old = drafts.find((d) => d.id === id);
    const next = {
      ...body,
      id,
      type: "events",
      version: (old?.version ?? 0) + 1,
      state: "local",
      updatedAt: new Date().toISOString(),
    };
    drafts = [next, ...drafts.filter((d) => d.id !== id)];
    return ok(next);
  }
  if (p === "/editorial/proposals") {
    assert.equal(body.drafts.length, 2);
    const proposal = {
      number: 99,
      url: "https://github.com/fixture/editorial/pull/99",
      headCommit: "f".repeat(40),
    };
    const chosen = body.drafts.map((selection: any) => {
      const draft = drafts.find((d) => d.id === selection.id);
      assert.equal(selection.expectedVersion, draft.version);
      return { ...draft, state: "proposed", proposal };
    });
    drafts = chosen;
    return ok({ items: chosen, proposal });
  }
  if (p.endsWith("/propose")) {
    if (uncertain) {
      drafts = drafts.map((d) =>
        d.id !== p.split("/")[3]
          ? d
          : {
              ...d,
              state: "unknown",
              submission: {
                id: "unknown",
                state: "unknown",
                branch: "editorial/unknown",
                errorCode: "PROPOSAL_UNCERTAIN",
                reconcileRequired: true,
                canEdit: false,
              },
            },
      );
      return route.fulfill({
        status: 503,
        json: {
          code: "PROPOSAL_UNCERTAIN",
          message: "No se pudo confirmar la PR",
        },
      });
    }
    if (conflict) {
      drafts = [
        {
          ...drafts[0],
          state: "conflict",
          conflict: {
            base: event,
            remote: {
              ...event,
              title: {
                "es-pe": "Actualizado en GitHub",
                en: "Changed remotely",
              },
            },
            local: drafts[0].payload,
            remoteCommit: "c".repeat(40),
          },
        },
      ];
      return route.fulfill({
        status: 409,
        json: {
          code: "REMOTE_RECORD_CONFLICT",
          message: "El evento cambió en GitHub",
        },
      });
    }
    const id = p.split("/")[3];
    const next = {
      ...drafts.find((d) => d.id === id),
      state: "proposed",
      proposal: {
        number: 42,
        url: "https://github.com/fixture/editorial/pull/42",
        headCommit: "b".repeat(40),
      },
    };
    drafts = [next];
    pending = true;
    return ok(next);
  }
  if (p.endsWith("/reconcile")) return ok(drafts[0]);
  return ok({ items: [], nextCursor: null });
});
try {
  await page.goto("http://127.0.0.1:4468/qa.html");
  await page.getByRole("grid").waitFor();
  assert.equal(await page.getByRole("gridcell").count(), 42);
  await page.locator('[data-day="2026-11-16"]').click();
  await page
    .locator(".calendar-day-detail")
    .getByText("Encuentro de plataformas", { exact: true })
    .waitFor();
  assert.match(
    await page.locator(".calendar-day-detail").innerText(),
    /Encuentro de plataformas/,
  );
  assert.match(
    await page.locator(".calendar-day-detail").innerText(),
    /Conversaciones de plataforma/,
  );
  assert.match(
    await page.locator(".calendar-unscheduled").innerText(),
    /Ideas para/,
  );
  await page.locator('[data-day="2026-11-16"]').press("ArrowRight");
  await page
    .locator('.calendar-cell[aria-selected="true"] [data-day="2026-11-17"]')
    .waitFor();
  await page.locator('[data-day="2026-11-17"]:focus').waitFor();
  assert.equal(
    await page
      .locator(".calendar-cell[aria-selected=true] .calendar-date")
      .getAttribute("data-day"),
    "2026-11-17",
  );
  assert.equal(
    await page.locator(".calendar-date:focus").getAttribute("data-day"),
    "2026-11-17",
  );
  await page.getByRole("button", { name: "Mes anterior", exact: true }).click();
  await page.locator('[data-day="2026-10-31"]').click();
  assert.match(
    await page.locator(".calendar-day-detail").innerText(),
    /Límite de octubre/,
  );
  await page.getByRole("button", { name: "Hoy", exact: true }).click();
  await page
    .getByRole("button", { name: "Mes siguiente", exact: true })
    .click();
  assert.match(
    await page.locator(".calendar-toolbar h2").innerText(),
    /diciembre/i,
  );
  await page.getByRole("button", { name: "Hoy", exact: true }).click();
  for (const theme of ["light", "dark"]) {
    if (theme === "dark")
      await page
        .getByRole("button", { name: "Cambiar tema", exact: true })
        .click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `${artifacts}/calendar-desktop-${theme}.png`,
      fullPage: true,
    });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 950 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `no overflow ${width} ${theme}`,
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: `${artifacts}/calendar-mobile-${width}-${theme}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
  }
  await page.getByRole("button", { name: "Agenda", exact: true }).click();
  assert.match(
    await page.locator(".calendar-agenda").innerText(),
    /Encuentro de plataformas/,
  );
  await page.goto("http://127.0.0.1:4468/qa.html?section=events");
  await page.getByRole("button", { name: /Encuentro de plataformas/ }).click();
  await page
    .getByRole("heading", { name: "Encuentro de plataformas", exact: true })
    .waitFor();

  const spanishTitle = page.getByRole("textbox", {
    name: "Título (español)",
    exact: true,
  });
  const englishTitle = page.getByRole("textbox", {
    name: "Título (inglés)",
    exact: true,
  });
  await spanishTitle.fill("Encuentro editado en este equipo");
  await englishTitle.fill("Edited local gathering");
  await page
    .getByRole("button", { name: "Consultar GitHub", exact: true })
    .click();
  assert.equal(
    await spanishTitle.inputValue(),
    "Encuentro editado en este equipo",
  );
  await page
    .getByRole("button", { name: "Guardar borrador local", exact: true })
    .click();
  await page
    .getByText("Guardado en este equipo. Todavía no se ha enviado a GitHub.", {
      exact: true,
    })
    .waitFor();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].payload.title.en, "Edited local gathering");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `${artifacts}/events-local-editor.png`,
    fullPage: true,
  });
  await page
    .locator(".editorial-form-tabs")
    .getByRole("button", { name: "Relaciones", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Speaker de GitHub", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Información", exact: true }).click();
  await page.locator("#field-venue").scrollIntoViewIfNeeded();
  const actionBox = await page.locator(".editorial-actions").boundingBox();
  const headerBox = await page.locator(".shell-header").boundingBox();
  assert.ok(
    actionBox &&
      actionBox.y >= (headerBox?.y ?? 0) + (headerBox?.height ?? 0) &&
      actionBox.y + actionBox.height <= 1100,
    `save actions stay below app chrome and within viewport: ${JSON.stringify({ actionBox, headerBox })}`,
  );
  await page
    .locator(".editorial-form-tabs")
    .getByRole("button", { name: "Contenido", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Descripción (español)", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Información", exact: true }).click();
  assert.equal(
    await spanishTitle.inputValue(),
    "Encuentro editado en este equipo",
  );
  for (const theme of ["light", "dark"]) {
    if (theme === "dark")
      await page
        .getByRole("button", { name: "Cambiar tema", exact: true })
        .click();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: `${artifacts}/events-focused-${width}-${theme}.png`,
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("button", { name: "Cambiar tema", exact: true }).click();
  await page
    .getByRole("button", { name: "Publicar evento en main", exact: true })
    .click();
  await page
    .getByText("PR en revisión · aún no integrado", { exact: true })
    .last()
    .waitFor();
  assert.equal(event.title["es-pe"], "Encuentro de plataformas");
  assert.equal(pending, true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `${artifacts}/events-pr-review.png`,
    fullPage: true,
  });
  state = "offline";
  await page
    .getByRole("button", { name: "Consultar GitHub", exact: true })
    .click();
  await page
    .getByText("Sin conexión · versión consultada conservada", { exact: true })
    .waitFor();
  assert.equal(
    await spanishTitle.inputValue(),
    "Encuentro editado en este equipo",
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `${artifacts}/events-offline.png`,
    fullPage: true,
  });
  state = "online";
  await spanishTitle.fill("Nuevo texto conservado");
  await page
    .getByRole("button", { name: "Guardar borrador local", exact: true })
    .click();
  await page
    .getByText("Guardado en este equipo. Todavía no se ha enviado a GitHub.", {
      exact: true,
    })
    .waitFor();
  conflict = true;
  await page
    .getByRole("button", { name: "Publicar evento en main", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "El evento cambió en GitHub", exact: true })
    .waitFor();
  assert.equal(await spanishTitle.inputValue(), "Nuevo texto conservado");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `${artifacts}/events-conflict.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", {
      name: "Consultar versión más reciente",
      exact: true,
    })
    .click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: /Conservar mi texto en un nuevo borrador/ })
    .click();
  await page
    .getByRole("button", { name: "Guardar borrador local", exact: true })
    .click();
  await page
    .getByText("Guardado en este equipo. Todavía no se ha enviado a GitHub.", {
      exact: true,
    })
    .waitFor();
  assert.equal(drafts.length, 2);
  conflict = false;
  uncertain = true;
  await page
    .getByRole("button", { name: "Publicar evento en main", exact: true })
    .click();
  await page
    .getByText(/No se pudo confirmar si GitHub recibió la publicación/)
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Publicar evento en main", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(await spanishTitle.inputValue(), "Nuevo texto conservado");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `${artifacts}/events-uncertain.png`,
    fullPage: true,
  });
  await page.reload();
  await page
    .locator(".editorial-event-list")
    .getByRole("button", {
      name: /Nuevo texto conservado.*Resultado por confirmar/,
    })
    .click();
  await page
    .getByText("Resultado por confirmar · comprobar antes de publicar", {
      exact: true,
    })
    .last()
    .waitFor();
  assert.ok(
    await page
      .getByRole("button", { name: "Guardar borrador local", exact: true })
      .isDisabled(),
  );
  await spanishTitle.fill("Texto mientras se comprueba el envío");
  drafts = drafts.map((d) => ({
    ...d,
    state: "retryable",
    submission: {
      ...d.submission,
      state: "retryable",
      reconcileRequired: false,
      canEdit: true,
    },
  }));
  await page
    .getByRole("button", { name: "Comprobar resultado", exact: true })
    .click();
  assert.equal(
    await spanishTitle.inputValue(),
    "Texto mientras se comprueba el envío",
  );
  putConflict = true;
  await spanishTitle.fill("Texto tras conflicto local");
  await page
    .getByRole("button", { name: "Guardar borrador local", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "La revisión que viste cambió en otra sesión" })
    .waitFor();
  assert.equal(await spanishTitle.inputValue(), "Texto tras conflicto local");
  putConflict = false;
  uncertain = false;
  drafts = [
    {
      ...drafts[0],
      state: "local",
      version: drafts[0].version + 1,
      submission: undefined,
      proposal: undefined,
      payload: {
        ...drafts[0].payload,
        title: { "es-pe": "Evento conjunto uno", en: "Batch event one" },
      },
    },
    {
      ...drafts[0],
      id: "50000000-0000-4000-8000-000000000042",
      recordId: "20000000-0000-4000-8000-000000000042",
      state: "local",
      submission: undefined,
      proposal: undefined,
      payload: {
        ...drafts[0].payload,
        title: { "es-pe": "Evento conjunto dos", en: "Batch event two" },
        displayOrder: 20,
      },
    },
  ];
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await page
    .getByRole("checkbox", {
      name: "Seleccionar borrador Evento conjunto uno",
      exact: true,
    })
    .check();
  await page
    .getByRole("checkbox", {
      name: "Seleccionar borrador Evento conjunto dos",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Publicar seleccionados (2)", exact: true })
    .click();
  await page
    .getByText(
      "Estado del envío conjunto consultado para 2 eventos. Revisa los estados confirmados.",
      { exact: true },
    )
    .waitFor();
  assert.equal(drafts.filter((d) => d.proposal?.number === 99).length, 2);
  assert.equal(event.title["es-pe"], "Encuentro de plataformas");
  state = "unconfigured";
  drafts = [];
  await page.goto("http://127.0.0.1:4468/qa.html?section=events");
  await page
    .getByRole("heading", { name: "GitHub no configurado", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Nuevo evento", exact: true })
      .isDisabled(),
    true,
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `${artifacts}/events-unconfigured.png`,
    fullPage: true,
  });
  state = "online";
  empty = true;
  await page.goto("http://127.0.0.1:4468/qa.html");
  await page.getByRole("grid").waitFor();
  assert.equal(await page.getByRole("gridcell").count(), 42);
  assert.equal(await page.locator(".calendar-chips button").count(), 0);
  await page.getByText("Este día está libre.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Agenda", exact: true }).click();
  await page
    .getByRole("heading", { name: "Un mes por planificar", exact: true })
    .waitFor();
  assert.equal(
    apiPaths.some((path) => path.startsWith("/records")),
    false,
    "GitHub event editor never queries SQL record authority",
  );
  assert.ok(
    await page.evaluate(() =>
      Array.from(document.images).every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    ),
    "official brand/provider images decode",
  );
  await page.evaluate(() => document.fonts.ready);
  assert.ok(
    await page.evaluate(
      () =>
        document.fonts.check('12px "DM Sans"') &&
        document.fonts.check("12px Epilogue"),
    ),
    "official local fonts load",
  );
  empty = false;
  writes = false;
  await page.goto("http://127.0.0.1:4468/qa.html?section=events");
  await page
    .locator(".editorial-event-list")
    .getByRole("button", { name: /Encuentro de plataformas/ })
    .click();
  await page
    .getByText(
      "Los envíos a GitHub no están habilitados. Puedes conservar el borrador local.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Publicar evento en main", exact: true })
      .isDisabled(),
    true,
  );
  await page.goto("http://127.0.0.1:4468/qa.html?section=events&viewer=1");
  await page
    .locator(".editorial-event-list")
    .getByRole("button", { name: /Encuentro de plataformas/ })
    .click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Título (español)", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Guardar borrador local", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByText(
      "Tu cuenta puede consultar eventos; no tiene permiso para guardar o publicar cambios.",
      { exact: true },
    )
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        calendar: "passed",
        syncStates: "passed",
        narrowThemes: "passed",
        officialAssets: "passed",
        built,
        pullCount,
        artifacts,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await stop();
}
