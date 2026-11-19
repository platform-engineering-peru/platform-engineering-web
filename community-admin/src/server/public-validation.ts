import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { ApiError } from "./context";
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validators = new Map<string, ReturnType<Ajv["compile"]>>();
export async function validatePublicExport(type: string, record: unknown) {
  let validate = validators.get(type);
  if (!validate) {
    validate = ajv.compile(
      JSON.parse(
        await readFile(
          resolve(
            "contracts",
            `${type === "memories" ? "memory" : type}-v1.schema.json`,
          ),
          "utf8",
        ),
      ),
    );
    validators.set(type, validate);
  }
  if (!validate(record))
    throw new ApiError(
      422,
      "PUBLIC_SCHEMA_INVALID",
      "La exportación no cumple el contrato público.",
      validate.errors!.map((e) => ({
        path: e.instancePath,
        message: e.message ?? "Campo no válido.",
      })),
    );
}
