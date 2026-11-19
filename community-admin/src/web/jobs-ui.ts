import { localTimeToInstant } from "./schedule";
export function jobQueueStates(section: string): string[] {
  return section === "jobs-candidates"
    ? ["candidate", "needs-review"]
    : section === "job-exclusions"
      ? ["excluded"]
      : [section.replace("jobs-", "")];
}
export function editableSourceConfig(config: Record<string, any>) {
  const { _runtime, ...editable } = config;
  return editable;
}
export function validDestination(provider: string, destination: string) {
  return provider === "linkedin"
    ? /^urn:li:organization:\d+$/.test(destination)
    : provider === "youtube"
      ? /^UC[A-Za-z0-9_-]{22}$/.test(destination)
      : false;
}
export function providerCanAuthorize(
  readiness: { ready?: boolean } | null | undefined,
  provider: string,
  destination: string,
) {
  return readiness?.ready === true && validDestination(provider, destination);
}
export function publicHref(value: unknown): string | undefined {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.hostname.includes(".") &&
      !/^(localhost|.*\.(local|internal|localhost))$/.test(url.hostname) &&
      !/^[\d.]+$/.test(url.hostname) &&
      !url.hostname.includes(":")
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export const jobLabels: Record<string, string> = {
  candidate: "Por revisar",
  "needs-review": "Requiere nueva revisión",
  active: "Activa",
  stale: "Por verificar",
  closed: "Cerrada",
  excluded: "Excluida",
  complete: "Completada",
  failed: "Fallida",
  incomplete: "Incompleta",
  quarantined: "Cambios pendientes de comprobar",
  queued: "En cola",
  sending: "Recolectando",
  unknown: "Resultado por confirmar",
  retry: "Reintentando",
  deadletter: "No se pudo completar",
  cancelled: "Cancelada",
};
export function jobMoment(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return "Todavía no registrado";
  return new Date(value).toLocaleString("es-PE", {
    timeZone: "America/Lima",
    dateStyle: "medium",
    timeStyle: "short",
  });
}
export function jobFailureMessage(code: string | null | undefined) {
  return (
    (
      {
        RATE_LIMIT:
          "La fuente pidió reducir la frecuencia. Se conservaron las vacantes anteriores.",
        TIMEOUT:
          "La fuente no respondió a tiempo. No se confirmó ningún cierre.",
        PARSE:
          "La respuesta de la fuente no se pudo interpretar. Revisa su formato.",
        BLOCKED:
          "La fuente no está habilitada o no cumple las condiciones de lectura.",
        ANOMALY:
          "La fuente cambió de forma inusual. Se necesita revisar la evidencia antes de retirar vacantes.",
        COLLECTION_DISABLED:
          "La recolección está deshabilitada en este entorno.",
        SOURCE_CHANGED:
          "La configuración cambió durante la lectura; vuelve a consultar la fuente.",
        ACTOR_REVOKED:
          "La cuenta que autorizó esta lectura ya no tiene permiso.",
      } as Record<string, string>
    )[code ?? ""] ??
    (code
      ? "No se pudo completar esta lectura. Revisa la evidencia de la recolección."
      : "Sin error informado")
  );
}

/** Preserve an existing expiry when opening an editor, independent of browser timezone. */
export function limaDateTimeInput(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Lima",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(value))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function jobSourceLabel(adapter: string): string {
  return (
    (
      {
        greenhouse: "Greenhouse",
        lever: "Lever",
        smartrecruiters: "SmartRecruiters · Perú",
        hirehive: "HireHive · vacante individual",
        globant: "Globant · vacante individual",
      } as Record<string, string>
    )[adapter] ?? "Fuente sin identificar"
  );
}

export function jobPublicationLabel(state: string): string {
  return (
    (
      {
        prepared: "Cambio preparado · sitio sin actualizar",
        pr_open: "PR abierta · pendiente de revisión",
        merged: "Integrado · despliegue pendiente",
        deployed: "Despliegue confirmado",
        closed: "PR cerrada · sitio sin actualizar",
        unknown: "Resultado remoto por confirmar",
        branch_pending: "Rama preparada · PR sin confirmar",
      } as Record<string, string>
    )[state] ?? "Consulta el resultado de la operación"
  );
}

/** Remote baseline bookkeeping advances CAS, but does not change the approved public content. */
export function jobPublicationRevision(
  payload: Record<string, unknown>,
): string {
  const { baseEntityHash, publicationBaseline, ...content } = payload;
  return JSON.stringify(content);
}

/** Minute-precision controls must not silently truncate a source's unchanged seconds. */
export function intakeExpiryInstant(
  input: string,
  original: unknown,
): string | null {
  if (!input) return null;
  if (typeof original === "string" && limaDateTimeInput(original) === input)
    return original;
  return localTimeToInstant(input, "America/Lima");
}

/** A completed worker can contain an incomplete collection; keep those outcomes distinct. */
export function jobOperationMessage(
  state: string,
  code: string | null | undefined,
  outcome: string | null | undefined,
): string {
  if (state === "complete" && code === "OK") {
    if (outcome === "complete") return "Lectura completada sin errores.";
    if (outcome === "incomplete")
      return "Lectura incompleta; no confirma el cierre de vacantes ausentes.";
    if (outcome === "quarantined")
      return "Hay cambios pendientes de comprobar antes de retirar vacantes.";
    if (outcome === "failed")
      return "La lectura falló. Revisa la evidencia de la recolección.";
    return "Solicitud procesada. Consulta el resultado de la lectura.";
  }
  return jobFailureMessage(code);
}

export function jobRunScope(run: {
  scope?: string;
  evidence?: { scope?: string; complete?: boolean };
}): string {
  const scope = run.evidence?.scope ?? run.scope;
  if (scope === "single-detail")
    return "Solo la vacante enlazada; no revisa toda la bolsa ni confirma ausencias";
  if (scope === "board") {
    if (run.evidence?.complete === true) return "Lectura completa de la bolsa";
    if (run.evidence?.complete === false)
      return "Lectura incompleta de la bolsa; no confirma ausencias";
    return "Lectura de la bolsa; no se informó si fue completa";
  }
  return "Consulta la evidencia de esta lectura";
}

/** Render only the server's evidence classification; payload eligibility can be stale. */
export function jobGeographyLabel(
  geography:
    | { qualified?: boolean; eligibility?: string; reason?: string }
    | null
    | undefined,
): string {
  const labels: Record<string, string> = {
    "explicit-peru": "Perú · ubicación confirmada",
    "explicit-remote-latam": "Remoto LATAM · confirmado",
    restricted: "Restricción de ubicación",
    "outside-region": "Fuera de región",
    "location-unconfirmed": "Ubicación sin confirmar",
    "eligibility-unconfirmed": "Elegibilidad sin confirmar",
  };
  return labels[geography?.reason ?? ""] ?? "Elegibilidad sin confirmar";
}
