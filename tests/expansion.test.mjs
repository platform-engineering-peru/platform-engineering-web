import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
let window, document;
const q = (s) => document.querySelector(s);
before(async () => {
  window = new Window({
    url: "http://localhost/es-pe/opportunities/",
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  });
  document = window.document;
  document.write(
    await readFile(
      new URL("../dist/es-pe/opportunities/index.html", import.meta.url),
      "utf8",
    ),
  );
  // Explicit controller fixtures are not canonical vacancies or production page content.
  const titles = [
    "Senior Platform Engineer",
    "Site Reliability Engineer",
    "Developer Experience Engineer",
    "Cloud Infrastructure Engineer",
    "Platform Product Lead",
  ];
  document.querySelector("[data-jobs]").innerHTML =
    `<div>${["all", "remote", "hybrid", "onsite"].map((mode) => `<button data-job-filter="${mode}">${mode}</button>`).join("")}</div><button data-job-motion></button><span data-job-count></span><div data-job-stage tabindex="0">${titles.map((title, i) => `<button data-job="${i}" data-mode="${[1, 3].includes(i) ? "hybrid" : "remote"}"><strong>${title}</strong></button>`).join("")}</div><button data-job-prev></button><button data-job-next></button><h2 data-job-title></h2><span data-job-position></span><button data-job-open></button><p data-job-filter-empty hidden></p><dialog data-job-dialog><button data-job-close></button><div data-job-content></div></dialog>${titles.map((title, i) => `<button data-job-list="${i}">${title}</button><template data-job-template="${i}"><h2 id="job-detail-title">${title}</h2><aside><a href="https://example.org/apply/${i}">Apply at original source</a></aside></template>`).join("")}`;
  Object.assign(globalThis, {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    ResizeObserver: class {
      observe() {}
    },
    IntersectionObserver: class {
      observe() {}
    },
  });
  await import("../src/modules/opportunities/opportunities.ts");
  await import("../src/components/layout/mega-menu.ts");
});
after(() => window.happyDOM.abort());
test("opportunities filter, wrap and synchronize role details", () => {
  q('[data-job-filter="hybrid"]').click();
  assert.equal(document.querySelectorAll("[data-job]:not([hidden])").length, 2);
  assert.match(q("[data-job-title]").textContent, /Site Reliability/);
  q("[data-job-prev]").click();
  assert.match(q("[data-job-title]").textContent, /Cloud Infrastructure/);
  q("[data-job-open]").focus();
  q("[data-job-open]").click();
  assert.equal(q("[data-job-dialog]").open, true);
  assert.match(q("#job-detail-title").textContent, /Cloud Infrastructure/);
  assert.match(q("[data-job-dialog] aside a").getAttribute("href"), /^https:\/\/example\.org\/apply\//);
  q("[data-job-close]").click();
  assert.equal(q("[data-job-dialog]").open, false);
  assert.equal(document.activeElement, q("[data-job-open]"));
});
test("opportunity keyboard navigation works without dragging", () => {
  q('[data-job-filter="all"]').click();
  q("[data-job-stage]").dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
  );
  assert.match(q("[data-job-title]").textContent, /Site Reliability/);
});
test("mega menu Escape closes and returns focus to its trigger", () => {
  const menu = q("[data-mega]");
  menu.open = true;
  menu.querySelector("a").focus();
  menu.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(menu.open, false);
  assert.equal(document.activeElement, menu.querySelector("summary"));
});
test("new pages exist in both languages with skip-link targets and appropriate content labels", async () => {
  for (const lang of ["en", "es-pe"])
    for (const page of ["opportunities", "memories", "mascot"]) {
      const html = await readFile(
        new URL(`../dist/${lang}/${page}/index.html`, import.meta.url),
        "utf8",
      );
      assert.match(html, /id="main-content"/);
      assert.match(html, /data-mega/);
      if (page === "opportunities") {
        assert.doesNotMatch(html, /Lorem Labs|Ipsum Cloud|Applications unavailable in demo/);
        assert.match(html, /No hay oportunidades revisadas|No reviewed opportunities|Oportunidades revisadas|Reviewed opportunities/);
      }
      if (page === "memories") {
        for (let i=1;i<=5;i++) assert.ok(html.includes(`memories/community-0${i}.jpg`));
        assert.doesNotMatch(html, /Lorem ipsum|Demo gallery|Galería de muestra/);
      }
    }
});
test("Oscar profile uses public personal links and coffee illustration", async () => {
  const html = await readFile(
    new URL("../dist/es-pe/community/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /oscar-coffee.webp/);
  assert.match(html, /https:\/\/0vas.com/);
  assert.match(html, /https:\/\/www.linkedin.com\/in\/oscarlobatons\//);
  assert.match(html, /Cobre/);
});

test('navbar keeps links available when pointer focus leaves a summary without a related target', async () => {
  const menu = q('[data-mega]');
  menu.open = true;
  menu.querySelector('summary').focus();
  menu.querySelector("summary").blur();
  menu.querySelector('summary').dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  await Promise.resolve();
  assert.equal(menu.open, true, 'a pointer focus transition must not hide a link before its click');
  menu.open = false;
});

test('navbar closes after activating a same-page anchor without cancelling navigation', () => {
  const header=q('[data-header]'), menu=q('[data-mega]');
  menu.open=true;header.classList.add('is-open');
  const link=menu.querySelector('a');
  const event=new window.MouseEvent('click',{bubbles:true,cancelable:true});
  link.dispatchEvent(event);
  assert.equal(event.defaultPrevented,false);
  assert.equal(menu.open,false);
  assert.equal(header.classList.contains('is-open'),false);
});

test("logo is the home entry and navbar has no redundant home item", () => {
  assert.equal(q('.header__brand').getAttribute('href'), '/es-pe/');
  assert.equal(q('.header__nav').textContent.includes('Inicio'), false);
  assert.equal(document.querySelectorAll('.header [data-mega]').length, 3);
});

test("community channels use local SVG brand assets", async () => {
  const icons = [...document.querySelectorAll('.join__icon img')];
  assert.equal(icons.length, 3);
  for (const brand of ['whatsapp', 'meetup', 'linkedin']) {
    assert.ok(icons.some(img => img.getAttribute('src').endsWith(`/brand/social/${brand}.svg`)));
    const svg = await readFile(new URL(`../public/brand/social/${brand}.svg`, import.meta.url), 'utf8');
    assert.match(svg, /<svg\b/);
    assert.doesNotMatch(svg, /<script|<image\b|https?:\/\/(?!www\.w3\.org)/);
  }
});

test("opportunity wheel advances without trapping vertical page scrolling", () => {
  q('[data-job-filter="all"]').click();
  const stage = q('[data-job-stage]');
  for(let i=0;i<2;i++) {
    const event = new window.WheelEvent('wheel', {deltaY:150, bubbles:true, cancelable:true});
    stage.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.match(q('[data-job-title]').textContent, /Site Reliability/);
  const horizontal = new window.WheelEvent('wheel', {deltaX:120, bubbles:true,cancelable:true});
  stage.dispatchEvent(horizontal);
  assert.equal(horizontal.defaultPrevented, true);
});

test("carousel motion starts paused for reduced-motion users and can be toggled", () => {
  const toggle = q('[data-job-motion]');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
});

test('construction destinations exist in both languages and use the new Ukuku asset', async () => {
  for (const lang of ['es-pe','en']) for (const page of ['team','participate','golden-paths','partners','marketplace']) {
    const html = await readFile(new URL(`../dist/${lang}/${page}/index.html`, import.meta.url),'utf8');
    assert.match(html,/WORK IN PROGRESS/);
    assert.match(html,/ukuku-builder.webp/);
    assert.match(html,/data-work-pause/);
    assert.match(html,/data-header/);
    assert.match(html,/data-theme-toggle/);
    assert.doesNotMatch(html,/<video/);
  }
});
test('navbar has one mascot entry and dedicated construction destinations', () => {
  const nav=q('.header__nav');
  assert.equal(nav.querySelectorAll('a[href="/es-pe/mascot/"]').length,1);
  for(const page of ['team','participate','golden-paths','partners','marketplace']) assert.ok(nav.querySelector(`a[href="/es-pe/${page}/"]`));
});

test('Partners belongs to Community and Marketplace replaces it in Explore',()=>{
 const menus=Array.from(document.querySelectorAll('details'));
 const community=menus.find(el=>el.querySelector('summary')?.textContent.includes('Comunidad'));
 const explore=menus.find(el=>el.querySelector('summary')?.textContent.includes('Explora'));
 assert.ok(community?.querySelector('a[href="/es-pe/partners/"]'));
 assert.equal(community?.querySelector('a[href="/es-pe/community/#team"]'),null);
 assert.ok(explore?.querySelector('a[href="/es-pe/marketplace/"]'));
 assert.equal(explore?.querySelector('a[href="/es-pe/partners/"]'),null);
});

test("an empty modality disables carousel actions and shows an honest zero result", () => {
  q('[data-job-filter="onsite"]').click();
  assert.equal(q("[data-job-position]").textContent, "00 / 00");
  assert.equal(q("[data-job-open]").disabled, true);
  assert.equal(q("[data-job-filter-empty]").hidden, false);
  q("[data-job-stage]").dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  assert.equal(q("[data-job-dialog]").open, false);
  q('[data-job-filter="all"]').click();
  assert.equal(q("[data-job-open]").disabled, false);
});

test("expiry on boot and resume hides carousel/list entries, closes detail and cannot return through filters", async () => {
  const { initOpportunities } =
    await import("../src/modules/opportunities/opportunities.ts");
  const fixture = q("[data-jobs]").cloneNode(true);
  document.body.append(fixture);
  const cards = [...fixture.querySelectorAll("[data-job]")];
  cards.forEach((c) => (c.dataset.expiresAt = "2000-01-01T00:00:00Z"));
  cards[0].dataset.expiresAt = "2999-01-01T00:00:00Z";
  initOpportunities(fixture);
  assert.equal(fixture.querySelectorAll("[data-job]:not([hidden])").length, 1);
  fixture.querySelector("[data-job-open]").click();
  assert.equal(fixture.querySelector("dialog").open, true);
  cards[0].dataset.expiresAt = "2000-01-01T00:00:00Z";
  document.dispatchEvent(new window.Event("visibilitychange"));
  assert.equal(fixture.querySelector("dialog").open, false);
  assert.equal(
    fixture.querySelector("[data-job-content]").childElementCount,
    0,
  );
  assert.equal(fixture.querySelector("[data-job-open]").disabled, true);
  assert.equal(
    fixture.querySelectorAll("[data-job-list]:not([hidden])").length,
    0,
  );
  fixture.querySelector('[data-job-filter="all"]').click();
  assert.equal(fixture.querySelectorAll("[data-job]:not([hidden])").length, 0);
  assert.match(
    fixture.querySelector("[data-job-filter-empty]").textContent,
    /vigentes|unexpired/,
  );
  fixture.remove();
});
test("a due expiry timer removes the last open role without private polling", async () => {
  const { initOpportunities } =
    await import("../src/modules/opportunities/opportunities.ts");
  const fixture = q("[data-jobs]").cloneNode(true);
  document.body.append(fixture);
  fixture
    .querySelectorAll("[data-job]")
    .forEach(
      (c) => (c.dataset.expiresAt = new Date(Date.now() + 60).toISOString()),
    );
  initOpportunities(fixture);
  fixture.querySelector("[data-job-open]").click();
  assert.equal(fixture.querySelector("dialog").open, true);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fixture.querySelector("dialog").open, false);
  assert.equal(
    fixture.querySelector("[data-job-position]").textContent,
    "00 / 00",
  );
  fixture.remove();
});
