import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { User } from "../shared/types";
import { request } from "./client";
import { NamedConfirmation } from "./named-confirmation";
import {
  descriptorMatches,
  lifecycleCopy,
  lifecycleMutation,
  lifecycleReasons,
  lifecycleDescriptorValid as validDescriptor,
  type LifecycleDescriptor,
  type LifecycleTarget,
  type LifecycleCapability,
} from "./lifecycle";
const LifecycleContext = createContext<{
  user: User;
  navigate: (section: string) => void;
} | null>(null);
export const LifecycleProvider = LifecycleContext.Provider;
export function LifecycleActions({
  target,
  disabled = false,
  onComplete,
  onReload,
  onDescriptor,
  user: explicitUser,
}: {
  target: LifecycleTarget;
  disabled?: boolean;
  user?: User;
  onComplete?: (
    result: any,
    action: LifecycleCapability,
  ) => Promise<void> | void;
  onReload?: () => Promise<void> | void;
  onDescriptor?: (value: LifecycleDescriptor | null) => void;
}) {
  const context = useContext(LifecycleContext),
    user = explicitUser ?? context?.user;
  const [descriptor, setDescriptor] = useState<LifecycleDescriptor | null>(
      null,
    ),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [refresh, setRefresh] = useState(0);
  const descriptorListener = useRef(onDescriptor);
  descriptorListener.current = onDescriptor;
  const current = useRef({ target, disabled });
  current.current = { target, disabled };
  useEffect(() => {
    let active = true;
    setDescriptor(null);
    descriptorListener.current?.(null);
    setError("");
    if (user && target.version !== "" && target.version !== undefined)
      void request(
        `/lifecycle/${target.module}/${encodeURIComponent(target.id)}`,
      )
        .then((value) => {
          if (!validDescriptor(value))
            throw new Error("No se pudo verificar el contrato de esta acción.");
          if (active) {
            setDescriptor(value);
            descriptorListener.current?.(value);
          }
        })
        .catch((e) => {
          if (active)
            setError(
              e instanceof Error
                ? e.message
                : "No se pudieron comprobar las acciones.",
            );
        });
    return () => {
      active = false;
    };
  }, [target.module, target.id, target.version, user?.id, refresh]);
  useEffect(() => setNotice(""), [target.module, target.id]);
  async function openReference(blocker: { module: string; id: string }) {
    if (disabled || !context) return;
    try {
      if (blocker.module === "records") {
        const record: any = await request(
          `/records/${encodeURIComponent(blocker.id)}`,
        );
        sessionStorage.setItem(
          "admin-open-record",
          JSON.stringify({ id: record.id, type: record.type }),
        );
        context.navigate(
          record.type === "memories" ? "content-memories" : record.type,
        );
        return;
      }
      const routes: Record<string, string> = {
        "editorial-drafts": "events",
        drafts: "memories",
        jobs: "jobs-candidates",
        "job-sources": "job-sources",
        changesets: "changesets",
        publications: "publication-history",
        media: "content-memories",
        operations: "operations",
      };
      const section = routes[blocker.module];
      if (section) {
        sessionStorage.setItem("admin-open-lifecycle", JSON.stringify(blocker));
        context.navigate(section);
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "No se pudo abrir el vínculo autorizado.",
      );
    }
  }
  if (!user)
    return (
      <p className="field-help">
        Las acciones necesitan una sesión verificada.
      </p>
    );
  if (target.version === "" || target.version === undefined)
    return (
      <p className="field-help">
        Recarga esta entidad para comprobar su revisión antes de actuar.
      </p>
    );
  const stale = descriptor && !descriptorMatches(target, descriptor);
  return (
    <details className="lifecycle-actions">
      <summary>Acciones e impacto</summary>
      <div className="lifecycle-actions-content">
        {error && <p role="alert">{error}</p>}
        {!descriptor && !error && (
          <p role="status">Comprobando acciones y vínculos…</p>
        )}
        {error && (
          <button type="button" onClick={() => setRefresh((v) => v + 1)}>
            Volver a comprobar acciones
          </button>
        )}
        {stale ? (
          <>
            <p role="alert">
              La revisión cambió. Esta confirmación no utilizará una versión más
              reciente sin que vuelvas a cargar el registro.
            </p>
            {onReload && (
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  void Promise.resolve(onReload()).catch((e) =>
                    setError(
                      e instanceof Error
                        ? e.message
                        : "No se pudo recargar la revisión.",
                    ),
                  )
                }
              >
                Recargar revisión
              </button>
            )}
          </>
        ) : (
          descriptor && (
            <>
              {descriptor.actions.length === 0 && (
                <p>
                  {lifecycleReasons[descriptor.retentionReason ?? ""] ??
                    "Este registro se conserva como evidencia; no tiene una acción de eliminación disponible."}
                </p>
              )}
              {descriptor.actions.map((capability) => {
                const copy = lifecycleCopy[capability.effect];
                let compatible = true;
                try {
                  lifecycleMutation(target, capability.action, "");
                } catch {
                  compatible = false;
                }
                return (
                  <section key={capability.action} className="lifecycle-action">
                    {capability.allowed && compatible ? (
                      <NamedConfirmation
                        target={{ ...target, action: capability.action }}
                        label={copy.label}
                        title={copy.title}
                        description={
                          copy.description +
                          (capability.requiresRecentAuth
                            ? " El servidor comprobará tu sesión reciente antes de continuar."
                            : "")
                        }
                        confirmLabel={copy.confirmLabel}
                        reasonLabel={
                          capability.action === "erase"
                            ? "Motivo de la eliminación"
                            : "Motivo de la acción"
                        }
                        minReasonLength={
                          capability.action === "erase"
                            ? 5
                            : capability.requiresReason
                              ? 5
                              : 0
                        }
                        disabled={disabled}
                        onConfirm={async (intent) => {
                          const captured: LifecycleTarget = {
                            ...target,
                            id: intent.target.id,
                            version: intent.target.version,
                            name: intent.target.name,
                          };
                          if (
                            !descriptorMatches(
                              current.current.target,
                              captured,
                            ) ||
                            current.current.disabled
                          )
                            throw new Error(
                              "La entidad o revisión cambió. Vuelve a abrir esta acción.",
                            );
                          const fresh = await request<LifecycleDescriptor>(
                            `/lifecycle/${captured.module}/${encodeURIComponent(captured.id)}`,
                          );
                          if (
                            !validDescriptor(fresh) ||
                            !descriptorMatches(captured, fresh)
                          )
                            throw new Error(
                              "La revisión cambió. Vuelve a cargar el registro antes de continuar.",
                            );
                          const allowed = fresh.actions.find(
                            (a) =>
                              a.action === capability.action &&
                              a.effect === capability.effect,
                          );
                          if (!allowed?.allowed)
                            throw new Error(
                              lifecycleReasons[allowed?.reason ?? ""] ??
                                "La acción ya no está permitida. Comprueba sus vínculos y estado.",
                            );
                          if (
                            !descriptorMatches(
                              current.current.target,
                              captured,
                            ) ||
                            current.current.disabled
                          )
                            throw new Error(
                              "La entidad o revisión cambió. Vuelve a abrir esta acción.",
                            );
                          const mutation = lifecycleMutation(
                            captured,
                            capability.action,
                            intent.reason,
                          );
                          const result = await request(mutation.path, {
                            method: mutation.method,
                            headers: {
                              "X-CSRF-Token": user.csrfToken,
                              "Idempotency-Key": crypto.randomUUID(),
                              ...mutation.headers,
                            },
                            ...(mutation.body
                              ? { body: JSON.stringify(mutation.body) }
                              : {}),
                          });
                          if (!onComplete)
                            setNotice(`«${captured.name}»: ${copy.outcome}`);
                          await onComplete?.(result, capability);
                          setRefresh((v) => v + 1);
                        }}
                      />
                    ) : (
                      <>
                        <strong>{copy.label.replace(/…$/, "")}</strong>
                        <p>
                          {compatible
                            ? (lifecycleReasons[capability.reason ?? ""] ??
                              "Esta acción no está disponible para el estado actual.")
                            : "Recarga los datos necesarios para comprobar esta acción; no se enviará una petición incompleta."}
                        </p>
                      </>
                    )}
                    {capability.blockers.map((blocker, index) => (
                      <div key={`${blocker.code}:${blocker.id}:${index}`}>
                        <p>
                          {lifecycleReasons[blocker.code] ??
                            "Hay un vínculo o un envío pendiente que debe comprobarse."}
                        </p>
                        {context &&
                          blocker.id &&
                          [
                            "records",
                            "editorial-drafts",
                            "drafts",
                            "jobs",
                            "job-sources",
                            "changesets",
                            "publications",
                            "operations",
                          ].includes(blocker.module) && (
                            <button
                              type="button"
                              disabled={disabled}
                              onClick={() => void openReference(blocker)}
                            >
                              Ver vínculo relacionado ·{" "}
                              {blocker.id.slice(0, 12)}
                            </button>
                          )}
                      </div>
                    ))}
                  </section>
                );
              })}
            </>
          )
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
    </details>
  );
}
export function LifecycleRetention({
  kind = "history",
}: {
  kind?: "history" | "access" | "provider" | "upload" | "overview";
}) {
  const copy = {
    history:
      "Este historial se conserva para comprobar cambios, resultados y recuperación. No se elimina; gestiona el registro original para retirarlo o archivarlo.",
    access:
      "La identidad y el historial de acceso se conservan. Revocar acceso o desconectar un servicio no elimina su cuenta externa ni contenido publicado.",
    provider:
      "Cancelar un trabajo pendiente no elimina una publicación ya enviada. Los envíos inciertos necesitan comprobar su resultado; su historial se conserva.",
    upload:
      "Descartar un punto de reanudación solo borra información local del navegador. No elimina el archivo almacenado ni un video del proveedor.",
    overview:
      "Las acciones de archivo, retirada o borrado se encuentran en el gestor de cada registro y explican su efecto antes de confirmar.",
  };
  return <p className="field-help lifecycle-retention">{copy[kind]}</p>;
}

/** Keep all mounted attachment choices consistent after an authorized inventory refresh. */
export function useMediaInventoryUpdates(receive: (rows: any[]) => void) {
  useEffect(() => {
    const listener = (event: Event) => {
      const rows = (event as CustomEvent).detail;
      if (Array.isArray(rows)) receive(rows);
    };
    window.addEventListener("admin-media-inventory", listener);
    return () => window.removeEventListener("admin-media-inventory", listener);
  }, [receive]);
}
export function publishMediaInventory(rows: any[]) {
  window.dispatchEvent(
    new CustomEvent("admin-media-inventory", { detail: rows }),
  );
}
