// Standalone public collector module. Keep adapter contract tests aligned with admin engine.
import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
function stable(value) {
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
export const hashValue = (value) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
export function encryptSecret(value, key) {
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
export function decryptSecret(value, key) {
  const [iv, tag, data] = value
    .split(".")
    .map((s) => Buffer.from(s, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", key, iv);
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([cipher.update(data), cipher.final()]).toString(),
  );
}
export function verifyWebhook(body, signature, secret) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
export class IntegrationError extends Error {
  code;
  status;
  ambiguous;
  retryAfter;
  constructor(code, status = 422, ambiguous = false, retryAfter = 0) {
    super(code);
    this.code = code;
    this.status = status;
    this.ambiguous = ambiguous;
    this.retryAfter = retryAfter;
  }
}
export function deterministicId(value) {
  const h = hashValue(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function integrationMessage(code) {
  const messages = {
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
export function publicIntegrationError(error) {
  return {
    code: error.code,
    message: integrationMessage(error.code),
    fieldErrors: [],
    correlationId: randomUUID(),
  };
}
