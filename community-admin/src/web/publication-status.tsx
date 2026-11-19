import React from "react";
import { publicationView } from "./publication-state";
import { publicHref } from "./jobs-ui";
export function PublicationStatus({ value }: { value: any }) {
  const view = publicationView(value),
    result = value?.result ?? value ?? {},
    prUrl = publicHref(value?.pr_url ?? value?.prUrl ?? result.prUrl),
    commitUrl = publicHref(view.commitUrl),
    siteUrl = publicHref(view.deployment?.url);
  const verifiedCommit = Boolean(
    view.commitSha &&
    [
      "committed",
      "deploying",
      "deployed",
      "deployment_failed",
      "superseded",
    ].includes(view.state),
  );
  const stage =
    view.state === "deployed"
      ? 3
      : verifiedCommit
        ? 2
        : view.state === "publishing"
          ? 1
          : 0;
  return (
    <section
      className="publication-progress"
      aria-label="Estado de publicación"
      aria-live="polite"
    >
      <strong>{view.label}</strong>
      {view.mode === "pull-request" ? (
        <p>
          Envío histórico mediante PR. Las publicaciones nuevas se envían
          directamente a main.
        </p>
      ) : (
        <ol className="timeline">
          {["Revisado", "Enviando", "Commit guardado", "Sitio publicado"].map(
            (label, i) => (
              <li
                key={label}
                className={stage >= i ? "done" : ""}
                aria-current={stage === i ? "step" : undefined}
              >
                {label}
              </li>
            ),
          )}
        </ol>
      )}
      {verifiedCommit && (
        <p>
          Commit:{" "}
          {commitUrl ? (
            <a href={commitUrl} target="_blank" rel="noreferrer">
              {view.commitSha!.slice(0, 12)} ↗
            </a>
          ) : (
            <code>{view.commitSha!.slice(0, 12)}</code>
          )}
        </p>
      )}
      {view.state === "deployed" && view.deployedSha && (
        <p>
          Versión desplegada: <code>{view.deployedSha.slice(0, 12)}</code>
          {siteUrl && (
            <>
              {" "}
              ·{" "}
              <a href={siteUrl} target="_blank" rel="noreferrer">
                Abrir sitio publicado ↗
              </a>
            </>
          )}
        </p>
      )}
      {view.mode === "pull-request" && prUrl && (
        <p>
          <a href={prUrl} target="_blank" rel="noreferrer">
            Abrir PR histórica ↗
          </a>
        </p>
      )}
      {view.state === "uncertain" && (
        <p>
          Conservamos el envío y tu revisión. Comprueba el resultado antes de
          volver a publicar para evitar duplicados.
        </p>
      )}
      {view.state === "conflict" && (
        <p>
          Otra publicación cambió los mismos datos. Compara la versión de GitHub
          con tu revisión antes de preparar un nuevo envío; no se sobrescribió
          tu contenido.
        </p>
      )}
      {view.state === "deployment_failed" && (
        <p>
          No vuelvas a enviar el contenido: el commit ya existe. Revisa el
          despliegue y comprueba de nuevo su estado.
        </p>
      )}
      {view.state === "superseded" && (
        <p>
          La versión actual del sitio ya no coincide con este envío. No lo
          marcamos como visible.
        </p>
      )}
      {(result.conflicts ?? value?.conflicts)?.length > 0 && (
        <details>
          <summary>Ver datos en conflicto</summary>
          <pre>
            {JSON.stringify(result.conflicts ?? value.conflicts, null, 2)}
          </pre>
        </details>
      )}
    </section>
  );
}
