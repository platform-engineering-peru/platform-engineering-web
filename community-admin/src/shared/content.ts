import { createHash } from "node:crypto";
import { z } from "zod";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import publicSchema from "../../contracts/memory-v1.schema.json";
export const localText = (max: number) =>
  z.object({ "es-pe": z.string().max(max), en: z.string().max(max) }).strict();
export const payloadSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: localText(120),
    description: localText(4000),
    media: z
      .array(
        z.object({ assetId: z.string().uuid(), alt: localText(500) }).strict(),
      )
      .min(1)
      .max(1),
    captureYear: z.number().int().min(1).max(9999).nullable(),
    tags: z
      .array(z.string().trim().min(1).max(80))
      .max(20)
      .refine((v) => new Set(v).size === v.length, "Tags must be unique"),
    displayOrder: z.number().int().min(0).max(1_000_000),
  })
  .strict();
export type MemoryPayload = z.infer<typeof payloadSchema>;
export interface VerifiedMedia {
  id: string;
  path: string;
  sha256: string;
  width: number;
  height: number;
  label: string;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const hashRevision = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
function mediaUuid(memoryId: string, assetId: string) {
  const bytes = createHash("sha256")
    .update(`${memoryId}:${assetId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** This allowlist is the only public projection. Database rows are never serialized as content. */
export function buildPublicRecord(
  id: string,
  payload: MemoryPayload,
  updatedAt: string,
  inventory: readonly VerifiedMedia[],
) {
  return {
    schemaVersion: 1,
    id,
    slug: payload.slug,
    status: "published",
    title: payload.title,
    description: payload.description,
    eventId: null,
    capturedAt: null,
    captureYear: payload.captureYear,
    datePrecision: payload.captureYear === null ? "unknown" : "year",
    media: payload.media.map((item) => {
      const asset = inventory.find((a) => a.id === item.assetId);
      if (!asset) throw new Error("Unknown verified media");
      return {
        id: mediaUuid(id, item.assetId),
        path: asset.path,
        width: asset.width,
        height: asset.height,
        alt: item.alt,
        fit: "contain",
        credit: null,
      };
    }),
    tags: payload.tags,
    displayOrder: payload.displayOrder,
    updatedAt,
  };
}
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validatePublic = ajv.compile(publicSchema);
export function publicErrors(record: unknown) {
  if (validatePublic(record)) return [];
  return validatePublic.errors!.map((e) => ({
    path:
      e.instancePath +
      (e.keyword === "required" ? `/${e.params.missingProperty}` : ""),
    message: e.message ?? "Invalid field",
  }));
}
