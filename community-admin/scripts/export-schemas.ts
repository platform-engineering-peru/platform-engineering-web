import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { entityDefinitions } from "../src/shared/product-contract";
import { publishedSchema } from "../src/server/product-schema";
for (const def of entityDefinitions.filter(
  (d) => d.scope === "public" && d.type !== "memories",
)) {
  const schema = publishedSchema(def.type) as any;
  if (def.type === "organizers") {
    schema.properties.photo = { type: "string" };
    schema.properties.figurine = { type: "string" };
    schema.required.push("photo", "figurine");
  }
  for (const target of ["contracts", process.env.WEBSITE_SCHEMA_DIR].filter(
    Boolean,
  ) as string[]) {
    await mkdir(target, { recursive: true });
    await writeFile(
      resolve(target, `${def.type}-v1.schema.json`),
      JSON.stringify(schema, null, 2) + "\n",
    );
  }
}
