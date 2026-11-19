import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { initializeCalendars } from "../src/modules/calendar/controller.ts";

test("calendar keyboard changes day/month and preserves safe links, attribution and unknown duration", () => {
  const window = new Window({
    url: "https://example.org/project/es-pe/calendar/",
  });
  const previous = globalThis.document;
  globalThis.document = window.document;
  try {
    const root = window.document.createElement("section");
    root.dataset.techCalendar = "";
    root.dataset.lang = "en";
    root.dataset.today = "2026-12-31";
    root.dataset.activities = JSON.stringify([
      {
        id: "fixture",
        title: "<img src=x onerror=alert(1)>",
        startsAt: "2027-01-01T02:00:00Z",
        href: "/project/en/events/fixture/",
        time: "21:00",
        venue: "Fixture venue",
        community: "Fixture guest",
        kind: "guest",
        sourceUrl: "https://example.org/activity",
        sourceZone: "UTC",
      },
    ]);
    root.innerHTML =
      '<h2 data-month-label></h2><div data-calendar-controls hidden><button data-month-step="-1"></button><button data-calendar-today></button><button data-month-step="1"></button></div><div data-month-view hidden><div data-calendar-grid></div><h3 data-day-label></h3><div data-day-activities></div></div><div data-month-activities></div>';
    window.document.body.append(root);
    initializeCalendars();
    initializeCalendars();
    assert.equal(
      root.querySelectorAll('[role=gridcell] button[tabindex="0"]').length,
      1,
    );
    assert.equal(
      root.querySelector("[data-month-label]").textContent,
      "December 2026",
    );
    assert.equal(
      root.querySelector("[data-day-activities] a").getAttribute("href"),
      "/project/en/events/fixture/",
    );
    assert.match(
      root.querySelector("[data-day-activities]").textContent,
      /Invited community: Fixture guest/,
    );
    assert.match(
      root.querySelector("[data-day-activities] time").textContent,
      /21:00$/,
    );
    assert.equal(
      root.querySelectorAll("img").length,
      0,
      "Titles must remain escaped text",
    );
    root
      .querySelector('[data-day="2026-12-31"]')
      .dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
        }),
      );
    assert.equal(
      root.querySelector("[data-month-label]").textContent,
      "January 2027",
    );
    assert.equal(window.document.activeElement.dataset.day, "2027-01-01");
    assert.match(
      root.querySelector("[data-month-activities]").textContent,
      /No activities/,
    );
    window.document.activeElement.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "PageUp", bubbles: true }),
    );
    assert.equal(window.document.activeElement.dataset.day, "2026-12-01");
    root.querySelector('[data-month-step="1"]').click();
    assert.equal(
      root.querySelector("[data-month-label]").textContent,
      "January 2027",
    );
  } finally {
    globalThis.document = previous;
    window.happyDOM.abort();
  }
});
