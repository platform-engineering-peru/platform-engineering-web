import test from "node:test";
import assert from "node:assert/strict";
import {
  recordCoverSource,
  trustedPreviewPath,
  orderManagerRecords,
} from "../src/web/record-cover";
const sprite = "e4cfb5a2-97cf-8f26-8b20-3bff4883f661",
  photo = "d2421d0d-172e-850d-bb69-4bf31cef4d85";
test("organizers use identity-bound figurines exclusively, never portrait fallback", () => {
  assert.equal(
    recordCoverSource({
      type: "organizers",
      payload: { figurineAssetId: sprite, photoAssetId: photo },
    }),
    `/api/media/${sprite}`,
  );
  assert.equal(
    recordCoverSource({ type: "organizers", payload: { photoAssetId: photo } }),
    null,
  );
});
test("brand previews prefer approved inventory previewPath and image-only path fallback", () => {
  const path = "brand/kit/02-banners-social/linkedin-cover-1584x396.svg";
  assert.equal(
    recordCoverSource({
      id: sprite,
      type: "brands",
      payload: { previewPath: path, path: "brand/kit/source.zip" },
    }),
    `/api/brand-assets/${sprite}/preview`,
  );
  assert.equal(
    recordCoverSource({
      id: sprite,
      type: "brands",
      payload: { path: "brand/social/meetup.svg" },
    }),
    `/api/brand-assets/${sprite}/preview`,
  );
  assert.equal(
    recordCoverSource({
      id: sprite,
      type: "brands",
      payload: { path: "brand/source.zip" },
    }),
    null,
  );
});
test("cover URLs reject arbitrary hosts, schemes, traversal, unknown roots and encoded separators", () => {
  for (const path of [
    "https://host/image.svg",
    "javascript:alert(1)",
    "//host/a.svg",
    "/brand/a.svg",
    "brand/../a.svg",
    "brand/%2e%2e/a.svg",
    "brand/a\\b.svg",
    "private/a.png",
    "brand/a.svg?x=1",
    "brand/a.svg#id",
  ])
    assert.equal(trustedPreviewPath(path), null, path);
  assert.equal(
    recordCoverSource({
      type: "memories",
      payload: { media: [{ assetId: "../secrets" }] },
    }),
    null,
  );
});

test("organizer cards follow explicit editorial order without mutating records or other managers", () => {
  const records = [
    { id: "oscar", payload: { displayOrder: 20 } },
    { id: "ronald", payload: { displayOrder: 30 } },
    { id: "josua", payload: { displayOrder: 10 } },
  ];
  assert.deepEqual(
    orderManagerRecords(records, "organizers").map((r) => r.id),
    ["josua", "oscar", "ronald"],
  );
  assert.deepEqual(
    records.map((r) => r.id),
    ["oscar", "ronald", "josua"],
  );
  assert.equal(orderManagerRecords(records, "brands"), records);
});

test("public speakers use their record-bound existing photo without an inventory rewrite", () => {
  for (const path of [
    "speakers/grecia-vargas.jpg",
    "speakers/danielle-nascimento.jpg",
  ])
    assert.equal(
      recordCoverSource({
        id: photo,
        type: "speakers",
        payload: { photo: path },
      }),
      `/api/speaker-assets/${photo}/preview`,
    );
  assert.equal(
    recordCoverSource({
      type: "speakers",
      payload: { photo: "speakers/grecia-vargas.jpg" },
    }),
    null,
  );
  assert.equal(
    recordCoverSource({
      id: photo,
      type: "speakers",
      payload: { photo: "javascript:alert(1)" },
    }),
    null,
  );
});

test("speaker external portraits retain only the existing trusted HTTPS host", () => {
  const photo = "https://img.evbuc.com/existing-portrait.jpg?h=294&w=294";
  assert.equal(
    recordCoverSource({ type: "speakers", payload: { photo } }),
    photo,
  );
  for (const unsafe of [
    "https://untrusted.example/portrait.jpg",
    "https://img.evbuc.com.evil.test/p.jpg",
    "http://img.evbuc.com/p.jpg",
    "https://user:pass@img.evbuc.com/p.jpg",
  ])
    assert.equal(
      recordCoverSource({ type: "speakers", payload: { photo: unsafe } }),
      null,
    );
});
