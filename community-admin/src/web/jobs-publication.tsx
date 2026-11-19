import {
  pendingPublication,
  rememberPublication,
  forgetPublication,
} from "./publication-intent";
import React, { useEffect, useRef, useState } from "react";
import type { User } from "../shared/types";
import { request } from "./client";
import { PublicationStatus } from "./publication-status";
import { publicationView } from "./publication-state";
const reasons: Record<string, string> = {
  WEBSITE_RENDERER_NOT_READY:
    "El sitio aún necesita la versión compatible de sus lectores públicos. Tu revisión sigue guardada; vuelve a comprobar disponibilidad cuando se despliegue.",
  UNCONFIGURED:
    "El destino del sitio todavía no está configurado. Tu revisión sigue guardada.",
  REMOTE_WRITES_DISABLED:
    "Los envíos al sitio están deshabilitados en este entorno.",
  JOBS_PUBLICATION_UNCONFIGURED:
    "El repositorio de publicación web no está configurado en este entorno.",
  JOBS_PUBLICATION_WRITES_DISABLED:
    "Los envíos al repositorio web están deshabilitados.",
  AUTH_IDENTITY_MISMATCH:
    "Vuelve a verificar tu cuenta GitHub. La identidad debe coincidir con la sesión autorizada.",
};
export function JobsPublication({
  user,
  jobId,
  version,
  blocked = false,
  onReconciled,
  kind = "job",
  recordType,
}: {
  user: User;
  jobId: string;
  version: number;
  kind?: "job" | "record";
  recordType?: string;
  blocked?: boolean;
  onReconciled?: () => Promise<void>;
}) {
  const intentStorageKey = `admin-publication:${user.id}:${kind}:${jobId}`;
  const recoveredIntent = useRef(pendingPublication(intentStorageKey));
  const [readiness, setReadiness] = useState<any>(null),
    [operation, setOperation] = useState<any>(null),
    [result, setResult] = useState<any>(
      recoveredIntent.current ? { state: "uncertain" } : null,
    ),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submissionKey = useRef(
    recoveredIntent.current?.key ?? crypto.randomUUID(),
  );
  const headers = () => ({
    "X-CSRF-Token": user.csrfToken,
    "Idempotency-Key": submissionKey.current,
  });
  async function refresh() {
    setError("");
    try {
      setReadiness(
        await request(
          kind === "record"
            ? `/website/publication/status?types=${encodeURIComponent(recordType ?? "")}`
            : "/jobs/publication/status",
        ),
      );
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    const cached = pendingPublication(intentStorageKey);
    setOperation(
      cached?.operationId
        ? {
            id: cached.operationId,
            subject_id: cached.changesetId,
            state: "unknown",
          }
        : null,
    );
    setResult(cached ? { state: "uncertain" } : null);
    setConfirmed(false);
    void refresh();
  }, [jobId]);
  useEffect(() => {
    if (
      !operation?.id ||
      !["queued", "sending", "retry", "unknown"].includes(operation.state)
    )
      return;
    let alive = true;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void request<any>(`/operations/${operation.id}`)
        .then((op) => {
          if (!alive) return;
          setOperation(op);
          if (op.state === "unknown")
            setResult((current: any) => ({
              ...current,
              ...op.result,
              state: "unknown",
            }));
          else if (op.result?.state) setResult(op.result);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    }, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [operation?.id, operation?.state]);
  const changesetId =
    result?.changesetId ?? operation?.subject_id ?? operation?.subjectId;
  const state =
    result?.state ??
    operation?.publication?.state ??
    (operation?.state === "unknown" ? "unknown" : null);
  const uncertain = ["unknown", "uncertain", "branch_pending"].includes(state);
  async function prepare() {
    setBusy(true);
    setError("");
    try {
      rememberPublication(intentStorageKey, {
        key: submissionKey.current,
        ids: [jobId],
        versions: recoveredIntent.current?.versions ?? { [jobId]: version },
      });
      const op: any = await request(
        kind === "record" ? "/changesets" : "/jobs/changeset",
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(
            kind === "record"
              ? {
                  recordIds: [jobId],
                  expectedRevisions: recoveredIntent.current?.versions ?? {
                    [jobId]: version,
                  },
                }
              : {
                  jobIds: [jobId],
                  expectedVersions: recoveredIntent.current?.versions ?? {
                    [jobId]: version,
                  },
                },
          ),
        },
      );
      setOperation(op);
      rememberPublication(intentStorageKey, {
        key: submissionKey.current,
        ids: [jobId],
        versions: recoveredIntent.current?.versions ?? { [jobId]: version },
        operationId: op.id,
        changesetId: op.subject_id ?? op.subjectId ?? op.result?.changesetId,
      });
      setResult(
        op.result?.state
          ? op.result
          : (op.publication ?? { state: "prepared" }),
      );
      setConfirmed(false);
    } catch (e: any) {
      setError(e.message);
      if (
        [
          "OFFLINE",
          "PUBLICATION_UNCERTAIN",
          "PROPOSAL_UNCERTAIN",
          "IDEMPOTENCY_CONFLICT",
        ].includes(e.code)
      )
        setResult({ state: "uncertain" });
      else forgetPublication(intentStorageKey);
    } finally {
      setBusy(false);
    }
  }
  async function reconcile() {
    if (!changesetId) return;
    setBusy(true);
    setError("");
    try {
      setResult(
        await request(
          `/changesets/${encodeURIComponent(changesetId)}/reconcile`,
          { method: "POST", headers: headers(), body: "{}" },
        ),
      );
      if (operation?.id)
        setOperation(await request(`/operations/${operation.id}`));
      await onReconciled?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function retryExisting() {
    if (!changesetId || !(result?.canRetryExact || result?.retrySafe)) return;
    setBusy(true);
    setError("");
    try {
      const op: any = await request(
        `/changesets/${encodeURIComponent(changesetId)}/retry`,
        {
          method: "POST",
          headers: headers(),
          body: "{}",
        },
      );
      setOperation(op);
      setResult(op.result ?? { state: "publishing", changesetId });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const remote = readiness?.ready === true;
  const display = {
    ...operation,
    result: result ?? operation?.result,
  };
  const view = publicationView(display);
  useEffect(() => {
    if (
      [
        "committed",
        "deployed",
        "deployment_failed",
        "superseded",
        "conflict",
        "blocked",
        "failed",
        "deadletter",
      ].includes(view.state)
    )
      forgetPublication(intentStorageKey);
  }, [view.state, intentStorageKey]);
  return (
    <section
      className="review-box jobs-publication"
      aria-label={
        kind === "record"
          ? "Publicación de esta revisión en el sitio"
          : "Publicación de la vacante en el sitio"
      }
    >
      <h3>Publicar en el sitio web</h3>
      <p>
        Envía la versión revisada directamente a main. El commit se confirma
        primero; el sitio se considera actualizado cuando se verifica su
        despliegue.
      </p>
      {readiness ? (
        <>
          <p>
            {readiness.repository
              ? `Destino: ${readiness.repository} · ${readiness.branch}`
              : "Destino del sitio sin configurar"}
          </p>
          {!remote && (
            <p role="status">
              Publicación web no disponible. Tu revisión se conserva.
            </p>
          )}
          {(readiness.reasons ?? []).map((code: string) => (
            <p className="field-help" key={code}>
              {reasons[code] ??
                "Comprueba el destino y la identidad autorizada antes de enviar."}
            </p>
          ))}
        </>
      ) : (
        <p role="status">Comprobando disponibilidad de publicación…</p>
      )}
      <p className="field-help">
        {kind === "record"
          ? "Solo se enviarán los campos y archivos públicos validados de esta revisión. Los datos privados no se publican."
          : "Solo publica esta vacante revisada. No implica que se hayan consultado todas las empresas o todas las oportunidades del Perú."}{" "}
        LinkedIn y YouTube son conexiones separadas.
      </p>
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
      {!operation && !result && (
        <>
          <label className="check-field">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {kind === "record"
              ? "Confirmo el contenido y los permisos públicos de esta revisión"
              : "Confirmo los datos públicos de esta oportunidad"}
          </label>
          <button
            disabled={
              busy ||
              blocked ||
              !confirmed ||
              !remote ||
              !Number.isSafeInteger(version) ||
              version < 1
            }
            onClick={() => void prepare()}
          >
            {busy
              ? "Enviando…"
              : kind === "record"
                ? "Publicar esta revisión en main"
                : "Publicar oportunidad"}
          </button>
        </>
      )}
      {(state || operation) && <PublicationStatus value={display} />}
      {operation?.last_code &&
        !["OK", "RECONCILED"].includes(operation.last_code) && (
          <p className="field-help">
            {operation.last_code === "APPROVAL_REVOKED"
              ? "El contenido cambió después de revisarse. Vuelve a revisar la versión actual antes de enviar."
              : "Comprueba el resultado de esta operación antes de otro envío."}
          </p>
        )}
      {(uncertain || view.state === "conflict") && (
        <p>
          Tu revisión sigue guardada. No se enviará otra versión
          automáticamente.
        </p>
      )}
      <div className="toolbar">
        {changesetId && (result?.canRetryExact || result?.retrySafe) && (
          <button
            disabled={busy || blocked}
            onClick={() => void retryExisting()}
          >
            Reintentar el mismo envío
          </button>
        )}
        {!changesetId && uncertain && (
          <button disabled={busy} onClick={() => void prepare()}>
            Recuperar estado del envío
          </button>
        )}
        {changesetId && (
          <button disabled={busy} onClick={() => void reconcile()}>
            Comprobar publicación y despliegue
          </button>
        )}
        <button disabled={busy} onClick={() => void refresh()}>
          Comprobar disponibilidad
        </button>
      </div>
    </section>
  );
}

export function RecordPublication({
  user,
  recordId,
  recordType,
  revision,
  blocked,
  onReconciled,
}: {
  user: User;
  recordId: string;
  recordType: string;
  revision: number;
  blocked: boolean;
  onReconciled: () => Promise<void>;
}) {
  return (
    <JobsPublication
      user={user}
      jobId={recordId}
      version={revision}
      kind="record"
      recordType={recordType}
      blocked={blocked}
      onReconciled={onReconciled}
    />
  );
}
