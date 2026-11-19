import type { ConfirmationTarget } from "./confirmation-intent";
export type LifecycleModule =
  | "records"
  | "drafts"
  | "editorial-drafts"
  | "jobs"
  | "job-sources"
  | "publications"
  | "media"
  | "video-assets"
  | "changesets";
export type LifecycleAction =
  | "archive"
  | "erase"
  | "discard"
  | "withdraw"
  | "exclude"
  | "reopen"
  | "retire"
  | "cancel"
  | "remove";
export type LifecycleEffect =
  | "local-archive"
  | "private-erasure"
  | "local-discard"
  | "public-withdrawal"
  | "local-exclusion"
  | "review-required"
  | "source-retirement"
  | "unsent-cancellation"
  | "owned-upload-removal";
export type LifecycleTarget = ConfirmationTarget & {
  module: LifecycleModule;
  revisionHash?: string;
};
export type LifecycleCapability = {
  action: LifecycleAction;
  effect: LifecycleEffect;
  allowed: boolean;
  reason: string | null;
  blockers: { code: string; module: string; id: string }[];
  requiresReason: boolean;
  requiresRecentAuth: boolean;
};
export type LifecycleDescriptor = {
  module: LifecycleModule;
  id: string;
  version: number | string;
  state: string;
  actions: LifecycleCapability[];
  remoteEffect: "none" | "publication-required";
  retentionReason: string | null;
};
export function descriptorMatches(
  target: LifecycleTarget,
  descriptor: { module: string; id: string; version: number | string },
) {
  return (
    target.module === descriptor.module &&
    target.id === descriptor.id &&
    target.version === descriptor.version
  );
}
/** Route, method and token policy are fixed by the domain contract, never executable DTO fields. */
export function lifecycleMutation(
  target: LifecycleTarget,
  action: LifecycleAction,
  reason: string,
): {
  path: string;
  method: "POST" | "DELETE";
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
} {
  if (
    !target.id ||
    (["changesets", "media", "video-assets"].includes(target.module)
      ? typeof target.version !== "string" || !target.version
      : !Number.isInteger(target.version) || Number(target.version) < 1)
  )
    throw new Error(
      "La revisión necesaria para esta acción no está disponible.",
    );
  const id = encodeURIComponent(target.id),
    headers = { "If-Match": `"${target.version}"` };
  if (target.module === "records" && ["archive", "erase"].includes(action))
    return {
      path: `/records/${id}/${action === "erase" ? "delete" : "archive"}`,
      method: "POST",
      headers,
      body: { reason },
    };
  if (
    ["drafts", "editorial-drafts"].includes(target.module) &&
    action === "discard"
  )
    return {
      path:
        target.module === "drafts"
          ? `/drafts/${id}`
          : `/editorial/drafts/${id}`,
      method: "DELETE",
      headers,
      body: target.module === "drafts" ? { reason } : undefined,
    };
  if (
    target.module === "jobs" &&
    ["withdraw", "exclude", "reopen"].includes(action)
  )
    return {
      path: `/jobs/${id}/review`,
      method: "POST",
      headers: {},
      body: { version: target.version, decision: action, reason },
    };
  if (target.module === "job-sources" && action === "retire")
    return {
      path: `/job-sources/${id}/retire`,
      method: "POST",
      headers: {},
      body: { version: target.version, reason },
    };
  if (
    target.module === "publications" &&
    action === "cancel" &&
    target.revisionHash
  )
    return {
      path: `/publications/${id}/cancel`,
      method: "POST",
      headers: {},
      body: {
        version: target.version,
        revisionHash: target.revisionHash,
        reason,
      },
    };
  if (
    target.module === "changesets" &&
    action === "cancel" &&
    typeof target.version === "string"
  )
    return {
      path: `/changesets/${id}/cancel`,
      method: "POST",
      headers: {},
      body: { revisionHash: target.version, reason },
    };
  if (
    target.module === "video-assets" &&
    action === "remove" &&
    typeof target.version === "string"
  )
    return {
      path: `/video/uploads/${id}`,
      method: "DELETE",
      headers,
      body: { reason },
    };
  if (
    target.module === "media" &&
    action === "remove" &&
    typeof target.version === "string"
  )
    return {
      path: `/media/${id}`,
      method: "DELETE",
      headers,
      body: { reason },
    };
  throw new Error(
    "Esta acción no tiene un contrato compatible con la entidad y revisión mostradas.",
  );
}
export const lifecycleCopy: Record<
  LifecycleEffect,
  {
    label: string;
    title: string;
    description: string;
    confirmLabel: string;
    outcome: string;
  }
