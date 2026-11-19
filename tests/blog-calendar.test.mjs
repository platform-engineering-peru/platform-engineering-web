import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  blogEntries,
  bodyParagraphs,
  sourceLink,
} from "../src/data/blog-model.ts";
import {
  limaDay,
  monthCells,
  shiftMonth,
  shiftDay,
  monthActivities,
  attribution,
  eventInstant,
  eventEnd,
} from "../src/modules/calendar/model.ts";

const post = (slug = "fixture") => ({
  id: slug,
  slug,
  status: "published",
  title: { "es-pe": "Prueba", en: "Fixture" },
  description: { "es-pe": "Resumen", en: "Excerpt" },
  body: { "es-pe": "Texto", en: "Text" },
  sourceNetwork: "linkedin",
  sourceUrl: "https://www.linkedin.com/posts/fixture-activity-123",
  sourcePublishedAt: "2026-11-18T10:00:00-05:00",
  sourceLanguage: "es-pe",
  tags: [],
});
test("public blog schema matches the confirmed source label limit and requires other-network attribution", () => {
  const schema = JSON.parse(
    readFileSync(
      new URL("../content/schemas/blog-v1.schema.json", import.meta.url),
    ),
  );
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const record = {
    ...post(),
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000001",
    updatedAt: null,
    displayOrder: 1,
    sourceNetwork: "other",
    sourceNetworkLabel: "x".repeat(120),
  };
  assert.equal(validate(record), true, ajv.errorsText(validate.errors));
  assert.equal(
    validate({ ...record, sourceNetworkLabel: "x".repeat(121) }),
    false,
    "Source label must share the confirmation limit",
  );
  assert.equal(
    validate({
      ...record,
      sourceNetwork: "linkedin",
      sourceNetworkLabel: "x".repeat(121),
    }),
    false,
    "Known networks must use the same source label limit",
  );
  const { sourceNetworkLabel, ...missing } = record;
  assert.equal(validate(missing), false);
});
test("blog only exposes published records, preserves source identity and orders actual publication instants", () => {
  const older = post("older"),
    newer = { ...post("newer"), sourcePublishedAt: "2026-11-19T01:00:00Z" };
  assert.deepEqual(blogEntries([]), []);
  assert.deepEqual(
    blogEntries([
      older,
      { ...post("archived"), status: "archived" },
      newer,
    ]).map((p) => p.slug),
    ["newer", "older"],
  );
  assert.equal(blogEntries([older])[0].sourceUrl, older.sourceUrl);
});
test("body remains plain text and safe public HTTPS source links retain identity queries", () => {
  assert.deepEqual(
    bodyParagraphs("First\nline\n\n<script>fixture</script>\n\n Last "),
    ["First\nline", "<script>fixture</script>", "Last"],
  );
  assert.equal(
    sourceLink("https://www.youtube.com/watch?v=identity"),
    "https://www.youtube.com/watch?v=identity",
  );
  for (const url of [
    "javascript:alert(1)",
    "http://example.org/a",
    "https://user:pass@example.org/a",
    "https://127.0.0.1/a",
    "https://localhost/a",
    "https://[::1]/a",
  ])
    assert.throws(() => sourceLink(url));
});
test("calendar uses Lima instants across previous day, month and year, independent of browser zone", () => {
  assert.equal(limaDay("2027-01-01T02:00:00Z"), "2026-12-31");
  assert.equal(limaDay("2026-03-01T01:00:00+09:00"), "2026-02-28");
  assert.throws(() => limaDay("not-a-date"));
});
test("legacy event wall times resolve without changing source records; DST gaps and ambiguous times fail", () => {
  assert.equal(
    eventInstant({
      date: "2026-10-24",
      time: "14:00",
      timeZone: "America/Lima",
      startsAt: null,
    }),
    "2026-10-24T19:00:00.000Z",
  );
  assert.throws(() =>
    eventInstant({
      date: "2026-03-08",
      time: "02:30",
      timeZone: "America/New_York",
    }),
  );
  assert.equal(
    eventEnd({
      date: "2026-10-24",
      time: "14:00",
      timeZone: "America/Lima",
      endTime: "18:00",
      endsAt: null,
    }),
    "2026-10-24T23:00:00.000Z",
  );
  assert.equal(
    eventEnd({ date: "2026-10-24", time: "14:00", endTime: "", endsAt: null }),
    undefined,
  );
  assert.throws(() =>
    eventInstant({
      date: "2026-11-01",
      time: "01:30",
      timeZone: "America/New_York",
    }),
  );
});
test("month arithmetic and weekday alignment handle leap days and year boundaries", () => {
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2027-01", -1), "2026-12");
  assert.equal(shiftDay("2028-02-28", 1), "2028-02-29");
  assert.equal(shiftDay("2028-02-29", 1), "2028-03-01");
  const cells = monthCells("2028-02");
  assert.equal(cells.filter(Boolean).length, 29);
  assert.equal(cells[1], "2028-02-01");
  assert.equal(cells.length % 7, 0);
});
test("month agenda uses the same canonical events without invented end times and preserves legacy attribution", () => {
  const activity = {
    id: "one",
    slug: "one",
    startsAt: "2027-01-01T02:00:00Z",
    endsAt: undefined,
    organizer: "Legacy community",
  };
  assert.deepEqual(monthActivities([activity], "2026-12"), [activity]);
  assert.deepEqual(monthActivities([activity], "2027-01"), []);
  assert.equal(activity.endsAt, undefined);
  assert.equal(attribution(activity), "Legacy community");
  assert.equal(
    attribution({
      ...activity,
      communityKind: "guest",
      communityName: "Guest community",
    }),
    "Guest community",
  );
  assert.equal(
    attribution({ communityKind: "own" }),
    "Platform Engineering Perú",
  );
  assert.equal(attribution({}), null);
});
