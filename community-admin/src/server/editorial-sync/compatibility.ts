import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ApiError } from "../context";
const publicTypes = [
  "events",
  "speakers",
  "organizers",
  "resources",
  "courses",
  "settings",
  "brands",
  "memories",
  "blog",
];
const sharedSchemas = publicTypes.filter(
  (t) => !["memories", "blog"].includes(t),
);
const allowedFiles = [
  "src/pages/[lang]/calendar/index.astro",
  "src/pages/[lang]/blog/index.astro",
  "src/pages/[lang]/blog/[slug].astro",
  "src/modules/events/view.ts",
  "src/modules/calendar/view.ts",
  "src/modules/calendar/model.ts",
  "src/modules/calendar/controller.ts",
  "src/modules/calendar/calendar.css",
  "src/modules/calendar/Calendar.astro",
  "src/modules/blog/blog.css",
  "src/modules/blog/BlogList.astro",
  "src/modules/blog/BlogDetail.astro",
  "src/i18n/locales/es-pe.json",
  "src/i18n/locales/en.json",
  "src/data/blog.ts",
  "src/data/blog-model.ts",
  "src/components/layout/Header.astro",
  "src/data/public-content.ts",
  "src/data/events.ts",
  "src/data/speakers.ts",
  "src/data/organizers.ts",
  "src/data/resources.ts",
  "src/data/site.ts",
  "src/data/memories.ts",
  "src/data/memories-contract.ts",
  "src/modules/branding/Branding.astro",
  "src/modules/memories/Memories.astro",
  "content/schema-version.json",
  "content/memories-legacy.json",
];
const notReady = () =>
  new ApiError(
    409,
    "WEBSITE_RENDERER_NOT_READY",
    "El sitio todavía no tiene los lectores públicos compatibles para esta selección.",
  );
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** A request-scoped verifier. All bytes are keyed by the caller's immutable commit. */
export function rendererVerifier(
  readRemote: (path: string) => Promise<Buffer>,
  trustedDescriptor = () =>
    readFile("contracts/publication-compatibility.json"),
  readSchema = (name: string) => readFile(`contracts/${name}-v1.schema.json`),
) {
  const remote = new Map<string, Promise<Buffer>>(),
    schemas = new Map<string, Promise<Buffer>>();
  const get = (path: string) => {
    if (!remote.has(path)) remote.set(path, readRemote(path));
    return remote.get(path)!;
  };
  const schema = (name: string) => {
    if (!schemas.has(name)) schemas.set(name, readSchema(name));
    return schemas.get(name)!;
  };
  const descriptor = trustedDescriptor().then((bytes) => {
    try {
      const value = JSON.parse(bytes.toString("utf8"));
      if (
        value.schemaVersion !== 1 ||
        !value.types ||
        Object.keys(value).some(
          (k) => !["schemaVersion", "types"].includes(k),
        ) ||
        Object.keys(value.types).some((k) => !publicTypes.includes(k))
      )
        throw notReady();
      return { bytes, value };
    } catch {
      throw notReady();
    }
  });
  return {
    async verify(types: string[]) {
      if (!types.length || types.some((t) => !publicTypes.includes(t)))
        throw notReady();
      const { bytes, value } = await descriptor;
      const selected = new Set(types);
      if (selected.has("events")) selected.add("speakers");
      if (selected.has("resources") || selected.has("courses")) {
        selected.add("resources");
        selected.add("courses");
      }
      if (selected.has("memories")) {
        selected.add("events");
        selected.add("speakers");
      }
      for (const type of selected) {
        const entry = value.types[type];
        if (!entry?.requiredFiles || !Object.keys(entry.requiredFiles).length)
          throw notReady();
      }
      if (
        digest(await get("content/publication-compatibility.json")) !==
        digest(bytes)
      )
        throw notReady();
      const neededSchemas = new Set([
        ...sharedSchemas,
        ...(selected.has("memories") ? ["memories"] : []),
        ...(selected.has("blog") ? ["blog"] : []),
      ]);
      for (const type of neededSchemas) {
        const entry = value.types[type],
          name = type === "memories" ? "memory" : type,
          path = `content/schemas/${name}-v1.schema.json`;
        if (
          !entry ||
          entry.schemaPath !== path ||
          Object.keys(entry).some(
            (k) => !["schemaPath", "schemaSha256", "requiredFiles"].includes(k),
          )
        )
          throw notReady();
        const local = await schema(name);
        if (
          entry.schemaSha256 !== digest(local) ||
          digest(await get(path)) !== digest(local)
        )
          throw notReady();
      }
      for (const type of selected)
        for (const [path, hash] of Object.entries(
          value.types[type].requiredFiles,
        )) {
          if (
            !allowedFiles.includes(path) ||
            typeof hash !== "string" ||
            !/^[a-f0-9]{64}$/.test(hash) ||
            digest(await get(path)) !== hash
          )
            throw notReady();
        }
    },
  };
}
