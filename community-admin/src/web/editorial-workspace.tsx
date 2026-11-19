import { takeLifecycleReference } from "./lifecycle";
import {
  captureEditorialIntent,
  recoverEditorialIntent,
  forgetEditorialIntent,
} from "./editorial-publication-intent";
import { LifecycleActions } from "./lifecycle-actions";
import { NamedConfirmation } from "./named-confirmation";
import { PublicationStatus } from "./publication-status";
import React, { useEffect, useRef, useState } from "react";
import type { User } from "../shared/types";
import { ApiError, downloadFile, request } from "./client";
import { AppIcon, ProviderLogo } from "./icons";
import {
  canonicalEventPayload,
  editorialStateLabel,
  needsReconciliation,
  mayEditDraft,
  sameEditorialPayload,
  stableJson,
  mergedInSnapshot,
  type EditorialDraft,
  type EditorialSnapshot,
  type EditorialStatus,
  type PublicEvent,
} from "./editorial-state";
import "./editorial-workspace.css";
import { EditorialHistory } from "./editorial-history";
type FormRenderer = (
  payload: Record<string, any>,
  onChange: (payload: Record<string, any>) => void,
  disabled: boolean,
  errors: { path: string; message: string }[],
  pane: string,
  references: Record<string, any[]>,
) => React.ReactNode;
export function EditorialWorkspace({
  user,
  defaults,
  renderFields,
  onDirty,
}: {
  user: User;
  defaults: Record<string, any>;
  renderFields: FormRenderer;
  onDirty: (dirty: boolean) => void;
}) {
  const [pane, setPane] = useState("info");
  const [conflictReviewed, setConflictReviewed] = useState(false);
  const [batch, setBatch] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<EditorialStatus | null>(null),
    [snapshot, setSnapshot] = useState<EditorialSnapshot | null>(null),
    [drafts, setDrafts] = useState<EditorialDraft[]>([]),
    [selected, setSelected] = useState<EditorialDraft | null>(null),
    [payload, setPayload] = useState<Record<string, any>>({}),
    [desiredStatus, setDesiredStatus] = useState<"published" | "archived">(
      "published",
    ),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [notice, setNotice] = useState(""),
    [uncertainDrafts, setUncertainDrafts] = useState<Set<string>>(new Set());
  const uncertain = Boolean(
    selected &&
    (uncertainDrafts.has(selected.id) || needsReconciliation(selected)),
  );
  const draftLabel = (draft: EditorialDraft) =>
    uncertainDrafts.has(draft.id) || needsReconciliation(draft)
      ? "Resultado por confirmar · comprobar antes de publicar"
      : editorialStateLabel(draft.state);
  const failed = useRef("");
  const selection = useRef<string | null>(null);
  selection.current = selected?.id ?? null;
  const dirty = Boolean(
    selected &&
    (!sameEditorialPayload(payload, selected.payload) ||
      desiredStatus !== selected.desiredStatus),
  );
  const canWrite =
    user.capabilities?.includes("content:write") ||
    user.capabilities?.includes("*");
  const canPublish =
    user.capabilities?.includes("content:publish") ||
    user.capabilities?.includes("*");
  const headers = (version?: number) => ({
    "X-CSRF-Token": user.csrfToken,
    "Idempotency-Key": crypto.randomUUID(),
    ...(version ? { "If-Match": `"${version}"` } : {}),
  });
  const signature = stableJson({ payload, desiredStatus });
  const liveSignature = useRef(signature);
  liveSignature.current = signature;
  useEffect(() => {
    onDirty(dirty);
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => {
      onDirty(false);
      window.removeEventListener("beforeunload", guard);
    };
  }, [dirty, onDirty]);
  async function load() {
    const state = await request<EditorialStatus>("/editorial/status");
    setStatus(state);
    if (state.configured) {
      const results = await Promise.allSettled([
        request<EditorialSnapshot>("/editorial/events"),
        request<{ items: EditorialDraft[] }>("/editorial/drafts"),
      ]);
      if (results[0].status === "fulfilled") setSnapshot(results[0].value);
      else if (!(
        results[0].reason instanceof ApiError &&
        results[0].reason.code === "CACHE_EMPTY"
      ))
        throw results[0].reason;
      if (results[1].status === "fulfilled") setDrafts(results[1].value.items);
      else throw results[1].reason;
    }
  }
  useEffect(() => {
    void load()
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);
  function mayLeave() {
    return (
      !dirty ||
      confirm("Hay cambios sin guardar. ¿Descartarlos y abrir otro evento?")
    );
  }
  function choose(draft: EditorialDraft) {
    if (!mayLeave()) return;
    setSelected(draft);
    setPane("info");
    setConflictReviewed(false);
    setPayload(structuredClone(draft.payload));
    setDesiredStatus(draft.desiredStatus);
    setError(null);
    failed.current = "";
    requestAnimationFrame(() =>
      document.getElementById("editorial-event-editor")?.focus(),
    );
  }
  async function edit(record?: PublicEvent) {
    if (!snapshot || !mayLeave()) return;
    const existing =
      record &&
      drafts.find(
        (d) =>
          d.recordId === record.id &&
          d.state !== "closed" &&
          d.state !== "merged",
      );
    if (existing) {
      choose(existing);
      return;
    }
    const draft: EditorialDraft = {
      id: crypto.randomUUID(),
      recordId: record?.id ?? crypto.randomUUID(),
      type: "events",
      baseCommit: snapshot.commit,
      baseRecordHash: record ? snapshot.recordHashes[record.id] : null,
      version: 0,
      payload: record
        ? canonicalEventPayload(record, defaults)
        : { ...structuredClone(defaults), communityKind: "own" },
      desiredStatus: record?.status === "archived" ? "archived" : "published",
      updatedAt: new Date().toISOString(),
      state: "local",
    };
    choose(draft);
  }
  useEffect(() => {
    if (!snapshot) return;
    const raw = sessionStorage.getItem("admin-open-record");
    if (!raw) return;
    try {
      const intent = JSON.parse(raw);
      if (intent.type !== "events") return;
      sessionStorage.removeItem("admin-open-record");
      const draft = drafts.find((d) => d.recordId === intent.id);
      if (draft) choose(draft);
      else {
        const record = snapshot.records.find((r) => r.id === intent.id);
        if (record) void edit(record);
      }
    } catch {
      sessionStorage.removeItem("admin-open-record");
    }
  }, [snapshot]);
  useEffect(() => {
    if (!drafts.length) return;
    const linked = takeLifecycleReference("editorial-drafts");
    if (linked) {
      const found = drafts.find((d) => d.id === linked);
      if (found) choose(found);
      else
        setError(
          new Error(
            "El borrador vinculado no está disponible en esta consulta.",
          ),
        );
    }
  }, [drafts]);
  async function save() {
    if (!selected || busy || !canWrite || !mayEditDraft(selected)) return;
    const draft = selected,
      captured = structuredClone(payload),
      desired = desiredStatus,
      sig = signature;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const saved = await request<EditorialDraft>(
        `/editorial/drafts/${draft.id}`,
        {
          method: "PUT",
          headers: headers(draft.version),
          body: JSON.stringify({
            recordId: draft.recordId,
            baseCommit: draft.baseCommit,
            baseRecordHash: draft.baseRecordHash,
            payload: captured,
            desiredStatus: desired,
          }),
        },
      );
      setDrafts((rows) => [saved, ...rows.filter((r) => r.id !== saved.id)]);
      if (selection.current === saved.id) {
        setSelected(saved);
        if (liveSignature.current === sig) {
          setPayload(structuredClone(saved.payload));
          setDesiredStatus(saved.desiredStatus);
        }
      }
      failed.current = "";
      setNotice("Guardado en este equipo. Todavía no se ha enviado a GitHub.");
    } catch (e) {
      failed.current = sig;
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (
      !dirty ||
      busy ||
      !canWrite ||
      !selected ||
      !mayEditDraft(selected) ||
      signature === failed.current
    )
      return;
    const timer = setTimeout(() => void save(), 800);
    return () => clearTimeout(timer);
  }, [signature, dirty, busy, canWrite]);
  async function pull() {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const next = await request<EditorialSnapshot>("/editorial/pull", {
        method: "POST",
        headers: headers(),
        body: "{}",
      });
      setSnapshot(next);
      if (selected?.conflict) setConflictReviewed(true);
      setStatus(await request("/editorial/status"));
      setNotice(
        "Versión de GitHub consultada. Tus borradores y el texto abierto se conservaron.",
      );
    } catch (e) {
      setError(e);
      setStatus((s) => (s ? { ...s, connection: "offline" } : s));
      setSnapshot((s) => (s ? { ...s, stale: true } : s));
    } finally {
      setBusy(false);
    }
  }
  async function action(action: "propose" | "reconcile" | "retry") {
    if (
      !selected ||
      ((action === "propose" || action === "retry") &&
        (dirty || !canPublish)) ||
      !selected.version
    )
      return;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const intent =
        action === "retry"
          ? recoverEditorialIntent(user.id, selected.id, selected.version)
          : action === "propose"
            ? captureEditorialIntent(user.id, [
                { id: selected.id, version: selected.version },
              ])
            : null;
      if (
        action === "retry" &&
        (!selected.submission?.canRetryExact || !intent)
      )
        throw Error(
          "No está disponible la selección original de este envío. Conserva tu copia y comprueba su estado.",
        );
      const batchRetry = action === "retry" && intent!.ids.length > 1;
      const response = await request<
        EditorialDraft | { items: EditorialDraft[] }
      >(
        batchRetry
          ? "/editorial/proposals"
          : `/editorial/drafts/${selected.id}/${action === "retry" ? "propose" : action}`,
        {
          method: "POST",
          headers: {
            ...headers(),
            ...(intent ? { "Idempotency-Key": intent.key } : {}),
          },
          body: JSON.stringify(
            batchRetry
              ? {
                  drafts: intent!.ids.map((id) => ({
                    id,
                    expectedVersion: intent!.versions[id],
                  })),
                }
              : action === "propose" || action === "retry"
                ? { expectedVersion: intent!.versions[selected.id] }
                : {},
          ),
        },
      );
      const returned = "items" in response ? response.items : [response];
      const next = returned.find((row) => row.id === selected.id)!;
      if (!next)
        throw Error(
          "El servicio no devolvió el borrador solicitado. Comprueba el envío original.",
        );
      if (
        intent &&
        [
          "committed",
          "deployed",
          "deployment_failed",
          "merged",
          "closed",
          "conflict",
        ].includes(next.state)
      )
        forgetEditorialIntent(user.id, intent);

      setSelected(next);
      setUncertainDrafts((current) => {
        const nextSet = new Set(current);
        nextSet.delete(next.id);
        return nextSet;
      });
      setDrafts((rows) => [
        ...returned,
        ...rows.filter((r) => !returned.some((d) => d.id === r.id)),
      ]);
      if (
        ["merged", "committed", "deployed", "deployment_failed"].includes(
          next.state,
        )
      ) {
        const refreshed = await request<EditorialSnapshot>("/editorial/pull", {
          method: "POST",
          headers: headers(),
          body: "{}",
        });
        setSnapshot(refreshed);
      }
      setNotice(
        action === "propose"
          ? "Envío registrado. Comprueba el commit y el despliegue por separado."
          : "Estado remoto consultado.",
      );
    } catch (e) {
      setError(e);
      if (
        e instanceof ApiError &&
        [
          "PROPOSAL_UNCERTAIN",
          "PUBLICATION_UNCERTAIN",
          "OFFLINE",
          "REMOTE_UNAVAILABLE",
        ].includes(e.code)
      )
        setUncertainDrafts((current) => new Set(current).add(selected.id));
      try {
        const saved = await request<{ items: EditorialDraft[] }>(
          "/editorial/drafts",
        );
        setDrafts(saved.items);
        const current = saved.items.find((d) => d.id === selected.id);
        if (current) setSelected(current);
      } catch {
        /* Keep the open local text and last confirmed draft. */
      }
    } finally {
      setBusy(false);
    }
  }
  async function proposeBatch() {
    if (!batch.size || dirty || busy || !canPublish) return;
    const selectedDrafts = drafts.filter((d) => batch.has(d.id));
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const intent = captureEditorialIntent(user.id, selectedDrafts);
      const result = await request<{ items: EditorialDraft[] }>(
        "/editorial/proposals",
        {
          method: "POST",
          headers: { ...headers(), "Idempotency-Key": intent.key },
          body: JSON.stringify({
            drafts: selectedDrafts.map((d) => ({
              id: d.id,
              expectedVersion: d.version,
            })),
          }),
        },
      );
      setDrafts((rows) => [
        ...result.items,
        ...rows.filter((row) => !result.items.some((d) => d.id === row.id)),
      ]);
      const current = result.items.find((d) => d.id === selected?.id);
      if (current) setSelected(current);
      setBatch(new Set());
      setNotice(
        `Estado del envío conjunto consultado para ${result.items.length} eventos. Revisa los estados confirmados.`,
      );
    } catch (error) {
      setError(error);
      if (
        error instanceof ApiError &&
        [
          "PROPOSAL_UNCERTAIN",
          "PUBLICATION_UNCERTAIN",
          "OFFLINE",
          "REMOTE_UNAVAILABLE",
        ].includes(error.code)
      )
        setUncertainDrafts(
          (current) =>
            new Set([...current, ...selectedDrafts.map((d) => d.id)]),
        );
      try {
        setDrafts(
          (await request<{ items: EditorialDraft[] }>("/editorial/drafts"))
            .items,
        );
      } catch {
        /* Preserve known drafts and unsaved text. */
      }
    } finally {
      setBusy(false);
    }
  }
  async function resolveOnLatest() {
    if (
      !selected ||
      !snapshot ||
      !conflictReviewed ||
      !confirm(
        "Crear un nuevo borrador con tu texto sobre la versión de GitHub consultada. El anterior se conserva.",
      )
    )
      return;
    const remote = snapshot.records.find((r) => r.id === selected.recordId);
    const next = {
      ...selected,
      id: crypto.randomUUID(),
      version: 0,
      baseCommit: snapshot.commit,
      baseRecordHash: remote ? snapshot.recordHashes[remote.id] : null,
      state: "local" as const,
      proposal: undefined,
      conflict: undefined,
      payload: structuredClone(payload),
    };
    setSelected(next);
    failed.current = "";
    setNotice(
      "Nueva base elegida explícitamente. Guarda para conservar este nuevo borrador.",
    );
  }
  const problem = error instanceof Error ? error.message : String(error ?? "");
  const fields = error instanceof ApiError ? error.fieldErrors : [];
  return (
    <div className="editorial-workspace">
      <div className="page-heading">
        <div>
          <span className="eyebrow">CONTENIDO / FUENTE COMPARTIDA</span>
          <h1>
            <AppIcon name="calendar" size={28} /> Eventos
          </h1>
          <p>
            Los eventos se publican desde este admin directamente en main. Los
            contactos privados conservan su fuente local.
          </p>
        </div>
        <button
          className="primary"
          disabled={!snapshot || !canWrite || busy}
          onClick={() => void edit()}
        >
          <AppIcon name="plus" size={18} />
          Nuevo evento
        </button>
      </div>
      <section className="panel editorial-source">
        <ProviderLogo provider="github" size={32} />
        <div>
          <h2>
            {!status?.configured
              ? "GitHub no configurado"
              : status.connection === "offline" || snapshot?.stale
                ? "Sin conexión · versión consultada conservada"
                : "Versión de GitHub consultada"}
          </h2>
          <p>
            {status?.repository
              ? `${status.repository} · ${status.branch}`
              : "Configura EDITORIAL_MODE=github y el repositorio editorial en el servidor."}
          </p>
          <small>
            {snapshot
              ? `Última consulta: ${new Date(snapshot.fetchedAt).toLocaleString("es-PE", { timeZone: "America/Lima" })} · ${snapshot.commit.slice(0, 8)}`
              : "Aún no se ha consultado una versión compartida. No se muestran registros locales como si vinieran de GitHub."}
          </small>
          {status?.identity && (
            <small>Cuenta verificada: @{status.identity.login}</small>
          )}
        </div>
        <button
          disabled={busy || !status?.configured}
          onClick={() => void pull()}
        >
          <AppIcon name="refresh" size={18} />
          Consultar GitHub
        </button>
      </section>
      {loading && <p role="status">Consultando fuente editorial…</p>}
      {problem && (
        <div className="alert warning" role="alert">
          <strong>No se pudo completar la operación.</strong>
          <p>{problem}</p>
          <p>Tu texto abierto se conserva.</p>
          {uncertain && (
            <p>
              No se pudo confirmar si GitHub recibió la publicación. Usa
              «Comprobar resultado» antes de publicar otra vez.
            </p>
          )}
        </div>
      )}
      {notice && (
        <p className="alert info" role="status">
          {notice}
        </p>
      )}
      {!status?.configured && !loading && (
        <section className="panel">
          <h2>Conecta una fuente, sin cambiar tus datos locales</h2>
          <p>
            El propietario configura el repositorio y la rama en el servidor.
            Los envíos están deshabilitados por defecto; consultar GitHub y
            guardar borradores son operaciones independientes.
          </p>
          <p>No se ha creado ni modificado ningún repositorio.</p>
        </section>
      )}
      <div className="editorial-columns">
        <section
          className="panel editorial-event-list"
          id="editorial-event-list"
          tabIndex={-1}
        >
          <h2>
            Versión compartida <span>{snapshot?.records.length ?? 0}</span>
          </h2>
          {snapshot?.records.map((record) => (
            <button
              key={record.id}
              className="editorial-record"
              onClick={() => void edit(record)}
            >
              <AppIcon name="calendar" size={22} />
              <span>
                <strong>
                  {record.title?.["es-pe"] ||
                    record.title?.en ||
                    record.slug ||
                    record.id}
                </strong>
                <small>
                  {record.date} · {record.time} ·{" "}
                  {record.status === "archived"
                    ? "Archivado en GitHub"
                    : "Versión de GitHub"}
                </small>
                {drafts.some((d) => d.recordId === record.id) && (
                  <em>Tiene un borrador local separado</em>
                )}
              </span>
              <AppIcon name="arrowRight" size={16} />
            </button>
          ))}
          {snapshot && !snapshot.records.length && (
            <p>No hay eventos en esta versión de GitHub.</p>
          )}
          <h2>
            Borradores de este equipo <span>{drafts.length}</span>
          </h2>
          {drafts.map((draft) => (
            <div key={draft.id} className="editorial-draft-option">
              <label className="editorial-batch-check">
                <input
                  type="checkbox"
                  aria-label={`Seleccionar borrador ${draft.payload.title?.["es-pe"] || draft.payload.slug || draft.id}`}
                  checked={batch.has(draft.id)}
                  disabled={
                    !canWrite ||
                    !["local", "retryable"].includes(draft.state) ||
                    uncertainDrafts.has(draft.id) ||
                    needsReconciliation(draft)
                  }
                  onChange={(event) =>
                    setBatch((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(draft.id);
                      else next.delete(draft.id);
                      return next;
                    })
                  }
                />
              </label>
              <button
                className="editorial-record"
                aria-current={selected?.id === draft.id ? "true" : undefined}
                onClick={() => choose(draft)}
              >
                <AppIcon name="file" size={22} />
                <span>
                  <strong>
                    {draft.payload.title?.["es-pe"] ||
                      draft.payload.slug ||
                      "Evento sin título"}
                  </strong>
                  <small>{draftLabel(draft)}</small>
                  {draft.proposal && <small>PR #{draft.proposal.number}</small>}
                </span>
              </button>
            </div>
          ))}
          {drafts.length > 0 && (
            <>
              <button
                disabled={
                  !batch.size ||
                  dirty ||
                  busy ||
                  !canPublish ||
                  !status?.remoteWritesEnabled ||
                  drafts.some(
                    (d) =>
                      batch.has(d.id) &&
                      (uncertainDrafts.has(d.id) || needsReconciliation(d)),
                  )
                }
                onClick={() => void proposeBatch()}
              >
                <ProviderLogo provider="github" size={18} /> Publicar
                seleccionados ({batch.size})
              </button>
              <p className="field-help">
                Un único commit contiene los eventos seleccionados. Guarda
                primero cualquier cambio abierto.
              </p>
            </>
          )}
          {!drafts.length && <p>No hay borradores locales.</p>}
        </section>
        {selected ? (
          <section className="panel" id="editorial-event-editor" tabIndex={-1}>
            <header className="section-heading">
              <div>
                <span className="eyebrow">BORRADOR LOCAL</span>
                <h2>{payload.title?.["es-pe"] || "Editar evento"}</h2>
                <p role="status">
                  {busy
                    ? "Operación en curso…"
                    : dirty
                      ? "Cambios sin guardar"
                      : selected.version
                        ? "Guardado en este equipo"
                        : "Nuevo borrador · aún no guardado"}
                </p>
              </div>
              <button
                onClick={() =>
                  downloadFile(
                    { payload, desiredStatus, baseCommit: selected.baseCommit },
                    "evento-borrador-local.json",
                  )
                }
              >
                <AppIcon name="download" size={18} />
                Guardar copia
              </button>
            </header>
            <div className="editorial-actions">
              <button
                className="primary"
                disabled={busy || !canWrite || !mayEditDraft(selected)}
                onClick={() => void save()}
              >
                Guardar borrador local
              </button>
              <button
                disabled={
                  busy ||
                  dirty ||
                  !selected.version ||
                  !canPublish ||
                  !status?.remoteWritesEnabled ||
                  uncertain ||
                  selected.state === "conflict" ||
                  selected.state === "proposed" ||
                  [
                    "merged",
                    "committed",
                    "deployed",
                    "deployment_failed",
                  ].includes(selected.state)
                }
                onClick={() => void action("propose")}
              >
                <ProviderLogo provider="github" size={18} />
                Publicar evento en main
              </button>
              {selected.submission?.canRetryExact && (
                <button
                  disabled={
                    busy ||
                    dirty ||
                    !canPublish ||
                    !recoverEditorialIntent(
                      user.id,
                      selected.id,
                      selected.version,
                    )
                  }
                  onClick={() => void action("retry")}
                >
                  Reintentar el mismo envío
                </button>
              )}
              {selected.version > 0 ? (
                <LifecycleActions
                  target={{
                    module: "editorial-drafts",
                    id: selected.id,
                    version: selected.version,
                    name:
                      selected.payload.title?.["es-pe"] || "Evento sin título",
                  }}
                  disabled={
                    busy || dirty || uncertain || !mayEditDraft(selected)
                  }
                  onReload={async () => {
                    const response = await request<{ items: EditorialDraft[] }>(
                      "/editorial/drafts",
                    );
                    const found = response.items.find(
                      (d) => d.id === selected.id,
                    );
                    if (!found)
                      throw new Error("El borrador ya no está disponible.");
                    setDrafts(response.items);
                    choose(found);
                  }}
                  onComplete={async () => {
                    const name = selected.payload.title?.["es-pe"] || "Evento";
                    setSelected(null);
                    setPayload({});
                    setBatch((current) => {
                      const next = new Set(current);
                      next.delete(selected.id);
                      return next;
                    });
                    await load();
                    requestAnimationFrame(() =>
                      document.getElementById("editorial-event-list")?.focus(),
                    );
                    setNotice(
                      `Borrador local de «${name}» descartado. GitHub y el historial de envíos no cambiaron.`,
                    );
                  }}
                />
              ) : (
                <NamedConfirmation
                  target={{
                    module: "editorial-drafts",
                    id: selected.id,
                    version: 0,
                    name: payload.title?.["es-pe"] || "Evento sin título",
                  }}
                  label="Descartar cambios sin guardar…"
                  title="Descartar los cambios sin guardar de"
                  description="Estos cambios solo existen en el editor. Se cerrará este borrador sin enviar modificaciones a GitHub."
                  confirmLabel="Descartar cambios sin guardar"
                  disabled={busy || uncertain}
                  onConfirm={async () => {
                    setSelected(null);
                    setPayload({});
                    requestAnimationFrame(() =>
                      document.getElementById("editorial-event-list")?.focus(),
                    );
                  }}
                />
              )}

              {selected.version > 0 && (
                <button
                  disabled={busy}
                  onClick={() => void action("reconcile")}
                >
                  Comprobar resultado
                </button>
              )}
            </div>
            <div className="editorial-status-note">
              {selected.submission?.publicationMode === "direct" ||
              selected.publicationMode === "direct" ||
              ["committed", "deployed", "deployment_failed"].includes(
                selected.state,
              ) ? (
                <PublicationStatus
                  value={{ ...selected, ...selected.submission }}
                />
              ) : (
                <strong>{draftLabel(selected)}</strong>
              )}
              {uncertain && (
                <p>
                  Comprueba el resultado antes de guardar otra revisión o
                  publicar. Puedes seguir escribiendo y descargar una copia; tu
                  texto abierto se conserva.
                </p>
              )}
              {dirty && selected.proposal && (
                <p>Tu texto sin guardar no forma parte de este envío.</p>
              )}
              {selected.state === "merged" && (
                <p>
                  {mergedInSnapshot(selected, snapshot)
                    ? "Integrado en la versión consultada. El despliegue del sitio se verifica por separado."
                    : "El commit está guardado; falta consultar una versión canónica que coincida con este borrador."}
                </p>
              )}
              {selected.proposal && (
                <p>
                  <a
                    href={selected.proposal.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    PR #{selected.proposal.number} en GitHub{" "}
                    <AppIcon name="external" size={14} />
                  </a>
                </p>
              )}
            </div>
            {selected.conflict && (
              <div className="editorial-conflict">
                <h3>El evento cambió en GitHub</h3>
                <p>
                  Compara las tres versiones. Tu texto se conserva; no se
                  sobrescribe la fuente compartida.
                </p>
                <div>
                  {[
                    ["Base", selected.conflict.base],
                    ["Tu borrador", payload],
                    [
                      "GitHub",
                      conflictReviewed
                        ? (snapshot?.records.find(
                            (r) => r.id === selected.recordId,
                          ) ?? null)
                        : selected.conflict.remote,
                    ],
                  ].map(([name, value]) => (
                    <details key={String(name)}>
                      <summary>{String(name)}</summary>
                      <pre>{JSON.stringify(value, null, 2)}</pre>
                    </details>
                  ))}
                </div>
                <button onClick={() => void pull()} disabled={busy}>
                  Consultar versión más reciente
                </button>
                <button
                  onClick={() => void resolveOnLatest()}
                  disabled={busy || !snapshot || !canWrite || !conflictReviewed}
                >
                  Conservar mi texto en un nuevo borrador sobre esta versión
                </button>
              </div>
            )}
            <nav
              className="editorial-form-tabs"
              aria-label="Secciones del evento"
            >
              {[
                ["info", "Información", "calendar"],
                ["content", "Contenido", "file"],
                ["relationships", "Relaciones", "link"],
              ].map(([id, label, icon]) => (
                <button
                  key={id}
                  aria-current={pane === id ? "step" : undefined}
                  onClick={() => setPane(id)}
                >
                  <AppIcon name={icon} size={18} />
                  {label}
                </button>
              ))}
            </nav>
            {fields.length > 0 && (
              <ul className="alert warning">
                {fields.map((field) => (
                  <li key={field.path}>
                    {field.path}: {field.message}
                  </li>
                ))}
              </ul>
            )}
            {renderFields(payload, setPayload, !canWrite, fields, pane, {
              speakers: (snapshot?.references?.speakers ?? []).map((s) => ({
                id: s.id,
                payload: { name: s.name },
              })),
            })}
            <NamedConfirmation
              target={{
                module: "editorial-withdrawal",
                id: selected.id,
                version: selected.version,
                name: payload.title?.["es-pe"] || "Evento sin título",
              }}
              label="Retirar evento del sitio…"
              title="Preparar la retirada del sitio de"
              description="Se marcará este borrador para retirar el evento. Debes guardar y publicar esa revisión y comprobar su despliegue; el evento puede seguir visible hasta entonces. No se elimina su historial."
              confirmLabel="Marcar retirada en el borrador"
              disabled={
                busy ||
                uncertain ||
                !canWrite ||
                !mayEditDraft(selected) ||
                desiredStatus === "archived"
              }
              onConfirm={async () => {
                setDesiredStatus("archived");
                setNotice(
                  "Retirada marcada en el editor. Guarda y publica esta revisión; todavía no se confirmó su retirada del sitio.",
                );
              }}
            />
            {desiredStatus === "archived" && (
              <p className="alert info">
                Este borrador solicita retirar el evento. Solo una publicación
                con despliegue verificado confirma el cambio en el sitio.
              </p>
            )}
            <label>
              Estado público deseado
              <select
                value={desiredStatus}
                disabled={!canWrite}
                onChange={(e) =>
                  setDesiredStatus(e.target.value as "published" | "archived")
                }
              >
                <option value="published">
                  Visible tras integrar y desplegar
                </option>
                <option value="archived">
                  Archivado tras integrar y desplegar
                </option>
              </select>
            </label>
            {!canWrite && (
              <p className="field-help">
                Tu cuenta puede consultar eventos; no tiene permiso para guardar
                o publicar cambios.
              </p>
            )}
            {!status?.remoteWritesEnabled && (
              <p className="field-help">
                Los envíos a GitHub no están habilitados. Puedes conservar el
                borrador local.
              </p>
            )}
            {dirty && (
              <p className="field-help">
                Guarda tu texto antes de publicar. Consultar el resultado
                conserva lo que estás escribiendo.
              </p>
            )}
            <details>
              <summary>Revisiones y fuente</summary>
              <p>Revisión local: {selected.version || "sin guardar"}</p>
              <p>Commit de base: {selected.baseCommit}</p>
              <p>Identidad estable del evento: {selected.recordId}</p>
              {(selected.submissionHistory ?? [])
                .filter((s) => s.id !== selected.submission?.id)
                .map((submission) => (
                  <div key={submission.id}>
                    {submission.publicationMode === "direct" ||
                    submission.commitSha ? (
                      <PublicationStatus value={submission} />
                    ) : (
                      <>
                        <p>
                          Envío anterior · estado registrado:{" "}
                          {submission.state === "merged"
                            ? "integrado en GitHub"
                            : submission.state === "closed"
                              ? "PR cerrada"
                              : "revisión en GitHub"}
                        </p>
                        {(submission.proposal ?? submission.remote) && (
                          <a
                            href={
                              (submission.proposal ?? submission.remote)!.url
                            }
                            target="_blank"
                            rel="noreferrer"
                          >
                            PR #
                            {(submission.proposal ?? submission.remote)!.number}{" "}
                            · revisión anterior
                          </a>
                        )}
                      </>
                    )}
                  </div>
                ))}
            </details>
          </section>
        ) : (
          <section className="panel editorial-start">
            <AppIcon name="calendar" size={44} />
            <h2>Un evento, una fuente compartida</h2>
            <p>
              Abre un evento para preparar un borrador local. Un envío a GitHub
              aún no cambia la versión compartida.
            </p>
          </section>
        )}
      </div>
      {status?.configured && (
        <EditorialHistory
          user={user}
          refreshKey={drafts
            .map((d) => `${d.id}:${d.version}:${d.state}`)
            .join("|")}
        />
      )}
    </div>
  );
}
