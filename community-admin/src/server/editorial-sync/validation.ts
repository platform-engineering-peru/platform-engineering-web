import { socialSource } from "../../shared/social-source";
import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { hashRevision } from "../../shared/content";
import { entityDefinitions } from "../../shared/product-contract";
import { validatePayload } from "../product-schema";
import { validatePublicExport } from "../public-validation";
import { ApiError } from "../context";
import type { PublicRecord, SnapshotRecord } from "./types";
export const snapshotTypes = ["events", "speakers"];
export const publicTypes = entityDefinitions
  .filter((d) => d.scope === "public")
  .map((d) => d.type);
export const eventPayload = (input: unknown, complete = false) =>
  validatePayload("events", input, complete);
export async function eventProjection(
  id: string,
  input: unknown,
  status: "published" | "archived",
): Promise<PublicRecord> {
  z.string().uuid().parse(id);
  const p = eventPayload(input, true);
  const start = Temporal.ZonedDateTime.from(
    `${p.date}T${p.time}[${p.timeZone}]`,
    { disambiguation: "reject" },
  );
  const end = p.endTime
    ? Temporal.ZonedDateTime.from(`${p.date}T${p.endTime}[${p.timeZone}]`, {
        disambiguation: "reject",
      })
    : null;
  const record = {
    schemaVersion: 1,
    id,
    status,
    updatedAt: null,
    ...p,
    startsAt: start.toInstant().toString(),
    startDate: start.toString({
      timeZoneName: "never",
      calendarName: "never",
      smallestUnit: "second",
    }),
    endsAt: end?.toInstant().toString() ?? null,
    endDate:
      end?.toString({
        timeZoneName: "never",
        calendarName: "never",
        smallestUnit: "second",
      }) ?? null,
  } as PublicRecord;
  if (end && Temporal.Instant.compare(end.toInstant(), start.toInstant()) <= 0)
    throw new ApiError(
      422,
      "VALIDATION_FAILED",
      "El fin debe ser posterior al inicio.",
    );
  await validatePublicExport("events", record);
  return record;
}
export function compareDraft(
  base: PublicRecord | null,
  remote: PublicRecord | null,
) {
  return hashRevision(base) !== hashRevision(remote);
}
export function recordPath(type: string, id: string) {
  if (!publicTypes.includes(type) || !z.string().uuid().safeParse(id).success)
    throw new ApiError(
      422,
      "PATH_NOT_ALLOWED",
      "Solo se permiten registros públicos con identidad estable.",
    );
  return `content/${type}/${id}.json`;
}
export async function validateSnapshot(rows: SnapshotRecord[]) {
  if (rows.length > 3000)
    throw new ApiError(
      422,
      "SNAPSHOT_LIMIT",
      "El inventario supera el límite de lectura.",
    );
  const keys = new Set<string>(),
    orders = new Set<string>(),
    slugs = new Set<string>(),
    urls = new Set<string>();
  for (const { type, record } of rows) {
    recordPath(type, record.id);
    await validatePublicExport(type, record);
    const key = `${type}:${record.id}`;
    if (keys.has(key))
      throw new ApiError(
        422,
        "DUPLICATE_RECORD",
        "Identidad repetida en el inventario.",
      );
    keys.add(key);
    if (type === "events") {
      const def = entityDefinitions.find((d) => d.type === type)!;
      const p = Object.fromEntries(
        def.fields.map((f) => [f.key, record[f.key]]),
      );
      const derived = await eventProjection(record.id, p, record.status);
      for (const key of ["startsAt", "startDate", "endsAt", "endDate"])
        if (record[key] !== undefined && record[key] !== derived[key])
          throw new ApiError(
            422,
            "EVENT_INSTANT_MISMATCH",
            "Los instantes no coinciden con la fecha/hora y zona del evento.",
          );
    }
    if (record.status === "archived") continue;
    if (type === "blog") {
      let key: string;
      try {
        const source = socialSource(
          record.sourceNetwork,
          record.sourceUrl,
          record.sourceNetworkLabel,
        );
        key = "blog:" + source.network + ":" + source.canonicalKey;
      } catch {
        throw new ApiError(
          422,
          "SOCIAL_SOURCE_INVALID",
          "El blog contiene un enlace de origen inválido.",
        );
      }
      if (urls.has(key))
        throw new ApiError(
          409,
          "DUPLICATE_SOCIAL_SOURCE",
          "Esta publicación social ya existe en el blog canónico.",
        );
      urls.add(key);
    }

    const group = ["resources", "courses"].includes(type) ? "resources" : type;
    if (record.displayOrder !== undefined) {
      const k = `${group}:${record.displayOrder}`;
      if (orders.has(k))
        throw new ApiError(
          409,
          "DUPLICATE_ORDER",
          "El orden editorial está repetido.",
        );
      orders.add(k);
    }
    if (record.slug) {
      const k = `${type}:${record.slug}`;
      if (slugs.has(k))
        throw new ApiError(409, "DUPLICATE_SLUG", "El slug ya está en uso.");
      slugs.add(k);
    }
    if (["resources", "courses"].includes(type) && record.href) {
      const k = record.href.replace(/\/$/, "");
      if (urls.has(k))
        throw new ApiError(
          409,
          "DUPLICATE_URL",
          "El enlace ya está en el inventario.",
        );
      urls.add(k);
    }
  }
  for (const { type, record } of rows) {
    if (record.status === "archived") continue;
    if (type === "blog") {
      let key: string;
      try {
        const source = socialSource(
          record.sourceNetwork,
          record.sourceUrl,
          record.sourceNetworkLabel,
        );
        key = "blog:" + source.network + ":" + source.canonicalKey;
      } catch {
        throw new ApiError(
          422,
          "SOCIAL_SOURCE_INVALID",
          "El blog contiene un enlace de origen inválido.",
        );
      }
      if (urls.has(key))
        throw new ApiError(
          409,
          "DUPLICATE_SOCIAL_SOURCE",
          "Esta publicación social ya existe en el blog canónico.",
        );
      urls.add(key);
    }

    const def = entityDefinitions.find((d) => d.type === type)!;
    for (const f of def.fields.filter(
      (f) => f.kind === "reference" && f.target !== "media",
    )) {
      const refs = f.multiple
        ? (record[f.key] ?? [])
        : record[f.key]
          ? [record[f.key]]
          : [];
      for (const id of refs)
        if (
          !rows.some(
            (r) =>
              r.type === f.target &&
              r.record.id === id &&
              r.record.status !== "archived",
          )
        )
          throw new ApiError(
            422,
            "REFERENCE_UNKNOWN",
            "Una referencia pública no existe o está archivada.",
            [{ path: f.key, message: "Referencia no disponible." }],
          );
    }
  }
}
