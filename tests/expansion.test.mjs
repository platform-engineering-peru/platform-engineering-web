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
  assert.equal(q("[data-job-dialog] aside button").disabled, true);
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
test("new pages exist in both languages with skip-link target and demo labels", async () => {
  for (const lang of ["en", "es-pe"])
    for (const page of ["opportunities", "memories", "mascot"]) {
      const html = await readFile(
        new URL(`../dist/${lang}/${page}/index.html`, import.meta.url),
        "utf8",
      );
      assert.match(html, /id="main-content"/);
      assert.match(html, /data-mega/);
      if (page !== "mascot") assert.match(html, /Demo|muestra/);
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
