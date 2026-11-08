import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
let window, document;
const q = (s) => document.querySelector(s);
const input = (selector, value) => {
  q(selector).value = value;
  q(selector).dispatchEvent(new window.Event("input", { bubbles: true }));
};
before(async () => {
  window = new Window({
    url: "http://localhost/es-pe/resources/",
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  });
  document = window.document;
  document.write(
    await readFile(
      new URL("../dist/es-pe/resources/index.html", import.meta.url),
      "utf8",
    ),
  );
  const community = await readFile(
    new URL("../dist/es-pe/community/index.html", import.meta.url),
    "utf8",
  );
  const temp = document.createElement("div");
  temp.innerHTML = community;
  document.body.append(temp.querySelector("[data-people-carousel]"));
  for (const key of [
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLButtonElement",
    "HTMLAnchorElement",
    "HTMLTemplateElement",
    "HTMLDialogElement",
    "KeyboardEvent",
    "PointerEvent",
  ])
    globalThis[key] = window[key];
  Object.assign(globalThis, {
    window,
    document,
    innerWidth: 1280,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  await import("../src/modules/resources/archive-controller.ts");
  await import("../src/components/layout/site-search.ts");
  await import("../src/modules/community/organizer-controller.ts");
});
after(() => window.happyDOM.abort());
test("archive filters empty results, resets, and handles one resource", () => {
  assert.equal(
    document.querySelectorAll("[data-tape]:not([hidden])").length,
    12,
  );
  input("[data-archive-search]", "no existe este recurso");
  assert.equal(q("[data-archive-empty]").hidden, false);
  assert.equal(q("[data-archive-caption]").hidden, true);
  q("[data-archive-reset]").click();
  assert.equal(
    document.querySelectorAll("[data-tape]:not([hidden])").length,
    12,
  );
  q('[data-archive-filters] [data-topic="ai"]').click();
  assert.equal(
    document.querySelectorAll("[data-tape]:not([hidden])").length,
    1,
  );
  assert.equal(q("[data-archive-next]").disabled, true);
  q("[data-archive-shelf]").dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
  );
  assert.match(q("[data-active-title]").textContent, /IA/);
  q("[data-archive-reset]").click();
});
test("range and keyboard keep the cover and caption synchronized", () => {
  input("[data-archive-range]", "3");
  assert.match(q("[data-active-title]").textContent, /minimum viable/);
  q("[data-archive-shelf]").dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "End", bubbles: true }),
  );
  assert.match(q("[data-active-title]").textContent, /Reportes/);
  assert.equal(q("[data-archive-range]").value, "12");
  q("[data-archive-shelf]").dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
  );
  assert.equal(q("[data-archive-range]").value, "1");
});
test("resource detail opens the correct original link and restores scrolling", () => {
  q("[data-archive-shelf]").focus();
  q("[data-archive-open]").click();
  assert.equal(q("[data-archive-detail]").open, true);
  assert.match(
    q(".archive-detail__visit").href,
    /what-is-platform-engineering/,
  );
  assert.equal(document.documentElement.style.overflow, "hidden");
  q("[data-archive-close]").click();
  assert.equal(q("[data-archive-detail]").open, false);
  assert.notEqual(document.documentElement.style.overflow, "hidden");
});
test("global search finds organizers, supports accent-insensitive queries and empty results", () => {
  q("[data-search-open]").click();
  assert.equal(q("[data-site-search]").open, true);
  input("[data-site-query]", "Oscar");
  assert.equal(q("[data-site-results]").children.length, 1);
  assert.match(q("[data-site-results] a").href, /community\/#team/);
  input("[data-site-query]", "introduccion");
  assert.ok(q("[data-site-results] a"));
  input("[data-site-query]", "zzzyyyxxx");
  assert.ok(q(".site-search__empty"));
  q("[data-search-close]").click();
  assert.equal(q("[data-site-search]").open, false);
});
test("organizer navigation includes all three people and wraps in both directions", () => {
  const root = q("[data-people-carousel]");
  assert.equal(
    root.querySelector('[data-role="center"]').dataset.short,
    "Josua",
  );
  root.querySelector("[data-people-next]").click();
  assert.equal(
    root.querySelector('[data-role="center"]').dataset.short,
    "Oscar",
  );
  root.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
  );
  assert.equal(
    root.querySelector('[data-role="center"]').dataset.short,
    "Ronald",
  );
  root.querySelector("[data-people-next]").click();
  assert.equal(
    root.querySelector('[data-role="center"]').dataset.short,
    "Josua",
  );
  root.querySelector("[data-people-prev]").click();
  assert.equal(
    root.querySelector('[data-role="center"]').dataset.short,
    "Ronald",
  );
  assert.equal(
    root.querySelectorAll("[data-person-profile]:not([hidden])").length,
    1,
  );
});

test('global shortcut toggles search and arrow keys move focus into results',()=>{
 document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));assert.equal(q('[data-site-search]').open,true);
 input('[data-site-query]','Oscar');q('[data-site-query]').focus();q('[data-site-query]').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));assert.equal(document.activeElement,q('[data-site-results] a'));
 document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown',{key:'/',bubbles:true}));assert.notEqual(document.activeElement,q('[data-archive-search]'));
 document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));assert.equal(q('[data-site-search]').open,false);
});

test('vertical swipes do not change the shelf selection',()=>{
 const shelf=q('[data-archive-shelf]');shelf.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Home',bubbles:true}));
 shelf.dispatchEvent(new window.PointerEvent('pointerdown',{pointerId:1,isPrimary:true,button:0,clientX:150,clientY:100,bubbles:true}));
 shelf.dispatchEvent(new window.PointerEvent('pointermove',{pointerId:1,isPrimary:true,clientX:153,clientY:150,bubbles:true}));
 shelf.dispatchEvent(new window.PointerEvent('pointerup',{pointerId:1,isPrimary:true,clientX:153,clientY:150,bubbles:true}));assert.equal(q('[data-archive-range]').value,'1');
});