> = {
  "local-archive": {
    label: "Archivar…",
    title: "Archivar",
    description:
      "Dejará de aparecer en la gestión activa. Su historial se conserva. Revisa los vínculos afectados.",
    confirmLabel: "Archivar registro",
    outcome: "Registro archivado; su historial se conserva.",
  },
  "private-erasure": {
    label: "Eliminar definitivamente…",
    title: "Eliminar definitivamente",
    description:
      "Se eliminará el contenido privado. Se conservarán la auditoría y la marca de borrado para impedir su recuperación.",
    confirmLabel: "Eliminar definitivamente",
    outcome:
      "Contenido privado eliminado; la auditoría y la marca de borrado se conservan.",
  },
  "local-discard": {
    label: "Descartar borrador local…",
    title: "Descartar el borrador local de",
    description:
      "Se eliminará este borrador de este equipo. El contenido publicado y el historial de envíos no cambian.",
    confirmLabel: "Descartar borrador",
    outcome:
      "Borrador local descartado. El contenido publicado y el historial de envíos no cambiaron.",
  },
  "public-withdrawal": {
    label: "Retirar del sitio…",
    title: "Preparar la retirada del sitio de",
    description:
      "La retirada necesita publicarse y comprobar su despliegue. El contenido puede seguir visible hasta entonces. No cambia el estado informado por la empresa ni elimina su procedencia o historial.",
    confirmLabel: "Preparar retirada",
    outcome:
      "Retirada preparada en este equipo. Publica el cambio y comprueba su despliegue; el contenido puede seguir visible hasta entonces.",
  },
  "local-exclusion": {
    label: "Excluir de futuras recolecciones…",
    title: "Excluir de futuras recolecciones",
    description:
      "Esta identidad no volverá a entrar en la revisión automática. La evidencia y el historial se conservan. Excluirla no confirma su retirada del sitio.",
    confirmLabel: "Excluir vacante",
    outcome:
      "Exclusión guardada. La retirada del sitio es un cambio independiente.",
  },
  "review-required": {
    label: "Quitar exclusión / solicitar revisión…",
    title: "Volver a revisar",
    description:
      "Esta identidad podrá volver a entrar en recolecciones y necesitará revisión. No se publicará automáticamente.",
    confirmLabel: "Solicitar revisión",
    outcome: "Revisión solicitada; no se publicó automáticamente.",
  },
  "source-retirement": {
    label: "Retirar fuente…",
    title: "Retirar la fuente",
    description:
      "Se detendrán las nuevas recolecciones. Se conservarán las vacantes ya obtenidas, los resultados y su procedencia. Esta acción no retira vacantes del sitio. La fuente retirada no se vuelve a habilitar.",
    confirmLabel: "Retirar fuente",
    outcome:
      "Fuente retirada de nuevas recolecciones. Sus vacantes, resultados y procedencia se conservan.",
  },
  "unsent-cancellation": {
    label: "Cancelar trabajo pendiente…",
    title: "Cancelar el trabajo pendiente de",
    description:
      "Se cancelará solo el trabajo que todavía no se haya enviado. El historial se conserva. Esta acción no elimina contenido de un proveedor.",
    confirmLabel: "Cancelar trabajo pendiente",
    outcome: "Trabajo pendiente cancelado; su historial se conserva.",
  },
  "owned-upload-removal": {
    label: "Eliminar archivo sin uso…",
    title: "Eliminar el archivo sin uso",
    description:
      "Se eliminará únicamente el archivo propio que no tenga referencias. Esta acción no elimina videos de un proveedor ni archivos oficiales o compartidos.",
    confirmLabel: "Eliminar archivo sin uso",
    outcome: "Archivo propio sin uso eliminado.",
  },
};
export const lifecycleReasons: Record<string, string> = {
  MANDATORY_SETTINGS:
    "La configuración principal es necesaria para el sitio; su identidad no se elimina.",
  RECORD_REFERENCED:
    "Otro registro utiliza esta identidad. Revisa sus vínculos antes de continuar.",
  PUBLICATION_PENDING:
    "Hay un envío en curso o con resultado incierto. Comprueba el envío original.",
  ARCHIVE_FIRST: "Archiva primero este registro privado.",
  PUBLIC_WITHDRAWAL_REQUIRED:
    "Primero debe verificarse la retirada del contenido público relacionado.",
  SOURCE_RETIRED: "Esta fuente está retirada y no se vuelve a habilitar.",
  SOURCE_IN_PROGRESS:
    "Hay una recolección en curso. Comprueba su resultado antes de retirar la fuente.",
  ALREADY_SENDING:
    "El envío ya está en curso o se completó; no se puede confirmar su cancelación local.",
  SEEDED_MEDIA_PROTECTED: "Este archivo oficial o de referencia se conserva.",
  MEDIA_NOT_OWNED: "Este archivo no pertenece a tus cargas eliminables.",
  MEDIA_REFERENCED:
    "Este archivo se utiliza en contenido, borradores o envíos. Revisa sus referencias.",
  MEDIA_SHARED: "Este archivo compartido se conserva.",
  PERMISSION_DENIED: "Tu cuenta no tiene permiso para esta acción.",
  ALREADY_DISCARDED: "Este borrador ya fue descartado.",
  UPLOAD_REMOVED: "Esta carga ya fue retirada; se conserva su historial.",
  VIDEO_REFERENCED:
    "Este video está vinculado a una publicación o a su historial; no se elimina.",
  VIDEO_SHARED: "Este video comparte almacenamiento y se conserva.",
  VIDEO_NOT_OWNED: "Esta carga pertenece a otro operador.",
  VIDEO_IN_PROGRESS:
    "Hay una transferencia o lectura en curso; comprueba su resultado antes de continuar.",
  STORAGE_BACKEND_UNAVAILABLE:
    "El almacenamiento no está disponible; no se confirmó la eliminación.",
  IMMUTABLE_HISTORY:
    "Este historial se conserva para verificar cambios, resultados y recuperación; no se elimina.",
};
export const lifecycleSurfacePolicy: Record<string, string> = {
  overview: "overview",
  "content-memories": "records",
  blog: "records",
  resources: "records",
  courses: "records",
  organizers: "records",
  events: "events",
  speakers: "records",
  brands: "records",
  settings: "singleton",
  people: "records",
  organizations: "records",
  "speaker-profiles": "records",
  proposals: "records",
  participations: "records",
  sessions: "records",
  followups: "records",
  consents: "records",
  "jobs-candidates": "jobs",
  "jobs-active": "jobs",
  "jobs-stale": "jobs",
  "jobs-closed": "jobs",
  "job-sources": "sources",
  "collection-runs": "retained",
  "job-exclusions": "jobs",
  calendar: "publication",
  linkedin: "publication",
  youtube: "publication",
  "publication-history": "retained",
  changesets: "changesets",
  audit: "retained",
  operations: "retained",
  integrations: "access",
  members: "access",
  "image-library": "media",
  "video-upload": "upload",
  "legacy-memories": "drafts",
};

