export type EditorialStatus = {
  mode: "local" | "github";
  configured: boolean;
  remoteWritesEnabled: boolean;
  repository: string | null;
  branch: string | null;
  supportedTypes: string[];
  identity: { login: string; subject: string } | null;
  headCommit: string | null;
  lastFetchedAt: string | null;
  connection: string;
};
export type PublicEvent = Record<string, any> & { id: string; status: string };
export type EditorialSnapshot = {
  recordHashes: Record<string, string>;
  references?: { speakers: { id: string; name: string }[] };
  commit: string;
  fetchedAt: string;
  records: PublicEvent[];
  stale: boolean;
};
export type EditorialDraft = {
  id: string;
  recordId: string;
  type: "events";
  baseCommit: string;
  baseRecordHash: string | null;
  version: number;
  payload: Record<string, any>;
  desiredStatus: "published" | "archived";
  updatedAt: string;
  submission?: {
    id: string;
    state: string;
    branch: string;
    errorCode: string | null;
    reconcileRequired: boolean;
    canEdit: boolean;
    canRetryExact?: boolean;
    publicationMode?: "direct" | "pull-request";
    protocol?: string;
    commitSha?: string;
    commitUrl?: string;
    deployment?: { state: string; sha?: string; url?: string };
  };
  submissionHistory?: {
    id: string;
    state: string;
    publicationMode?: "direct" | "pull-request";
    protocol?: string;
    commitSha?: string;
    commitUrl?: string;
    deployment?: { state: string; sha?: string; url?: string };
    proposal?: { number: number; url: string } | null;
    remote?: { number: number; url: string } | null;
  }[];
  publicationMode?: "direct" | "pull-request";
  protocol?: string;
  commitSha?: string;
  commitUrl?: string;
  deployment?: { state: string; sha?: string; url?: string };
  state:
    | "committed"
    | "deploying"
    | "deployed"
    | "deployment_failed"
    | "conflict"
    | "uncertain"
    | "blocked"
    | "superseded"
    | "local"
    | "conflict"
    | "proposed"
    | "merged"
    | "closed"
    | "preparing"
    | "sending"
    | "unknown"
    | "retryable";
  proposal?: {
    number: number;
    url: string;
    headCommit: string;
    state?: string;
  };
  conflict?: {
    base: PublicEvent | null;
    remote: PublicEvent | null;
    local: Record<string, any>;
    remoteCommit: string;
  };
};
export const editorialStateLabel = (state: EditorialDraft["state"]) =>
  ({
    committed: "Guardado en GitHub · despliegue pendiente",
    deploying: "Desplegando el sitio",
    deployed: "Publicado en el sitio",
    deployment_failed: "El commit está guardado; falló el despliegue",
    uncertain: "Resultado por confirmar · comprueba la publicación",
    blocked: "Publicación bloqueada · tu borrador se conserva",
    superseded: "Una versión posterior sustituyó este contenido",
    local: "Borrador local · sin publicar",
    preparing: "Preparando publicación · pendiente de confirmar",
    sending: "Enviando publicación · pendiente de confirmar",
    unknown: "Resultado por confirmar · comprobar antes de publicar",
    retryable: "Resultado comprobado · puedes reintentar la publicación",
    conflict: "Conflicto · tu borrador se conserva",
    proposed: "PR en revisión · aún no integrado",
    merged: "Integrado en GitHub",
    closed: "PR cerrada sin integrar · borrador conservado",
  })[state];
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${JSON.stringify(key)}:${stableJson(value)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function canonicalRecordHash(
  record: PublicEvent,
): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(stableJson(record)),
      ),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function canonicalEventPayload(
  record: PublicEvent,
  defaults: Record<string, any>,
): Record<string, any> {
  return Object.fromEntries(
    [
      ...new Set([
        ...Object.keys(defaults),
        ...[
          "communityKind",
          "communityName",
          "communityUrl",
          "activityUrl",
        ].filter((key) => record[key] !== undefined),
      ]),
    ].map((key) => [key, structuredClone(record[key] ?? defaults[key])]),
  );
}
/** Only a fetched matching canonical revision confirms that a merged proposal is in the consulted snapshot. */
export function mergedInSnapshot(
  draft: EditorialDraft,
  snapshot: EditorialSnapshot | null,
): boolean {
  if (
    !["merged", "committed", "deployed", "deployment_failed"].includes(
      draft.state,
    ) ||
    !snapshot
  )
    return false;
  const record = snapshot.records.find((r) => r.id === draft.recordId);
  return Boolean(
    record &&
    record.status === draft.desiredStatus &&
    Object.keys(draft.payload).every(
      (key) => stableJson(record[key]) === stableJson(draft.payload[key]),
    ),
  );
}

/** Pending submission proof survives reloads and must take priority over a local draft label. */
export function needsReconciliation(draft: EditorialDraft): boolean {
  return (
    draft.submission?.reconcileRequired === true ||
    ["preparing", "sending", "unknown"].includes(draft.state)
  );
}
export function mayEditDraft(draft: EditorialDraft): boolean {
  return draft.submission?.canEdit !== false && !needsReconciliation(draft);
}
/** PostgreSQL JSONB normalizes key order; dirty checks compare meaning rather than serialization order. */
export function sameEditorialPayload(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}
