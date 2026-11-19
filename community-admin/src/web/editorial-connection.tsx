import React, { useEffect, useState } from "react";
import { request } from "./client";
import { ProviderLogo } from "./icons";
import type { EditorialStatus } from "./editorial-state";
/** Login identity and a shared editorial repository are separate configuration boundaries. */
export function EditorialConnection() {
  const [status, setStatus] = useState<EditorialStatus | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    request<EditorialStatus>("/editorial/status")
      .then(setStatus)
      .catch((e) =>
        setError(
          e instanceof Error
            ? e.message
            : "No se pudo consultar la configuración.",
        ),
      );
  }, []);
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>
            <ProviderLogo provider="github" size={24} /> Eventos compartidos
            mediante GitHub
          </h2>
          <p>
            {status?.mode === "github"
              ? status.configured
                ? "Fuente compartida configurada"
                : "Modo GitHub · repositorio sin configurar"
              : "Modo local de este equipo"}
          </p>
        </div>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : !status ? (
        <p role="status">Consultando configuración editorial…</p>
      ) : (
        <>
          <p>
            {status.repository
              ? `${status.repository} · ${status.branch}`
              : "No se ha elegido un repositorio editorial compartido."}
          </p>
          <p>
            {status.remoteWritesEnabled
              ? "La publicación directa en main está habilitada; cada envío requiere una acción explícita."
              : "Los envíos a GitHub están deshabilitados. Iniciar sesión con GitHub no activa la publicación."}
          </p>
          <p>
            El alcance compartido incluye eventos. Los contactos privados y
            otros módulos permanecen en su fuente local.
          </p>
          <details>
            <summary>Cómo configurar la fuente compartida</summary>
            <p>
              El propietario define EDITORIAL_MODE=github, EDITORIAL_REPOSITORY
              y EDITORIAL_BRANCH en la configuración privada del servidor.
              EDITORIAL_REMOTE_WRITES permanece en 0 hasta autorizar
              publicaciones.
            </p>
            <p>
              Después, abre Contenido → Eventos y consulta GitHub. Esto no
              importa ni reemplaza automáticamente los registros locales, ni
              crea un repositorio.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
