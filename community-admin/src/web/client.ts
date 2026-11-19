export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fieldErrors: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}
const problemMessages: Record<string, string> = {
  SOCIAL_SOURCE_INVALID:
    "Usa el enlace público de una publicación de la red seleccionada, no un perfil o una pantalla de composición.",
  SOCIAL_SOURCE_ALREADY_INDEXED:
    "Ese enlace ya está asociado a otro registro del blog. Conservamos los borradores sin duplicarlos.",
  SOCIAL_ALREADY_INDEXED:
    "Esta publicación ya tiene un borrador. Edítalo desde Blog sin volver a indexar.",
  BLOG_CONFIRMATION_REQUIRED:
    "Registra primero la URL real mediante la confirmación social.",
  BLOG_SOURCE_IMMUTABLE:
    "El origen confirmado no se modifica desde el editor. Conserva tus cambios editoriales.",
  PUBLICATION_IN_FLIGHT:
    "Hay un envío pendiente o incierto. Comprueba su resultado antes de confirmar manualmente.",
  SOCIAL_NETWORK_MISMATCH:
    "La red de origen no coincide con este canal de publicación.",

  INTEGRATION_DISABLED:
    "La integración está deshabilitada. El propietario debe configurar y autorizar el servicio; mientras tanto, usa el paquete manual.",
  NEEDS_RECONNECTION:
    "La cuenta necesita reconexión. Pide al propietario que renueve el acceso antes de programar otro envío.",
  CONNECTOR_KEY_REQUIRED:
    "Falta la clave de cifrado del servidor. El propietario debe configurarla antes de guardar una conexión.",
  APPROVAL_REQUIRED:
    "Esta revisión necesita aprobación independiente antes de continuar.",
  APPROVAL_REVOKED:
    "El contenido cambió después de aprobarse. Solicita una nueva revisión.",
  SELF_APPROVAL:
    "Otra persona debe aprobar esta revisión. Cambia a una cuenta con permisos de revisión.",
  REVISION_CONFLICT:
    "Otra sesión cambió este registro. Conserva tu texto y vuelve a cargar la revisión guardada.",
  SOURCE_NOT_ENABLED:
    "La fuente no está habilitada. Revisa sus permisos, términos y aprobación antes de recolectar.",
  SOURCE_REVIEW_REQUIRED:
    "Completa la referencia, fecha de revisión, términos y base de permiso de esta fuente.",
  ELIGIBILITY_REVIEW_REQUIRED:
    "Revisa la elegibilidad para Perú y la relevancia antes de aprobar la oportunidad.",
  PR_NOT_AVAILABLE:
    "Todavía no existe una PR confirmada. Revisa la configuración y el resultado de la operación.",
  VIDEO_STORAGE_NOT_CONFIGURED:
    "El almacenamiento privado de video no está configurado. Puedes preparar metadata y enlazar un video existente.",
  MANUAL_RECONCILIATION_REQUIRED:
    "No hay una identidad remota confirmada. Revisa el proveedor antes de intentar otro envío.",
  UNKNOWN_REMOTE_RESULT:
    "El resultado del proveedor es incierto. Reconcílialo antes de reintentar para evitar duplicados.",
  ALREADY_SENDING:
    "El envío ya empezó. Comprueba el resultado antes de solicitar una retirada.",
  MISSED_SCHEDULE:
    "La hora programada pasó fuera del margen permitido. Revisa la publicación y programa otra hora.",
  INVITATION_REQUIRED:
    "Esta identidad no tiene una invitación activa. El propietario debe invitarla antes de ingresar.",
  REAUTHENTICATION_REQUIRED:
    "Vuelve a verificar GitHub desde el menú de tu cuenta antes de publicar. Conservamos los datos aprobados.",
  JOBS_PUBLICATION_UNCONFIGURED:
    "El destino del sitio web todavía no está configurado. Puedes conservar la vacante revisada sin enviarla.",
  JOBS_PUBLICATION_WRITES_DISABLED:
    "Los envíos al repositorio web están deshabilitados. El sitio no cambió.",
  AUTH_IDENTITY_MISMATCH:
    "La cuenta de GitHub no coincide con tu sesión. Vuelve a verificarla desde el menú de tu cuenta.",
  REMOTE_JOB_CONFLICT:
    "La vacante cambió en el repositorio. Conservamos tu revisión; compara la versión actual antes de preparar otra publicación.",
  PROPOSAL_UNCERTAIN:
    "No se pudo confirmar si GitHub recibió el cambio. Comprueba la publicación antes de intentar otro envío.",
  JOB_APPROVAL_REQUIRED:
    "La vacante necesita una revisión vigente antes de preparar su publicación.",
  DRAFT_VERSION_CONFLICT:
    "La revisión que viste cambió en otra sesión. Conservamos tu selección y tu texto; consulta la revisión actual antes de publicar.",
  JOB_VERSION_CONFLICT:
    "La vacante cambió desde que la abriste. Conservamos tu edición; vuelve a consultar sus datos antes de publicar.",
  EXPECTED_REVISIONS_REQUIRED:
    "No se pudo identificar la revisión elegida. Vuelve a abrir el contenido antes de publicar.",
  EXPECTED_VERSIONS_REQUIRED:
    "No se pudo identificar la versión elegida. Vuelve a abrir la vacante antes de publicar.",
  REMOTE_RECORD_CONFLICT:
    "GitHub cambió los mismos datos. Tu revisión se conserva: compara las versiones antes de volver a publicar.",
  HEAD_CONTENTION:
    "Hay otros envíos en curso. Tu revisión se conserva; comprueba el resultado antes de reintentar.",
  PUBLICATION_UNCERTAIN:
    "No se confirmó el resultado del envío. Conservamos tu operación; comprueba la publicación antes de intentar otra.",
  BRANCH_POLICY_BLOCKED:
    "El repositorio rechazó el commit por sus reglas de publicación. Tu revisión sigue guardada; no se cambió la configuración de GitHub.",
  ACTOR_REVOKED:
    "La cuenta ya no tiene permiso para este envío. Tu revisión permanece guardada.",
  PREVIEW_EXPIRED:
    "La comprobación venció. Tus datos siguen aquí. Vuelve a comprobar el enlace antes de guardar.",
  DUPLICATE_VACANCY_REVIEW_REQUIRED:
    "Otra publicación parece corresponder a esta misma vacante. Revisa sus referencias y excluye el duplicado antes de aprobar.",
  ELIGIBILITY_EVIDENCE_REQUIRED:
    "Incluye el texto de la publicación que confirma disponibilidad para Perú.",
  SOURCE_CLOSED:
    "La fuente indica que esta vacante está cerrada. No puede aprobarse como disponible.",
  WAITING_FOR_SITE: "La publicación espera el despliegue confirmado del sitio.",
};
export async function request<T = any>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: "same-origin",
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    });
  } catch {
    throw new ApiError(
      0,
      "OFFLINE",
      "Sin conexión. Tus cambios permanecen en esta pantalla. Comprueba la conexión y vuelve a intentar.",
    );
  }
  if (!response.ok) {
    const e = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      e.code ?? "REQUEST_FAILED",
      problemMessages[e.code] ?? e.message ?? "No se pudo completar la acción.",
      e.fieldErrors ?? [],
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export function downloadFile(
  value: unknown,
  name: string,
  type = "application/json",
) {
  const blob = new Blob(
    [typeof value === "string" ? value : JSON.stringify(value, null, 2)],
    { type },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
