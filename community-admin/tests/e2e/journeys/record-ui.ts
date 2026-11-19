/** Domain-level browser steps; the shared harness owns process, database and network safety. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Page, Locator, Response } from "playwright";

export interface RecordBrowser {
  page: Page;
  origin: string;
}

/** Observe rejection immediately while the triggering UI action is in flight.
 * The original promise is still returned and awaited, so timeouts remain failures.
 */
export function watchResponse(
  page: Page,
  predicate: (response: Response) => boolean,
) {
  const pending = page.waitForResponse(predicate);
  void pending.catch(() => undefined);
  return pending;
}

export async function read(ctx: RecordBrowser, path: string) {
  const response = await ctx.page.request.get(ctx.origin + "/api" + path);
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}

export async function change(
  ctx: RecordBrowser,
  method: string,
  path: string,
  body: unknown,
  version?: number,
) {
  const me = await read(ctx, "/me");
  return ctx.page.request.fetch(ctx.origin + "/api" + path, {
    method,
    headers: {
      Origin: ctx.origin,
      "X-CSRF-Token": me.csrfToken,
      "Idempotency-Key": randomUUID(),
      ...(version ? { "If-Match": `"${version}"` } : {}),
    },
    data: body,
  });
}

export async function destination(ctx: RecordBrowser, section: string) {
  await ctx.page.goto(ctx.origin + "/?section=" + section);
  await ctx.page.locator(".product-main").waitFor();
}

export async function reveal(page: Page, control: Locator) {
  const pane = await control.evaluate((el) =>
    el.closest("[data-editor-pane]")?.getAttribute("data-editor-pane"),
  );
  const panes: Record<string, string> = {
    info: "Información",
    content: "Contenido",
    relationships: "Relaciones",
    media: "Medios",
    review: "Revisión",
    history: "Historial",
  };
  if (pane)
    await page
      .getByRole("navigation", { name: "Secciones del editor" })
      .getByRole("button", { name: new RegExp(panes[pane]) })
      .click();
  const details = control.locator("xpath=ancestor::details[1]");
  if ((await details.count()) && (await details.getAttribute("open")) === null)
    await details.locator("summary").first().click();
}

export async function field(ctx: RecordBrowser, label: string, value: string) {
  // A controlled textarea can contribute its initial text node to the label's
  // textContent after reload; prefix matching still binds the named form field.
  const control = ctx.page.getByLabel(label, { exact: false }).first();
  await reveal(ctx.page, control);
  if (/\((inglés|español)\)$/.test(label)) {
    const compare = ctx.page
      .getByRole("button", { name: "Comparar idiomas", exact: true })
      .first();
    if (await compare.count()) await compare.click();
  }
  await control.fill(value);
}

export async function reference(ctx: RecordBrowser, label: string, id: string) {
  const search = ctx.page.getByLabel("Buscar " + label.toLowerCase(), {
    exact: true,
  });
  await reveal(ctx.page, search);
  const parent = search.locator(
    "xpath=ancestor::div[contains(@class,'reference-field')][1]",
  );
  await parent.locator("select").selectOption(id);
}

export async function createInBrowser(ctx: RecordBrowser, section: string) {
  await destination(ctx, section);
  const created = watchResponse(
    ctx.page,
    (r) => r.url().endsWith("/api/records") && r.request().method() === "POST",
  );
  await ctx.page
    .getByRole("button", { name: "Nuevo registro", exact: true })
    .click();
  const response = await created;
  assert.equal(response.status(), 201, await response.text());
  return response.json();
}

export async function saveAndRead(ctx: RecordBrowser, id: string) {
  const response = watchResponse(
    ctx.page,
    (r) =>
      r.url().endsWith("/api/records/" + id) &&
      r.request().method() === "PATCH" &&
      r.status() === 200,
  );
  await ctx.page
    .getByRole("button", { name: "Guardar revisión", exact: true })
    .click();
  await response;
  return read(ctx, "/records/" + id);
}

export async function reopen(
  ctx: RecordBrowser,
  section: string,
  name: string,
) {
  await destination(ctx, section);
  await ctx.page
    .locator(".record-list li")
    .filter({ hasText: name })
    .getByRole("button")
    .first()
    .click();
  await ctx.page.locator("#record-editor").waitFor();
}

export async function assertContained(page: Page, label: string) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    label,
  );
}

export async function visualVariants(
  ctx: RecordBrowser & { screenshot(name: string): Promise<string> },
  name: string,
) {
  for (const width of [1440, 390, 320])
    for (const theme of ["light", "dark"]) {
      await ctx.page.setViewportSize({ width, height: 1000 });
      if ((await ctx.page.locator("html").getAttribute("data-theme")) !== theme)
        await ctx.page
          .getByRole("button", { name: "Cambiar tema", exact: true })
          .click();
      await assertContained(ctx.page, `${name}-${width}-${theme}`);
      await ctx.screenshot(`${name}-${width}-${theme}`);
    }
}
