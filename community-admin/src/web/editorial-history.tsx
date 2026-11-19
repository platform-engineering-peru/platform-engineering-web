import { PublicationStatus } from "./publication-status";
import React, { useEffect, useState } from "react";
import type { User } from "../shared/types";
import { request } from "./client";
import { ProviderLogo } from "./icons";
type Submission = {
  id: string;
  state: string;
  branch: string;
  reconcileRequired: boolean;
  canEdit: boolean;
  proposal?: { number: number; url: string };
  publicationMode?: "direct" | "pull-request";
  protocol?: string;
  commitSha?: string;
  commitUrl?: string;
  deployment?: { state: string; sha?: string; url?: string };
};
const labels: Record<string, string> = {
  preparing: "Preparando propuesta",
  sending: "Envío pendiente de confirmar",
  unknown: "Resultado por confirmar",
  retryable: "Resultado comprobado · permite reintento",
  open: "PR en revisión · aún no integrado",
  proposed: "PR en revisión · aún no integrado",
  merged: "Integrado en GitHub",
  closed: "PR cerrada sin integrar",
};
/** Submission history survives local draft edits/discard; querying it never replaces the editor's text. */
export function EditorialHistory({
  user,
  refreshKey,
}: {
  user: User;
  refreshKey: string;
}) {
  const [items, setItems] = useState<Submission[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    setItems(
      (await request<{ items: Submission[] }>("/editorial/submissions")).items,
    );
  }
  useEffect(() => {
    void load().catch((e) =>
      setError(
        e instanceof Error ? e.message : "No se pudo consultar el historial.",
      ),
    );
  }, [refreshKey]);
  async function reconcile(id: string) {
    setBusy(true);
    setError("");
    try {
      await request(`/editorial/submissions/${id}/reconcile`, {
        method: "POST",
        headers: { "X-CSRF-Token": user.csrfToken },
        body: "{}",
      });
      await load();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "No se pudo confirmar el estado.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="panel editorial-history">
      <summary>
        <ProviderLogo provider="github" size={20} /> Historial de envíos a
        GitHub
      </summary>
      <p>
        Estado registrado en la última consulta. Un commit guardado no confirma
        el despliegue del sitio. Las PR anteriores se conservan como historial.
      </p>
      {error && <p role="alert">{error}</p>}
      {items.length ? (
        <ul className="editorial-activities">
          {items.map((item) => (
            <li key={item.id}>
              <div className="editorial-history-row">
                <div>
                  {item.publicationMode === "direct" || item.commitSha ? (
                    <PublicationStatus value={item} />
                  ) : (
                    <strong>
                      {labels[item.state] ?? "Estado pendiente de confirmar"}
                    </strong>
                  )}
                  {item.proposal && (
                    <p>
                      <a
                        href={item.proposal.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        PR #{item.proposal.number} en GitHub
                      </a>
                    </p>
                  )}
                </div>
                <button disabled={busy} onClick={() => void reconcile(item.id)}>
                  Consultar estado del envío
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p>No hay envíos registrados en esta fuente para tu cuenta.</p>
      )}
    </details>
  );
}
