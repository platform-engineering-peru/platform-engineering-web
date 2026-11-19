import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rendererVerifier } from "../src/server/editorial-sync/compatibility";
import { ApiError } from "../src/server/context";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function fixture() {
  const types = [
      "events",
      "speakers",
      "organizers",
      "resources",
      "courses",
      "settings",
      "brands",
      "memories",
      "blog",
    ],
    schemas = new Map(
      types.map((t) => [
        t === "memories" ? "memory" : t,
        Buffer.from("trusted schema " + t),
      ]),
    ),
    files = new Map<string, Buffer>(),
    calls = new Map<string, number>();
  const common = Buffer.from("trusted common reader"),
    reader = Buffer.from("trusted resources reader");
  files.set("src/data/public-content.ts", common);
  files.set("src/data/resources.ts", reader);
  const descriptor: any = { schemaVersion: 1, types: {} };
  for (const type of types) {
    const path = `content/schemas/${type === "memories" ? "memory" : type}-v1.schema.json`,
      bytes = schemas.get(type === "memories" ? "memory" : type)!;
    files.set(path, bytes);
    descriptor.types[type] = {
      schemaPath: path,
      schemaSha256: sha(bytes),
      requiredFiles:
        type === "brands"
          ? {
              "src/modules/branding/Branding.astro": sha(
                Buffer.from("missing brand reader"),
              ),
            }
          : {
              "src/data/public-content.ts": sha(common),
              "src/data/resources.ts": sha(reader),
            },
    };
  }
  const bytes = Buffer.from(JSON.stringify(descriptor));
  files.set("content/publication-compatibility.json", bytes);
  let outage = false;
  const read = async (path: string) => {
    calls.set(path, (calls.get(path) ?? 0) + 1);
    if (outage) throw new ApiError(403, "AUTH_UNAVAILABLE", "Unavailable");
    const value = files.get(path);
    if (!value)
      throw new ApiError(409, "WEBSITE_RENDERER_NOT_READY", "Missing");
    return value;
  };
  return {
    files,
    calls,
    verifier: () =>
      rendererVerifier(
        read,
        async () => bytes,
        async (name) => schemas.get(name)!,
      ),
    outage: () => (outage = true),
  };
}
test("selection readiness ignores unrelated missing readers but checks shared schema closure and deduplicates byte reads", async () => {
  const f = fixture(),
    v = f.verifier();
  await v.verify(["resources"]);
  await v.verify(["courses"]);
  await assert.rejects(v.verify(["brands"]), {
    code: "WEBSITE_RENDERER_NOT_READY",
  });
  for (const count of f.calls.values()) assert.equal(count, 1);
  assert.ok(f.calls.has("content/schemas/brands-v1.schema.json"));
  f.files.delete("content/schemas/brands-v1.schema.json");
  await assert.rejects(f.verifier().verify(["resources"]), {
    code: "WEBSITE_RENDERER_NOT_READY",
  });
});
test("a new immutable-head context rereads changed bytes and auth failures keep their connection reason", async () => {
  const f = fixture();
  await f.verifier().verify(["resources"]);
  f.files.set(
    "src/data/resources.ts",
    Buffer.from("changed unreviewed reader"),
  );
  await assert.rejects(f.verifier().verify(["resources"]), {
    code: "WEBSITE_RENDERER_NOT_READY",
  });
  assert.equal(f.calls.get("src/data/resources.ts"), 2);
  const failure = fixture();
  failure.outage();
  await assert.rejects(failure.verifier().verify(["resources"]), {
    code: "AUTH_UNAVAILABLE",
  });
});

test("blog readiness validates its exact schema and remains blocked without its supported renderer", async () => {
  const f = fixture();
  await f.verifier().verify(["blog"]);
  assert.ok(f.calls.has("content/schemas/blog-v1.schema.json"));
  f.files.delete("content/schemas/blog-v1.schema.json");
  await assert.rejects(f.verifier().verify(["blog"]), {
    code: "WEBSITE_RENDERER_NOT_READY",
  });
  await f.verifier().verify(["resources"]);
});
