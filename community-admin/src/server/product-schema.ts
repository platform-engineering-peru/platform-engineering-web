import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import {
  entityDefinitions,
  type ProductField,
} from "../shared/product-contract";
import { ApiError } from "./context";
import { socialSource } from "../shared/social-source";
const local = z
  .object({ "es-pe": z.string().max(4000), en: z.string().max(4000) })
  .strict();
export const publicUrlPattern =
  "^https://(?![^/]*@)(?!localhost(?::|/|$)|[^/]*\\.(?:localhost|local|internal)(?::|/|$)|\\[|[0-9]{1,3}(?:\\.[0-9]{1,3}){3}(?::|/|$))[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::443)?(?:[/?#][^\\s]*)?$";
const safeUrl = z
  .string()
  .max(2048)
  .refine(
    (v) =>
      v === "" ||
      (new RegExp(publicUrlPattern, "i").test(v) &&
        (() => {
          try {
            const u = new URL(v);
            return (
              !u.username &&
              !u.password &&
              !u.hostname.includes(":") &&
              !/^[0-9.]+$/.test(u.hostname) &&
              !u.hostname.endsWith(".local") &&
              !u.hostname.endsWith(".localhost") &&
              !u.hostname.endsWith(".internal") &&
              u.hostname !== "localhost"
            );
          } catch {
            return false;
          }
        })()),
    "Usa una URL HTTPS pública, sin credenciales ni direcciones privadas.",
  );