/** A server capability must describe the same domain effect as its fixed mutation route. */
export function lifecycleEffectAllowed(
  module: string,
  action: string,
  effect: string,
): boolean {
  const policy: Record<string, Record<string, string[]>> = {
    records: {
      archive: ["local-archive", "public-withdrawal"],
      erase: ["private-erasure"],
    },
    drafts: { discard: ["local-discard"] },
    "editorial-drafts": { discard: ["local-discard"] },
    jobs: {
      withdraw: ["public-withdrawal"],
      exclude: ["local-exclusion"],
      reopen: ["review-required"],
    },
    "job-sources": { retire: ["source-retirement"] },
    publications: { cancel: ["unsent-cancellation"] },
    changesets: { cancel: ["unsent-cancellation"] },
    media: { remove: ["owned-upload-removal"] },
    "video-assets": { remove: ["owned-upload-removal"] },
  };
  return (
    Object.hasOwn(policy, module) &&
    Object.hasOwn(policy[module], action) &&
    policy[module][action].includes(effect)
  );
}

/** Consume only a matching contextual handoff; destinations still load through their authorized APIs. */
export function takeLifecycleReference(
  module: LifecycleModule | "operations",
): string | null {
  const raw = sessionStorage.getItem("admin-open-lifecycle");
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (value.module !== module) return null;
    sessionStorage.removeItem("admin-open-lifecycle");
    return typeof value.id === "string" ? value.id : null;
  } catch {
    sessionStorage.removeItem("admin-open-lifecycle");
    return null;
  }
}

/** Validate additive server metadata without accepting executable routes or mismatched effect wording. */
export function lifecycleDescriptorValid(
  value: any,
): value is LifecycleDescriptor {
  return Boolean(
    value &&
    typeof value.module === "string" &&
    typeof value.id === "string" &&
    value.id &&
    (typeof value.version === "string"
      ? value.version.length > 0
      : Number.isInteger(value.version) && value.version > 0) &&
    typeof value.state === "string" &&
    ["none", "publication-required"].includes(value.remoteEffect) &&
    Array.isArray(value.actions) &&
    value.actions.length <= 20 &&
    new Set(value.actions.map((a: any) => a?.action)).size ===
      value.actions.length &&
    value.actions.every(
      (a: any) =>
        a &&
        typeof a.action === "string" &&
        Object.hasOwn(lifecycleCopy, a.effect) &&
        lifecycleEffectAllowed(value.module, a.action, a.effect) &&
        typeof a.allowed === "boolean" &&
        typeof a.requiresReason === "boolean" &&
        typeof a.requiresRecentAuth === "boolean" &&
        (a.reason === null || typeof a.reason === "string") &&
        Array.isArray(a.blockers) &&
        a.blockers.length <= 100 &&
        a.blockers.every(
          (b: any) =>
            b &&
            typeof b.code === "string" &&
            typeof b.module === "string" &&
            typeof b.id === "string",
        ),
    ),
  );
}

/** Pending byte cleanup is retained evidence, never an image attachment option. */
export function mediaSelectable(asset: any): boolean {
  return Boolean(
    asset &&
    !asset.cleanupPending &&
    !["cleanup-pending", "removed"].includes(asset.state),
  );
}
