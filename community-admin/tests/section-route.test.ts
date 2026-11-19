import test from "node:test";
import assert from "node:assert/strict";
import {
  sectionFromUrl,
  sectionUrl,
  defaultSection,
} from "../src/web/section-route";
test("valid sections survive refresh/auth defaults without changing query or anchor", () => {
  const url = new URL(
    "http://localhost:4455/?other=keep&section=brands#main-content",
  );
  assert.equal(sectionFromUrl(url, "people", false), "brands");
  assert.equal(
    sectionFromUrl(
      new URL("http://localhost/?section=organizers"),
      "overview",
      false,
    ),
    "organizers",
  );
  assert.equal(sectionUrl(url, "calendar").searchParams.get("other"), "keep");
  assert.equal(sectionUrl(url, "calendar").hash, "#main-content");
});
test("invalid routes and fixture memories fail closed to session default", () => {
  for (const section of [
    "../people",
    "https://bad.example",
    "<script>",
    "",
    "memories",
  ])
    assert.equal(
      sectionFromUrl(
        new URL(`http://localhost/?section=${encodeURIComponent(section)}`),
        "calendar",
        false,
      ),
      "calendar",
    );
  assert.equal(
    sectionFromUrl(
      new URL("http://localhost/#fixture-memories"),
      "overview",
      true,
    ),
    "memories",
  );
  assert.equal(
    sectionFromUrl(
      new URL("http://localhost/#fixture-memories"),
      "overview",
      false,
    ),
    "overview",
  );
  assert.equal(
    sectionFromUrl(
      new URL("http://localhost/?section=brands#fixture-memories"),
      "overview",
      true,
    ),
    "brands",
  );
});

test("role defaults apply only when a URL has no valid destination", () => {
  for (const [role, fallback] of [
    ["owner", "overview"],
    ["coordinator", "people"],
    ["jobs_curator", "jobs-candidates"],
    ["publisher", "calendar"],
  ]) {
    assert.equal(defaultSection(role), fallback);
    assert.equal(
      sectionFromUrl(new URL("http://localhost/"), defaultSection(role)),
      fallback,
    );
    assert.equal(
      sectionFromUrl(
        new URL("http://localhost/?section=brands"),
        defaultSection(role),
      ),
      "brands",
    );
  }
});
