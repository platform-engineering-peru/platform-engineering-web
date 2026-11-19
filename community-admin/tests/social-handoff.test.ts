import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SocialHandoff,
  socialConfirmationKey,
} from "../src/web/social-handoff";
test("handoff opens only the official LinkedIn destination and does not invent bilingual copy or publication proof", () => {
  const html = renderToStaticMarkup(
    React.createElement(SocialHandoff, {
      publication: {
        id: "fixture",
        version: 1,
        revision_hash: "a",
        approved_hash: "a",
        state: "approved",
        channel: "linkedin",
        payload: { text: "Original English" },
      },
      actorKey: "fixture",
      csrfToken: "fixture",
      disabled: false,
      onIndexed: () => {},
      onDirty: () => {},
    }),
  );
  assert.match(html, /https:\/\/www.linkedin.com\/feed\//);
  assert.match(html, /noopener noreferrer/);
  assert.match(html, /no confirma/);
  assert.ok(!html.includes('value="Original English"'));
  assert.match(html, /Confirmo que publiqué/);
});
test("manual confirmation replay keeps its captured request identity and never silently refreshes versions", () => {
  const values = new Map<string, string>();
  const store = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
  };
  const a = {
    version: 1,
    revisionHash: "a",
    sourceUrl: "https://example.org/post",
  };
  const first = socialConfirmationKey(store, "actor:pub", a);
  assert.equal(socialConfirmationKey(store, "actor:pub", a), first);
  assert.notEqual(
    socialConfirmationKey(store, "actor:pub", { ...a, version: 2 }),
    first,
  );
});
