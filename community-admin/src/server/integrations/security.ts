import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
function stable(value: any): any {
  return Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, stable(value[k])]),
        )
      : value;
}
export const hashValue = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
export function encryptSecret(value: unknown, key: Buffer): string {
  if (key.length !== 32) throw new Error("CONNECTOR_KEY_REQUIRED");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((b) => b.toString("base64url"))
    .join(".");
}
export function decryptSecret(value: string, key: Buffer): any {
  const [iv, tag, data] = value
    .split(".")
    .map((s) => Buffer.from(s, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", key, iv);
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([cipher.update(data), cipher.final()]).toString(),
  );
}
export function verifyWebhook(
  body: Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
export class IntegrationError extends Error {
  constructor(
    public code: string,
    public status = 422,
    public ambiguous = false,
    public retryAfter = 0,
  ) {
    super(code);
  }
}
export function deterministicId(value: unknown): string {
  const h = hashValue(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function integrationMessage(code: string): string {
  const messages: Record<string, string> = {
    PREVIEW_EXPIRED:
      "La revisión del enlace venció o pertenece a otra sesión. Revisa la URL de nuevo o guarda la información manual.",
    ELIGIBILITY_EVIDENCE_REQUIRED:
      "Indica el texto de la oferta que permite trabajar desde Perú o el criterio editorial verificable.",
    WORKPLACE_REVIEW_REQUIRED:
      "Confirma si la oferta es presencial, híbrida o remota antes de aprobar.",
    DUPLICATE_VACANCY_REVIEW_REQUIRED:
      "La URL original o requisición coincide con otra vacante. Resuelve la duplicación antes de aprobar.",
    JOBS_PUBLICATION_UNCONFIGURED:
      "Falta configurar el destino de publicación de vacantes del sitio. Puedes seguir guardando y revisando ofertas.",
    JOBS_PUBLICATION_WRITES_DISABLED:
      "El envío de vacantes al repositorio del sitio está deshabilitado. Las integraciones sociales son independientes.",
    WEBSITE_RENDERER_NOT_READY:
      "La rama del sitio aún no tiene el contrato y visor de vacantes compatibles. Publica primero el soporte del sitio.",
    REMOTE_JOB_CONFLICT:
      "La vacante cambió en el repositorio. Conservamos tu revisión local; concilia el contenido antes de enviar.",
    AUTH_IDENTITY_MISMATCH:
      "La cuenta de GitHub CLI no coincide con la sesión que preparó esta publicación.",
    PUBLICATION_UNCERTAIN:
      "No se pudo confirmar la escritura en GitHub. Conservamos el mismo envío; consulta el resultado antes de repetirlo.",
    HEAD_CONTENTION:
      "Otros administradores están publicando. Conservamos tu contenido para volver a comprobarlo.",
    BRANCH_POLICY_BLOCKED:
      "Las reglas del repositorio bloquearon esta publicación. El contenido sigue guardado en este equipo.",
    EXPECTED_REVISIONS_REQUIRED:
      "Incluye la revisión mostrada de cada registro antes de publicar.",
    EXPECTED_VERSIONS_REQUIRED:
      "Incluye la versión mostrada de cada vacante antes de publicar.",
    EXPECTED_VERSION_MAP_INVALID:
      "La selección y sus versiones no coinciden. Recarga la lista sin perder tus cambios.",
    JOB_VERSION_CONFLICT:
      "La vacante cambió desde que la abriste. Conservamos tus cambios; revisa la versión actual.",
    NO_CHANGES: "El contenido ya coincide con main. No se creó otro commit.",
    PROPOSAL_UNCERTAIN:
      "No se pudo confirmar el PR. Concilia el resultado antes de volver a enviarlo.",
    INVALID_CAREERS_URL:
      "Usa una URL pública HTTPS sin credenciales ni fragmentos.",
    SOURCE_ALREADY_EXISTS:
      "Este portal de la empresa ya está registrado. Abre la fuente existente.",
    SOURCE_IDENTITY_IMMUTABLE:
      "Para cambiar de portal crea una fuente nueva; el historial conserva su identidad.",
    SOURCE_URL_MISMATCH:
      "La URL no corresponde al proveedor y portal seleccionados.",
    SOURCE_REVIEW_REQUIRED:
      "Revisa y registra permisos, términos, atribución y referencia antes de habilitar la fuente.",
    SOURCE_NOT_ENABLED:
      "La fuente está pausada. Revisa su configuración antes de recolectar.",
    SOURCE_CHANGED:
      "La fuente cambió durante la recolección. No se guardaron resultados antiguos; vuelve a intentarlo.",
    COLLECTION_DISABLED:
      "La recolección de vacantes está deshabilitada en esta instancia.",
    JOB_NOT_ACTIVE:
      "La vacante está cerrada o vencida. Revisa la evidencia y reabre de forma explícita antes de aprobar.",
    CLOSURE_REASON_REQUIRED:
      "Indica la evidencia o motivo para confirmar el cierre o cambiar el vencimiento.",
    DISCOVERY_LIMIT:
      "El portal excede los límites de revisión. Usa el enlace directo de su portal de empleo compatible.",
    DISCOVERY_REDIRECT_BLOCKED:
      "La URL redirige fuera del portal permitido. Revisa el enlace de empleo de la empresa.",
    CAREERS_FETCH_FAILED:
      "No se pudo leer el portal. No se modificaron las vacantes existentes.",
    UNSUPPORTED_CAREERS_CONTENT:
      "Esta respuesta no es una página pública de carreras compatible.",
    INTEGRATION_DISABLED: "Conecta y habilita el proveedor antes de enviar.",
    CONNECTOR_KEY_REQUIRED:
      "El servidor necesita una clave de cifrado para conectar cuentas.",
    NEEDS_RECONNECTION: "La cuenta perdió acceso. Vuelve a conectarla.",
    SCHEDULE_APPROVAL_REQUIRED:
      "Prepara el horario y solicita una nueva revisión antes de programar.",
    SCHEDULE_ZONE_MISMATCH:
      "La hora local no coincide con la fecha y zona seleccionadas.",
    APPROVAL_REQUIRED: "Solicita la aprobación de la revisión actual.",
    APPROVAL_REVOKED:
      "El contenido cambió desde la aprobación. Solicita otra revisión.",
    UNKNOWN_REMOTE_RESULT:
      "No pudimos confirmar el resultado. Revisa el proveedor antes de volver a enviar.",
    MANUAL_RECONCILIATION_REQUIRED:
      "Revisa el resultado en el proveedor antes de volver a enviar.",
    ACTOR_REVOKED: "La persona que programó esta acción ya no tiene permiso.",
    PERMISSION_DENIED: "Tu cuenta no tiene permiso para esta acción.",
    REQUIRED_CHECKS_PENDING: "La validación del sitio todavía no terminó.",
    VIDEO_VALIDATION_FAILED:
      "El archivo no pasó la verificación de contenido e integridad.",
    RATE_LIMIT: "El proveedor pidió esperar antes de volver a intentar.",
    REVISION_CONFLICT:
      "Otra sesión cambió esta revisión. Recarga antes de guardar.",
    IDEMPOTENCY_KEY_REQUIRED:
      "La solicitud necesita un identificador para evitar duplicados.",
    REVIEWED_SUMMARY_REQUIRED:
      "Agrega y revisa el resumen en español e inglés antes de aprobar.",
  };
  return (
    messages[code] ??
    "No se pudo completar esta acción. Revisa el estado y los campos antes de reintentar."
  );
}

export function publicIntegrationError(error: IntegrationError) {
  return {
    code: error.code,
    message: integrationMessage(error.code),
    fieldErrors: [],
    correlationId: randomUUID(),
  };
}
