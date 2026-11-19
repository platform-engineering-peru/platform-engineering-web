/** Shared serializable form contract; no server code or private data in this module. */
export type FieldKind =
  | "text"
  | "textarea"
  | "localized"
  | "url"
  | "number"
  | "boolean"
  | "select"
  | "tags"
  | "reference"
  | "media"
  | "json";
export interface ProductField {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  options?: string[];
  target?: string;
  nullable?: boolean;
  multiple?: boolean;
  optional?: boolean;
}
export interface EntityDefinition {
  type: string;
  label: string;
  scope: "public" | "private";
  fields: ProductField[];
  defaults: Record<string, unknown>;
}
const text = (
  key: string,
  label: string,
  kind: FieldKind = "text",
  extra: Partial<ProductField> = {},
): ProductField => ({ key, label, kind, ...extra });
const local = (key: string, label: string) =>
  text(key, label, "localized", { required: true });
const ref = (key: string, label: string, target: string, multiple = false) =>
  text(key, label, "reference", { target, multiple, nullable: !multiple });
const order = text("displayOrder", "Orden editorial", "number");
const title = [
  text("slug", "Slug"),
  local("title", "Título"),
  local("description", "Descripción"),
  order,
];
const unknown = { "es-pe": "", en: "" };
const defs: EntityDefinition[] = [];
function define(
  type: string,
  label: string,
  scope: "public" | "private",
  fields: ProductField[],
  defaults: Record<string, unknown>,
) {
  defs.push({ type, label, scope, fields, defaults });
}
define(
  "memories",
  "Memories",
  "public",
  [
    ...title,
    text("media", "Imágenes", "media", { multiple: true, required: true }),
    ref("eventId", "Evento", "events"),
    text("capturedAt", "Fecha conocida (AAAA-MM-DD)"),
    text("captureYear", "Año conocido", "number", { nullable: true }),
    text("datePrecision", "Precisión de fecha", "select", {
      options: ["unknown", "year", "day"],
    }),
    text("tags", "Etiquetas", "tags"),
  ],
  {
    slug: "",
    title: unknown,
    description: unknown,
    displayOrder: 10,
    media: [],
    eventId: null,
    capturedAt: null,
    captureYear: null,
    datePrecision: "unknown",
    tags: [],
  },
);
const resource = [
  ...title,
  text("href", "URL", "url", { required: true }),
  text("type", "Tipo", "select", {
    options: ["guide", "article", "course", "report", "tool"],
  }),
  text("topic", "Tema", "select", {
    options: [
      "fundamentals",
      "idp",
      "golden-paths",
      "devex",
      "teams",
      "ai",
      "career",
    ],
  }),
  text("contentLang", "Idioma del contenido", "select", {
    options: ["es", "en"],
  }),
  text("coverArtKey", "Ilustración oficial", "select", {
    options: [
      "fundamentals:guide",
      "fundamentals:course",
      "idp:article",
      "idp:cage",
      "golden-paths:article",
      "devex:score",
      "devex:article",
      "teams:article",
      "ai:article",
      "career:article",
      "idp:tool",
      "fundamentals:report",
    ],
  }),
  text("tags", "Etiquetas", "tags"),
];
const resourceDefaults = {
  slug: "",
  title: unknown,
  description: unknown,
  displayOrder: 10,
  href: "",
  type: "guide",
  topic: "fundamentals",
  contentLang: "en",
  coverArtKey: "fundamentals:guide",
  tags: [],
};
define("resources", "Recursos", "public", resource, resourceDefaults);
define(
  "courses",
  "Cursos",
  "public",
  [
    ...resource,
    text("provider", "Proveedor"),
    text("level", "Nivel", "select", {
      options: ["introductory", "intermediate", "advanced", "unknown"],
    }),
    text("durationMinutes", "Duración (minutos)", "number", { nullable: true }),
    text("format", "Formato", "select", {
      options: ["self-paced", "live", "hybrid", "unknown"],
    }),
    text("priceModel", "Precio", "select", {
      options: ["free", "paid", "unknown"],
    }),
    text("amount", "Importe decimal (opcional)"),
    text("currency", "Moneda ISO (opcional)"),
    text("certificate", "Certificado", "select", {
      options: ["yes", "no", "unknown"],
    }),
    local("prerequisites", "Requisitos"),
  ],
  {
    ...resourceDefaults,
    type: "course",
    coverArtKey: "fundamentals:course",
    provider: "",
    level: "unknown",
    durationMinutes: null,
    format: "unknown",
    priceModel: "unknown",
    amount: "",
    currency: "",
    certificate: "unknown",
    prerequisites: unknown,
  },
);
define(
  "organizers",
  "Organizadores",
  "public",
  [
    text("slug", "Slug"),
    text("name", "Nombre"),
    text("shortName", "Nombre corto"),
    local("role", "Rol"),
    local("company", "Organización"),
    ref("photoAssetId", "Foto", "media"),
    ref("figurineAssetId", "Figura oficial", "media"),
    text("color", "Color de fondo"),
    text("url", "Perfil público", "url"),
    text("links", "Enlaces públicos", "json"),
    order,
  ],
  {
    slug: "",
    name: "",
    shortName: "",
    role: unknown,
    company: unknown,
    photoAssetId: null,
    figurineAssetId: null,
    color: "#C4B5FD",
    url: "",
    links: [],
    displayOrder: 10,
  },
);
define(
  "speakers",
  "Speakers públicos",
  "public",
  [
    text("slug", "Slug"),
    text("name", "Nombre"),
    local("role", "Rol"),
    local("company", "Organización"),
    local("talk", "Charla"),
    local("bio", "Biografía pública"),
    text("photo", "Ruta o URL de foto pública"),
    text("url", "Perfil público", "url"),
    text("topics", "Temas", "tags"),
    order,
  ],
  {
    slug: "",
    name: "",
    role: unknown,
    company: unknown,
    talk: unknown,
    bio: unknown,
    photo: "",
    url: "",
    topics: [],
    displayOrder: 10,
  },
);
define(
  "blog",
  "Blog",
  "public",
  [
    ...title,
    local("body", "Contenido"),
    text("sourceNetwork", "Red de origen", "select", {
      options: [
        "linkedin",
        "youtube",
        "facebook",
        "instagram",
        "x",
        "tiktok",
        "other",
      ],
    }),
    text("sourceNetworkLabel", "Nombre de otra red", "text", {
      optional: true,
    }),
    text("sourceUrl", "URL publicada", "url"),
    text("sourcePublishedAt", "Fecha original con zona"),
    text("sourceLanguage", "Idioma original", "select", {
      options: ["es-pe", "en", "und"],
    }),
    text("tags", "Etiquetas", "tags"),
  ],
  {
    slug: "",
    title: unknown,
    description: unknown,
    body: unknown,
    displayOrder: 10,
    sourceNetwork: "linkedin",
    sourceNetworkLabel: "",
    sourceUrl: "",
    sourcePublishedAt: "",
    sourceLanguage: "und",
    tags: [],
  },
);
define(
  "events",
  "Eventos",
  "public",
  [
    ...title,
    text("date", "Fecha local AAAA-MM-DD"),
    text("time", "Inicio HH:MM"),
    text("endTime", "Fin HH:MM"),
    text("timeZone", "Zona IANA"),
    local("city", "Ciudad"),
    text("venue", "Sede"),
    text("address", "Dirección"),
    text("online", "En línea", "boolean"),
    text("eventStatus", "Inscripción", "select", {
      options: ["open", "limited", "free", "soldout"],
    }),
    text("organizer", "Organización"),
    text("registerUrl", "Inscripción", "url"),
    ref("speakerIds", "Speakers", "speakers", true),
    text("recording", "Grabación", "url"),
    text("communityKind", "Comunidad propia o invitada", "select", {
      options: ["own", "guest"],
      optional: true,
    }),
    text("communityName", "Nombre de comunidad", "text", { optional: true }),
    text("communityUrl", "URL de comunidad", "url", {
      optional: true,
      nullable: true,
    }),
    text("activityUrl", "URL de actividad", "url", {
      optional: true,
      nullable: true,
    }),
  ],
  {
    slug: "",
    title: unknown,
    description: unknown,
    displayOrder: 10,
    date: "",
    time: "09:00",
    endTime: "",
    timeZone: "America/Lima",
    city: unknown,
    venue: "",
    address: "",
    online: false,
    eventStatus: "open",
    organizer: "",
    registerUrl: "",
    speakerIds: [],
    recording: "",
  },
);
define(
  "settings",
  "Configuración del sitio",
  "public",
  [
    text("slug", "Clave"),
    text("contactEmail", "Correo público del capítulo"),
    text("communityLinks", "Canales públicos", "json"),
    text("globalLinks", "Recursos globales", "json"),
    order,
  ],
  {
    slug: "site",
    contactEmail: "",
    communityLinks: {
      whatsapp: null,
      meetup: null,
      linkedin: null,
      youtube: null,
      cfp: null,
      sponsor: null,
    },
    globalLinks: Object.fromEntries(
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
      ].map((k) => [k, ""]),
    ),
    displayOrder: 0,
  },
);
define(
  "brands",
  "Inventario de marca",
  "public",
  [
    ...title,
    text("path", "Archivo aprobado"),
    text("previewPath", "Archivo de vista previa"),
    text("dimensionsLabel", "Dimensiones visibles"),
    text("usage", "Uso en el sitio", "select", {
      options: [
        "inventory",
        "logo-light",
        "logo-dark",
        "application",
        "social",
        "ukuku",
      ],
    }),
    text("originalPath", "Original descargable"),
    text("kind", "Aplicación", "select", {
      options: ["logo", "source", "merchandise", "social", "other"],
    }),
    text("approved", "Aprobado", "boolean"),
  ],
  {
    slug: "",
    title: unknown,
    description: unknown,
    displayOrder: 10,
    path: "",
    originalPath: "",
    previewPath: "",
    dimensionsLabel: "",
    usage: "inventory",
    kind: "other",
    approved: false,
  },
);
define(
  "people",
  "Contactos",
  "private",
  [
    text("name", "Nombre preferido"),
    text("email", "Correo privado"),
    text("phone", "Teléfono privado"),
    text("location", "Ubicación"),
    text("timeZone", "Zona IANA"),
    text("languages", "Idiomas", "tags"),
    ref("organizationId", "Organización", "organizations"),
    text("stage", "Relación", "select", {
      options: [
        "prospect",
        "contacted",
        "interested",
        "proposed",
        "confirmed",
        "participated",
        "follow-up",
        "declined",
        "inactive",
      ],
    }),
    text("notes", "Notas privadas", "textarea"),
    text("provenance", "Procedencia"),
    text("permissionBasis", "Base de permiso"),
    text("contactPoints", "Puntos de contacto privados", "json"),
  ],
  {
    name: "",
    email: "",
    phone: "",
    location: "",
    timeZone: "America/Lima",
    languages: [],
    organizationId: null,
    stage: "prospect",
    notes: "",
    provenance: "",
    permissionBasis: "",
    contactPoints: [],
  },
);
define(
  "organizations",
  "Organizaciones",
  "private",
  [
    text("name", "Nombre"),
    text("website", "Sitio", "url"),
    text("notes", "Notas privadas", "textarea"),
    text("provenance", "Procedencia"),
  ],
  { name: "", website: "", notes: "", provenance: "" },
);
define(
  "speaker-profiles",
  "Perfiles de speakers",
  "private",
  [
    ref("personId", "Persona", "people"),
    local("publicBio", "Biografía propuesta"),
    text("topics", "Temas", "tags"),
    text("formats", "Formatos", "tags"),
    text("languages", "Idiomas", "tags"),
    text("availability", "Disponibilidad privada", "textarea"),
    text("compensation", "Condiciones privadas", "textarea"),
    text("publicConsent", "Permiso de perfil público", "boolean"),
    text("consentEvidence", "Evidencia del permiso"),
    text("publicUrl", "URL pública", "url"),
    text("publicPhoto", "Foto pública"),
  ],
  {
    personId: null,
    publicBio: unknown,
    topics: [],
    formats: [],
    languages: [],
    availability: "",
    compensation: "",
    publicConsent: false,
    consentEvidence: "",
    publicUrl: "",
    publicPhoto: "",
  },
);
define(
  "proposals",
  "Propuestas",
  "private",
  [
    ref("personId", "Speaker", "people"),
    ref("eventId", "Evento", "events"),
    text("title", "Título"),
    text("abstract", "Resumen", "textarea"),
    text("language", "Idioma", "select", { options: ["es", "en"] }),
    text("durationMinutes", "Minutos", "number"),
    text("audience", "Audiencia"),
    text("format", "Formato"),
    text("equipment", "Equipo necesario"),
    text("status", "Estado", "select", {
      options: ["proposed", "review", "accepted", "declined", "cancelled"],
    }),
    text("notes", "Notas privadas", "textarea"),
  ],
  {
    personId: null,
    eventId: null,
    title: "",
    abstract: "",
    language: "es",
    durationMinutes: 30,
    audience: "",
    format: "talk",
    equipment: "",
    status: "proposed",
    notes: "",
  },
);
define(
  "participations",
  "Participación",
  "private",
  [
    ref("personId", "Persona", "people"),
    ref("eventId", "Evento", "events"),
    ref("proposalId", "Propuesta", "proposals"),
    text("status", "Estado", "select", {
      options: [
        "prospect",
        "invited",
        "interested",
        "proposed",
        "confirmed",
        "participated",
        "declined",
        "cancelled",
      ],
    }),
    text("notes", "Notas", "textarea"),
  ],
  {
    personId: null,
    eventId: null,
    proposalId: null,
    status: "prospect",
    notes: "",
  },
);
define(
  "sessions",
  "Sesiones y agenda",
  "private",
  [
    ref("eventId", "Evento", "events"),
    ref("proposalId", "Propuesta", "proposals"),
    ref("speakerIds", "Personas", "people", true),
    text("title", "Título"),
    text("room", "Sala"),
    text("startsAt", "Inicio ISO con zona"),
    text("endsAt", "Fin ISO con zona"),
    text("timeZone", "Zona IANA"),
    text("status", "Estado", "select", {
      options: ["planned", "confirmed", "cancelled", "completed"],
    }),
    text("recordingConsent", "Consentimiento de grabación", "boolean"),
  ],
  {
    eventId: null,
    proposalId: null,
    speakerIds: [],
    title: "",
    room: "",
    startsAt: "",
    endsAt: "",
    timeZone: "America/Lima",
    status: "planned",
    recordingConsent: false,
  },
);
define(
  "followups",
  "Seguimientos",
  "private",
  [
    ref("personId", "Persona", "people"),
    ref("sessionId", "Sesión", "sessions"),
    text("title", "Tarea"),
    text("dueAt", "Vencimiento ISO"),
    text("timeZone", "Zona IANA"),
    text("status", "Estado", "select", {
      options: ["open", "done", "cancelled"],
    }),
    text("notes", "Notas privadas", "textarea"),
  ],
  {
    personId: null,
    sessionId: null,
    title: "",
    dueAt: "",
    timeZone: "America/Lima",
    status: "open",
    notes: "",
  },
);
define(
  "consents",
  "Permisos y consentimiento",
  "private",
  [
    ref("personId", "Persona", "people"),
    text("purpose", "Finalidad"),
    text("evidence", "Evidencia"),
    text("permissionBasis", "Base de permiso"),
    text("grantedAt", "Fecha ISO"),
    text("revokedAt", "Revocación ISO"),
    text("provenance", "Procedencia"),
  ],
  {
    personId: null,
    purpose: "",
    evidence: "",
    permissionBasis: "",
    grantedAt: "",
    revokedAt: "",
    provenance: "",
  },
);
export const entityDefinitions = defs;
export type ProductRecord = {
  id: string;
  type: string;
  payload: Record<string, any>;
  revision: number;
  revisionHash: string;
  state: string;
  authorId: string;
  updatedAt: string;
  approvedHash: string | null;
};
export const roleCapabilities: Record<string, string[]> = {
  viewer: ["content:read", "operations:read"],
  editor: ["content:read", "content:write"],
  reviewer: ["content:read", "content:review"],
  publisher: [
    "content:read",
    "content:publish",
    "publishing:write",
    "operations:read",
  ],
  coordinator: ["contacts:read", "contacts:write", "community:write"],
  jobs_curator: ["jobs:curate", "content:read", "operations:read"],
  owner: ["*"],
};