const sponsorUrl = z
  .string()
  .max(2048)
  .refine(
    (v) =>
      safeUrl.safeParse(v).success ||
      /^mailto:[^\s@?#]+@[^\s@?#]+\.[^\s@?#]+$/.test(v),
    "Usa HTTPS o un único correo público mailto.",
  );
const link = z.object({ label: z.string().max(120), href: safeUrl }).strict();
const memoryMedia = z
  .object({
    assetId: z.string().uuid(),
    alt: local,
    fit: z.enum(["contain", "cover"]).default("contain"),
    credit: z.string().max(500).nullable().default(null),
    focalPoint: z
      .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
function fieldSchema(f: ProductField): z.ZodType {
  if (f.key === "sourceNetworkLabel") return z.string().max(120);
  if (f.key === "links") return z.array(link).max(20);
  if (f.key === "communityLinks")
    return z
      .object(
        Object.fromEntries(
          ["whatsapp", "meetup", "linkedin", "youtube", "cfp", "sponsor"].map(
            (k) => [k, (k === "sponsor" ? sponsorUrl : safeUrl).nullable()],
          ),
        ),
      )
      .strict();
  if (f.key === "globalLinks")
    return z
      .object(
        Object.fromEntries(
          [
            "home",
            "whatIs",
            "blog",
            "tooling",
            "reports",
            "university",
            "introCourse",
            "platformcon",
            "platformWeekly",
          ].map((k) => [k, safeUrl]),
        ),
      )
      .strict();
  if (f.key === "contactPoints")
    return z
      .array(
        z
          .object({
            type: z.enum(["email", "phone", "url"]),
            value: z.string().max(500),
            visibility: z.enum(["private", "restricted"]).default("private"),
            provenance: z.string().max(1000),
            permissionBasis: z.string().max(1000),
          })
          .strict(),
      )
      .max(20);
  if (f.key === "body")
    return z
      .object({ "es-pe": z.string().max(20000), en: z.string().max(20000) })
      .strict();
  if (f.kind === "localized")
    return f.key === "title"
      ? z
          .object({ "es-pe": z.string().max(120), en: z.string().max(120) })
          .strict()
      : local;
  if (f.kind === "boolean") return z.boolean();
  if (f.kind === "number") {
    const n = z
      .number()
      .int()
      .min(0)
      .max(f.key === "captureYear" ? 9999 : 1_000_000);
    return f.nullable ? n.nullable() : n;
  }
  if (f.kind === "tags")
    return z
      .array(z.string().min(1).max(100))
      .max(100)
      .refine((a) => new Set(a).size === a.length, "Duplicate values");
  if (f.kind === "reference")
    return f.multiple
      ? z.array(z.string().uuid()).max(100)
      : z.string().uuid().nullable();
  if (f.kind === "media") return z.array(memoryMedia).max(30);
  if (f.kind === "select") return z.enum(f.options as [string, ...string[]]);
  if (f.kind === "url") return f.nullable ? safeUrl.nullable() : safeUrl;
  if (f.key === "slug")
    return z
      .string()
      .max(120)
      .regex(/^[a-z0-9]*(?:-[a-z0-9]+)*$/);
  if (f.key === "capturedAt")
    return z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable();
  return z.string().max(f.kind === "textarea" ? 10000 : 2000);
}
export const inputSchemas = Object.fromEntries(
  entityDefinitions.map((d) => [
    d.type,
    z
      .object(
        Object.fromEntries(
          d.fields.map((f) => [
            f.key,
            f.optional ? fieldSchema(f).optional() : fieldSchema(f),
          ]),
        ),
      )
      .strict(),
  ]),
);
export function definition(type: string) {
  const d = entityDefinitions.find((d) => d.type === type);
  if (!d) throw new ApiError(404, "UNKNOWN_ENTITY", "Módulo no encontrado.");
  return d;
}
export function validatePayload(
  type: string,
  input: unknown,
  publish = false,
): Record<string, any> {
  const def = definition(type),
    payload = inputSchemas[type].parse(input) as Record<string, any>;
  const errors: { path: string; message: string }[] = [];
  if (
    type === "events" &&
    payload.communityKind === "guest" &&
    (!payload.communityName?.trim() || !payload.communityUrl)
  )
    errors.push({
      path: "/communityName",
      message: "Una comunidad invitada necesita nombre y URL pública.",
    });
  if (type === "blog") {
    try {
      socialSource(
        payload.sourceNetwork,
        payload.sourceUrl,
        payload.sourceNetworkLabel,
      );
    } catch {
      errors.push({
        path: "/sourceUrl",
        message: "Indica un enlace publicado válido de la red seleccionada.",
      });
    }
    if (
      !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(payload.sourcePublishedAt) ||
      !Number.isFinite(Date.parse(payload.sourcePublishedAt))
    )
      errors.push({
        path: "/sourcePublishedAt",
        message: "Indica la fecha original con zona explícita.",
      });
  }

  if (publish) {
    if (
      type === "settings" &&
      (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.contactEmail) ||
        Object.values(payload.globalLinks).some((v) => !v))
    )
      errors.push({
        path: "/globalLinks",
        message: "Completa el correo público y todos los enlaces globales.",
      });
    for (const f of def.fields) {
      if (
        f.kind === "localized" &&
        f.required &&
        !["company", "role", "talk", "bio", "prerequisites"].includes(f.key)
      ) {
        for (const lang of ["es-pe", "en"])
          if (!payload[f.key]?.[lang]?.trim())
            errors.push({
              path: `/${f.key}/${lang}`,
              message: "Completa el texto en ambos idiomas.",
            });
      }
    }
    if (!payload.slug?.trim())
      errors.push({ path: "/slug", message: "El slug es obligatorio." });
    if (["resources", "courses"].includes(type) && !payload.href)
      errors.push({ path: "/href", message: "URL obligatoria." });
    if (["organizers", "speakers"].includes(type) && !payload.name?.trim())
      errors.push({ path: "/name", message: "Nombre obligatorio." });
    if (
      publish &&
      type === "organizers" &&
      (!payload.photoAssetId || !payload.figurineAssetId)
    )
      errors.push({
        path: "/photoAssetId",
        message: "Selecciona la foto y figura oficial por identidad.",
      });
    if (
      publish &&
      type === "events" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(payload.date) ||
        Number.isNaN(Date.parse(payload.date)) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(payload.time))
    )
      errors.push({
        path: "/date",
        message: "Indica la fecha y hora local válidas.",
      });
    if (
      payload.photo?.startsWith("https://") &&
      !safeUrl.safeParse(payload.photo).success
    )
      errors.push({ path: "/photo", message: "Usa una imagen pública HTTPS." });
    for (const key of ["photo", "path", "originalPath", "previewPath"])
      if (
        payload[key] &&
        !payload[key].startsWith("https://") &&
        (!/^[a-zA-Z0-9][a-zA-Z0-9/_ .-]+$/.test(payload[key]) ||
          payload[key].split("/").includes(".."))
      )
        errors.push({
          path: `/${key}`,
          message: "Ruta pública relativa no válida.",
        });
    if (type === "memories") {
      if (!payload.media.length)
        errors.push({ path: "/media", message: "Agrega al menos una imagen." });
      payload.media.forEach((m: any, i: number) => {
        for (const lang of ["es-pe", "en"])
          if (!m.alt[lang]?.trim())
            errors.push({
              path: `/media/${i}/alt/${lang}`,
              message: "Agrega texto alternativo.",
            });
      });
    }
  }
  if (type === "memories") {
    if (
      payload.datePrecision === "unknown" &&
      (payload.capturedAt !== null || payload.captureYear !== null)
    )
      errors.push({
        path: "/capturedAt",
        message: "Una fecha desconocida no debe inventarse.",
      });
    if (
      payload.datePrecision === "year" &&
      (payload.capturedAt !== null || !payload.captureYear)
    )
      errors.push({
        path: "/captureYear",
        message: "Indica solo el año conocido.",
      });
    if (
      payload.datePrecision === "day" &&
      (!payload.capturedAt ||
        Number(payload.capturedAt.slice(0, 4)) !== payload.captureYear ||
        Number.isNaN(Date.parse(payload.capturedAt)))
    )
      errors.push({
        path: "/capturedAt",
        message: "Fecha y año incompatibles.",
      });
  }
  if (payload.timeZone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: payload.timeZone });
    } catch {
      errors.push({ path: "/timeZone", message: "Zona IANA no válida." });
    }
  }
  if (type === "courses" && payload.type !== "course")
    errors.push({
      path: "/type",
      message: "El módulo de cursos requiere tipo course.",
    });
  if (type === "resources" && payload.type === "course")
    errors.push({
      path: "/type",
      message: "Usa el módulo de cursos para agregar un curso.",
    });
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email))
    errors.push({ path: "/email", message: "Correo no válido." });
  if (type === "events" && payload.date && payload.time) {
    try {
      Temporal.ZonedDateTime.from(
        `${payload.date}T${payload.time}[${payload.timeZone}]`,
        { disambiguation: "reject" },
      );
      if (
        payload.endTime &&
        Temporal.ZonedDateTime.from(
          `${payload.date}T${payload.endTime}[${payload.timeZone}]`,
          { disambiguation: "reject" },
        ).epochMilliseconds <=
          Temporal.ZonedDateTime.from(
            `${payload.date}T${payload.time}[${payload.timeZone}]`,
            { disambiguation: "reject" },
          ).epochMilliseconds
      )
        errors.push({
          path: "/endTime",
          message: "El fin debe ser posterior al inicio.",
        });
    } catch {
      errors.push({
        path: "/time",
        message:
          "La fecha/hora no existe o es ambigua en esa zona. Indica una hora inequívoca.",
      });
    }
  }
  for (const key of ["startsAt", "endsAt", "dueAt", "grantedAt", "revokedAt"])
    if (payload[key]) {
      if (
        !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(payload[key]) ||
        !Number.isFinite(Date.parse(payload[key]))
      )
        errors.push({
          path: `/${key}`,
          message: "Usa un instante ISO con offset explícito.",
        });
      else payload[key] = new Date(payload[key]).toISOString();
    }
  if (type === "courses") {
    if (payload.amount && !/^\d+(\.\d{1,2})?$/.test(payload.amount))
      errors.push({ path: "/amount", message: "Importe decimal no válido." });
    if (payload.currency && !/^[A-Z]{3}$/.test(payload.currency))
      errors.push({
        path: "/currency",
        message: "Usa una moneda ISO de tres letras.",
      });
    if (payload.priceModel === "paid" && (!payload.amount || !payload.currency))
      errors.push({
        path: "/amount",
        message: "Un precio de pago necesita importe y moneda.",
      });
  }
  if (type === "sessions" && (payload.startsAt || payload.endsAt)) {
    if (
      !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(payload.startsAt) ||
      !Number.isFinite(Date.parse(payload.startsAt)) ||
      !Number.isFinite(Date.parse(payload.endsAt)) ||
      Date.parse(payload.endsAt) <= Date.parse(payload.startsAt)
    )
      errors.push({
        path: "/startsAt",
        message:
          "La sesión necesita instantes con zona y fin posterior al inicio.",
      });
  }
  if (errors.length)
    throw new ApiError(
      422,
      "CONTENT_INVALID",
      "Revisa los campos indicados.",
      errors,
    );
  return payload;
}
export const publishedSchema = (type: string) => {
  const s = z.toJSONSchema(inputSchemas[type], { target: "draft-7" }) as any;
  for (const f of definition(type).fields) {
    if (f.kind === "url")
      s.properties[f.key] = f.nullable
        ? {
            anyOf: [
              { type: "null" },
              {
                type: "string",
                maxLength: 2048,
                anyOf: [
                  { const: "" },
                  { pattern: publicUrlPattern, format: "uri" },
                ],
              },
            ],
          }
        : {
            type: "string",
            maxLength: 2048,
            anyOf: [
              { const: "" },
              { pattern: publicUrlPattern, format: "uri" },
            ],
          };
  }
  if (type === "settings")
    for (const k of [
      "whatsapp",
      "meetup",
      "linkedin",
      "youtube",
      "cfp",
      "sponsor",
    ])
      s.properties.communityLinks.properties[k] = {
        anyOf: [
          { type: "null" },
          {
            type: "string",
            pattern:
              k === "sponsor"
                ? `(?:${publicUrlPattern})|(?:^mailto:[^\\s@?#]+@[^\\s@?#]+\\.[^\\s@?#]+$)`
                : publicUrlPattern,
            maxLength: 2048,
          },
        ],
      };
  if (type === "settings") {
    s.properties.contactEmail = { type: "string", format: "email" };
    for (const key of Object.keys(s.properties.globalLinks.properties))
      s.properties.globalLinks.properties[key] = {
        type: "string",
        format: "uri",
        pattern: publicUrlPattern,
      };
  }
  if (type === "events")
    for (const key of ["startsAt", "endsAt", "startDate", "endDate"])
      s.properties[key] = {
        anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
      };
  if (type === "blog") {
    for (const key of ["title", "description", "body"])
      for (const lang of ["es-pe", "en"])
        s.properties[key].properties[lang].minLength = 1;
    s.properties.slug.minLength = 1;
    s.properties.sourcePublishedAt = {
      type: "string",
      format: "date-time",
      pattern: "T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$",
    };
    s.properties.sourceUrl = {
      type: "string",
      maxLength: 2048,
      pattern: publicUrlPattern,
      format: "uri",
    };
  }
  if (type === "events")
    s.allOf = [
      {
        if: {
          properties: { communityKind: { const: "guest" } },
          required: ["communityKind"],
        },
        then: {
          required: ["communityName", "communityUrl"],
          properties: {
            communityName: { type: "string", minLength: 1, maxLength: 2000 },
            communityUrl: {
              type: "string",
              pattern: publicUrlPattern,
              format: "uri",
            },
          },
        },
      },
    ];
  if (type === "blog")
    s.allOf = [
      {
        if: {
          properties: { sourceNetwork: { const: "other" } },
          required: ["sourceNetwork"],
        },
        then: {
          required: ["sourceNetworkLabel"],
          properties: {
            sourceNetworkLabel: {
              type: "string",
              minLength: 1,
              maxLength: 120,
            },
          },
        },
      },
    ];
  return {
    ...(s.allOf ? { allOf: s.allOf } : {}),
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "id", "status", "updatedAt", ...s.required],
    properties: {
      schemaVersion: { const: 1 },
      id: { type: "string", format: "uuid" },
      status: { enum: ["published", "archived"] },
      updatedAt: {
        anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
      },
      ...s.properties,
    },
  };
};
