import test from "node:test";
import assert from "node:assert/strict";
import { socialSource } from "../src/shared/social-source";
import { entityDefinitions } from "../src/shared/product-contract";
import { validatePayload } from "../src/server/product-schema";

test("social permalink identity preserves post identity while removing only tracking", () => {
  const source = socialSource(
    "youtube",
    "https://WWW.youtube.com:443/watch?v=ABC_1234567&utm_source=test#share",
  );
  assert.equal(
    source.canonicalKey,
    "https://www.youtube.com/watch?v=ABC_1234567",
  );
  assert.equal(
    source.sourceUrl,
    "https://WWW.youtube.com:443/watch?v=ABC_1234567&utm_source=test#share",
  );
  assert.notEqual(
    source.canonicalKey,
    socialSource("youtube", "https://www.youtube.com/watch?v=XYZ_1234567")
      .canonicalKey,
  );
  assert.equal(
    socialSource(
      "linkedin",
      "https://www.linkedin.com/feed/update/urn:li:activity:123456789/",
    ).network,
    "linkedin",
  );
});
test("confirmation rejects mismatched networks, composers, profiles, credentials and private hosts", () => {
  for (const [network, url] of [
    ["linkedin", "https://www.linkedin.com/in/person/"],
    ["linkedin", "https://www.linkedin.com/feed/"],
    ["linkedin", "https://www.linkedin.com/sharing/share-offsite/?url=x"],
    ["linkedin", "https://youtube.com/watch?v=ABC_1234567"],
    ["other", "http://example.org/post"],
    ["other", "https://user:pass@example.org/post"],
    ["other", "https://127.0.0.1/post"],
    ["other", "https://[::1]/post"],
    ["other", "https://localhost/post"],
    ["other", "https://internal.local/post"],
  ])
    assert.throws(() => socialSource(network, url, "Network"), url);
  assert.throws(() =>
    socialSource(
      "other",
      "https://www.linkedin.com/in/person/",
      "Another network",
    ),
  );
  assert.throws(() =>
    socialSource("other", "https://community.example/posts/1"),
  );
  assert.equal(
    socialSource(
      "other",
      "https://community.example/posts/Case?identity=A&fbclid=x",
      "Community",
    ).canonicalKey,
    "https://community.example/posts/Case?identity=A",
  );
});
test("optional event attribution preserves legacy absence and requires explicit guest evidence", () => {
  const defaults = structuredClone(
    entityDefinitions.find((d) => d.type === "events")!.defaults,
  );
  assert.equal(
    Object.hasOwn(validatePayload("events", defaults), "communityKind"),
    false,
  );
  assert.equal(
    validatePayload("events", { ...defaults, communityKind: "own" })
      .communityKind,
    "own",
  );
  assert.throws(() =>
    validatePayload("events", {
      ...defaults,
      communityKind: "guest",
      communityName: "Guest",
      communityUrl: null,
    }),
  );
  assert.equal(
    validatePayload("events", {
      ...defaults,
      communityKind: "guest",
      communityName: "Guest",
      communityUrl: "https://community.example/",
      activityUrl: null,
    }).communityName,
    "Guest",
  );
});

test("LinkedIn adapter-produced encoded share and activity URNs remain valid exact identities", () => {
  for (const urn of [
    "urn:li:share:123456789",
    "urn:li:ugcPost:123456789",
    "urn:li:activity:123456789",
  ]) {
    const url =
      "https://www.linkedin.com/feed/update/" + encodeURIComponent(urn);
    assert.equal(socialSource("linkedin", url).canonicalKey, url);
  }
});

test("both event projectors preserve guest attribution and unknown duration with the same source-zone instant", async () => {
  const { eventProjection } =
    await import("../src/server/editorial-sync/validation");
  const { projectPublicRecord } = await import("../src/server/export");
  const payload = {
    ...structuredClone(
      entityDefinitions.find((d) => d.type === "events")!.defaults,
    ),
    slug: "guest-fixture",
    title: { "es-pe": "Actividad invitada", en: "Guest activity" },
    description: {
      "es-pe": "Descripción revisada",
      en: "Reviewed description",
    },
    city: { "es-pe": "En línea", en: "Online" },
    date: "2027-01-01",
    time: "09:00",
    endTime: "",
    timeZone: "Asia/Tokyo",
    communityKind: "guest",
    communityName: "Guest community",
    communityUrl: "https://community.example/",
    activityUrl: "https://community.example/events/1",
  };
  const id = "20000000-0000-4000-8000-000000000099",
    draft = await eventProjection(id, payload, "published"),
    generic = await projectPublicRecord({} as any, "fixture", {
      id,
      type: "events",
      payload,
      state: "approved",
      desired_status: "published",
      updated_at: "2026-11-18T00:00:00Z",
    });
  for (const key of [
    "startsAt",
    "endsAt",
    "startDate",
    "endDate",
    "communityKind",
    "communityName",
    "communityUrl",
    "activityUrl",
  ])
    assert.deepEqual(draft[key], generic[key]);
  assert.equal(draft.startsAt, "2027-01-01T00:00:00Z");
  assert.equal(draft.endsAt, null);
  const invalid = {
    ...payload,
    date: "2026-03-08",
    time: "02:30",
    timeZone: "America/New_York",
  };
  await assert.rejects(() => eventProjection(id, invalid, "published"));
  await assert.rejects(() =>
    projectPublicRecord({} as any, "fixture", {
      id,
      type: "events",
      payload: invalid,
      state: "approved",
      updated_at: "2026-11-18T00:00:00Z",
    }),
  );
});

test("canonical direct publication rejects the same social source under two blog IDs across installations", async () => {
  const { validateSnapshot } =
    await import("../src/server/editorial-sync/validation");
  const common = {
    schemaVersion: 1,
    status: "published",
    updatedAt: null,
    title: { "es-pe": "Publicación", en: "Post" },
    description: { "es-pe": "Resumen", en: "Excerpt" },
    body: { "es-pe": "Texto", en: "Text" },
    sourceNetwork: "linkedin",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:9999999/",
    sourcePublishedAt: "2026-11-18T10:00:00-05:00",
    sourceLanguage: "en",
    tags: [],
  };
  await assert.rejects(
    () =>
      validateSnapshot([
        {
          type: "blog",
          record: {
            ...common,
            id: "20000000-0000-4000-8000-000000000091",
            slug: "post-one",
            displayOrder: 10,
          } as any,
        },
        {
          type: "blog",
          record: {
            ...common,
            id: "20000000-0000-4000-8000-000000000092",
            slug: "post-two",
            displayOrder: 20,
            sourceUrl: common.sourceUrl + "?utm_source=other",
          } as any,
        },
      ]),
    { code: "DUPLICATE_SOCIAL_SOURCE" },
  );
});
