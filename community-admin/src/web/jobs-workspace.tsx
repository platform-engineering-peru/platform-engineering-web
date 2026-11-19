import { takeLifecycleReference } from "./lifecycle";
import React, { useEffect, useRef, useState } from "react";
import type { User } from "../shared/types";
import { request, ApiError } from "./client";
import { localTimeToInstant } from "./schedule";
import { AppIcon } from "./icons";
import { LifecycleActions, LifecycleRetention } from "./lifecycle-actions";
import { NamedConfirmation } from "./named-confirmation";
import { lifecycleCopy, type LifecycleDescriptor } from "./lifecycle";
import { JobsIntake } from "./jobs-intake";
import { JobsPublication } from "./jobs-publication";
import {
  editableSourceConfig,
  jobQueueStates,
  jobGeographyLabel,
  jobLabels,
  jobMoment,
  jobSourceLabel,
  jobPublicationRevision,
  jobFailureMessage,
  jobOperationMessage,
  jobRunScope,
  publicHref,
} from "./jobs-ui";
type Props = {
  section: string;
  user: User;
  onNavigate: (section: string) => void;
};
const headings: Record<string, string> = {
  "jobs-candidates": "Vacantes por revisar",
  "jobs-active": "Activas",
  "jobs-stale": "Por verificar",
  "jobs-closed": "Cerradas",
  "job-sources": "Empresas y fuentes",
  "collection-runs": "Recolecciones",
  "job-exclusions": "Exclusiones",
};
const allowed = (user: User, cap: string) =>
  Boolean(user.capabilities?.includes("*") || user.capabilities?.includes(cap));
function Badge({ state }: { state: string }) {
  return (
    <span className="badge">
      {state === "curator-withdrawn"
        ? "Retirada editorial"
        : (jobLabels[state] ?? state)}
    </span>
  );
}
function Link({
  href,
  children,
}: {
  href: unknown;
  children: React.ReactNode;
}) {
  const url = publicHref(href);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      {children} ↗
    </a>
  ) : null;
}
export function JobsWorkspace({ section, user, onNavigate }: Props) {
  const [status, setStatus] = useState<any>(null),
    [sources, setSources] = useState<any[]>([]),
    [items, setItems] = useState<any[]>([]),
    [duplicates, setDuplicates] = useState<any[]>([]),
    [runs, setRuns] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(null),
    [query, setQuery] = useState(""),
    [geographyScope, setGeographyScope] = useState("qualified"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true);
  const [selectedLifecycle, setSelectedLifecycle] =
    useState<LifecycleDescriptor | null>(null);
  const [adding, setAdding] = useState(false),
    [careersUrl, setCareersUrl] = useState(""),
    [company, setCompany] = useState(""),
    [discovery, setDiscovery] = useState<any>(null),
    [proposed, setProposed] = useState<any>(null),
    [sourceEdit, setSourceEdit] = useState<any>(null),
    [reviewed, setReviewed] = useState(false),
    [operation, setOperation] = useState<any>(null);
  const [expiry, setExpiry] = useState(""),
    [editExpiry, setEditExpiry] = useState(false);
  const [reason, setReason] = useState(""),
    [eligibility, setEligibility] = useState("unknown"),
    [summary, setSummary] = useState({ "es-pe": "", en: "" });
  const [intakeOpen, setIntakeOpen] = useState(false),
    [intakeEditing, setIntakeEditing] = useState<any>(null),
    [intakeDirty, setIntakeDirty] = useState(false),
    [intakeResult, setIntakeResult] = useState<any>(null);
  const dirty =
    intakeDirty ||
    Boolean(careersUrl && !discovery) ||
    Boolean(proposed) ||
    Boolean(sourceEdit) ||
    Boolean(reason) ||
    editExpiry ||
    Boolean(
      selected &&
      selected.payload &&
      (summary["es-pe"] !== selected.payload.summary?.["es-pe"] ||
        summary.en !== selected.payload.summary?.en),
    );
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("product-dirty", { detail: dirty }));
    return () => {
      window.dispatchEvent(new CustomEvent("product-dirty", { detail: false }));
    };
  }, [dirty]);
  const headers = () => ({
    "X-CSRF-Token": user.csrfToken,
    "Idempotency-Key": crypto.randomUUID(),
  });
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "SOURCE_ALREADY_EXISTS"
          ? "Esta bolsa ya está registrada. Abre la empresa existente; no se reemplazó su configuración."
          : e instanceof ApiError && e.code === "COLLECTION_DISABLED"
            ? "La lectura de empleos está deshabilitada en este entorno. No necesitas habilitar la publicación social para leer fuentes públicas."
            : e instanceof Error
              ? e.message
              : "No se pudo completar. Conservamos tu información.",
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function allSources() {
    const rows: any[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await request<any>(
        `/job-sources?limit=100${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
      );
      rows.push(...r.items);
      cursor = r.nextCursor;
    } while (cursor && rows.length < 1000);
    return rows;
  }
  async function findJob(id: string) {
    let cursor: string | null = null,
      found: any = null,
      scanned = 0;
    do {
      const page: any = await request(
        `/jobs/candidates?scope=all&limit=100${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
      );
      found = page.items.find((r: any) => r.id === id);
      scanned += page.items.length;
      cursor = page.nextCursor;
    } while (!found && cursor && scanned < 1000);
    if (!found)
      throw new Error(
        "La vacante no está disponible en esta consulta autorizada.",
      );
    return found;
  }
  async function load() {
    const [s, sourceRows, history] = await Promise.all([
      request("/jobs/status"),
      allSources(),
      request<any>("/jobs/runs?limit=50"),
    ]);
    if (!alive.current) return;
    setStatus(s);
    setSources(sourceRows);
    const linkedSource = takeLifecycleReference("job-sources");
    if (linkedSource) {
      const found = sourceRows.find((r: any) => r.id === linkedSource);
      if (found) choose(found);
      else
        setError(
          "La fuente vinculada no está disponible en esta lista autorizada.",
        );
    }
    const linkedJob = takeLifecycleReference("jobs");
    if (linkedJob) {
      const found = await findJob(linkedJob);
      if (found) choose(found);
      else
        setError(
          "La vacante vinculada no está disponible en esta consulta autorizada.",
        );
    }
    setSelected((current: any) =>
      current?.config
        ? (sourceRows.find((row: any) => row.id === current.id) ?? current)
        : current,
    );
    setRuns(history.items ?? []);
    if (section.startsWith("jobs-") || section === "job-exclusions") {
      const groups: any[] = [];
      const pages = await Promise.all(
        jobQueueStates(section).map(async (state) => {
          let cursor: string | null = null;
          const found: any[] = [];
          do {
            const page: any = await request<any>(
              `/jobs/candidates?scope=${section === "jobs-candidates" ? geographyScope : "all"}&state=${state}&q=${encodeURIComponent(query)}&limit=100${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
            );
            groups.push(...(page.strongDuplicateSuggestions ?? []));
            found.push(...page.items);
            cursor = page.nextCursor;
          } while (cursor && found.length < 1000);
          return found;
        }),
      );
      const loaded = [...new Map(pages.flat().map((r) => [r.id, r])).values()];
      if (alive.current) {
        setItems(loaded);
        setDuplicates([
          ...new Map(groups.map((g) => [g.ids.join("|"), g])).values(),
        ]);
      }
      return loaded;
    }
  }
  useEffect(() => {
    setSelected(null);
    setLoading(true);
    void load()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [section, query, geographyScope]);
  useEffect(() => {
    if (
      !operation?.id ||
      !["queued", "sending", "retry", "unknown"].includes(operation.state)
    )
      return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void request<any>(`/operations/${operation.id}`)
        .then(async (op) => {
          if (!alive.current) return;
          setOperation(op);
          await load();
        })
        .catch((e) => setError(e.message));
    }, 1500);
    return () => clearInterval(timer);
  }, [operation?.id, operation?.state, section]);
  function choose(record: any) {
    if (
      dirty &&
      !confirm("Hay cambios sin guardar. ¿Descartarlos y abrir otro registro?")
    )
      return;
    setSelected(record);
    setSourceEdit(null);
    setReviewed(false);
    setReason("");
    setSummary(record.payload?.summary ?? { "es-pe": "", en: "" });
    setEligibility(record.payload?.eligibility ?? "unknown");
    setEditExpiry(false);
    setExpiry("");
  }
  async function saveSource(config: any, version?: number) {
    if (
      proposed &&
      sources.some(
        (existing) =>
          existing.config.adapter === config.adapter &&
          existing.config.boardIdentifier.toLowerCase() ===
            config.boardIdentifier.toLowerCase(),
      )
    )
      throw new Error(
        "Esta bolsa ya está registrada. Abre la empresa existente; no se reemplazó su configuración.",
      );
    const r = await request<any>(
      `/job-sources/${encodeURIComponent(config.id)}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({
          config: editableSourceConfig(config),
          ...(version ? { version } : {}),
        }),
      },
    );
    setSelected(r);
    setSourceEdit(null);
    setProposed(null);
    setAdding(false);
    setCareersUrl("");
    setCompany("");
    setDiscovery(null);
    setReviewed(false);
    await load();
    return r;
  }
  async function collect(source: any) {
    await action(async () => {
      const op = await request<any>(
        `/job-sources/${encodeURIComponent(source.id)}/run`,
        { method: "POST", headers: headers(), body: "{}" },
      );
      setOperation(op);
      setNotice(
        "Solicitud registrada. El resultado aparecerá cuando termine la recolección.",
      );
      await load();
    });
  }
  async function review(decision: string) {
    if (decision === "approve" && selected?.geography?.qualified !== true)
      return;
    await action(async () => {
      const r: any = await request<any>(
        `/jobs/${encodeURIComponent(selected.id)}/review`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            decision,
            reason,
            eligibility,
            version: selected.version,
            ...(decision === "approve" ? { summary } : {}),
            ...(editExpiry
              ? {
                  expiresAt: expiry
                    ? localTimeToInstant(expiry, "America/Lima")
                    : null,
                }
              : {}),
          }),
        },
      );
      setSelected(r);
      setReason("");
      setEditExpiry(false);
      setSummary(r.payload?.summary ?? summary);
      await load();
      setNotice(
        "Decisión guardada. La publicación del sitio es un paso independiente.",
      );
    });
  }
  const isSources = section === "job-sources",
    isRuns = section === "collection-runs",
    visibleSources = sources.filter((s) =>
      `${s.config.company} ${s.config.careersUrl ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ),
    source = selected?.config ? selected : null,
    job = selected?.payload,
    sourceRetired =
      source &&
      (source.retired === true ||
        (selectedLifecycle &&
          selectedLifecycle.id === source.id &&
          (selectedLifecycle.state === "retired" ||
            selectedLifecycle.retentionReason === "SOURCE_RETIRED" ||
            selectedLifecycle.actions.some(
              (action) => action.reason === "SOURCE_RETIRED",
            ))));
  return (
    <div className="jobs-workspace">
      <header className="page-heading">
        <div>
          <div className="eyebrow">OPORTUNIDADES / VACANTES DE EMPRESAS</div>
          <h1>
            <AppIcon name="jobs" size={28} />
            {headings[section] ?? "Oportunidades"}
          </h1>
          <p>
            DevOps, Platform Engineering, SRE, FDE e Infrastructure Engineering.
          </p>
        </div>
        <div className="toolbar">
          {allowed(user, "jobs:curate") && (
            <button
              disabled={busy || dirty}
              onClick={() => {
                setIntakeEditing(null);
                setIntakeOpen(true);
                setIntakeResult(null);
              }}
            >
              <AppIcon name="link" size={17} />
              Añadir vacante por enlace
            </button>
          )}

          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await load();
              })
            }
          >
            <AppIcon name="refresh" size={17} />
            Actualizar
          </button>
          <button
            className="primary"
            onClick={() => {
              if (isSources) setAdding(true);
              else onNavigate("job-sources");
            }}
          >
            <AppIcon name="plus" size={18} />
            Añadir empresa
          </button>
        </div>
      </header>
      {error && (
        <div role="alert" className="alert error">
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="alert success">
          {notice}
        </p>
      )}
      {intakeOpen && (
        <JobsIntake
          user={user}
          key={intakeEditing?.id ?? "new"}
          initialCompany={company}
          initialRecord={intakeEditing}
          onDirty={setIntakeDirty}
          onClose={() => {
            if (
              intakeDirty &&
              !confirm("Hay cambios sin guardar. ¿Descartar la vacante?")
            )
              return;
            setIntakeOpen(false);
            setIntakeDirty(false);
          }}
          onCreated={(r) => {
            setIntakeResult(r);
            if (intakeEditing) {
              setSelected(r.item);
              setSummary(r.item.payload?.summary ?? { "es-pe": "", en: "" });
              setEligibility(r.item.payload?.eligibility ?? "unknown");
              setReason("");
            }
            setIntakeOpen(false);
            setIntakeDirty(false);
            setNotice(
              intakeEditing
                ? "Actualización guardada. Requiere nueva revisión; el sitio todavía no cambió."
                : r.created
                  ? "Vacante guardada para revisión. Todavía no se publicó en el sitio."
                  : "Esta publicación ya estaba registrada. Se conservó el registro existente.",
            );
            void load().catch((e) => setError(e.message));
          }}
        />
      )}
      {intakeResult && (
        <section className="panel" role="status">
          <h2>Vacante pendiente de revisión</h2>
          <p>
            {intakeResult.item?.payload?.title ??
              "Revisa los datos y las posibles duplicaciones antes de aprobar."}
          </p>
          {Boolean(intakeResult.duplicateSuggestions?.length) && (
            <p>
              Hay referencias posiblemente duplicadas; la aprobación requiere
              resolverlas.
            </p>
          )}
          <button onClick={() => onNavigate("jobs-candidates")}>
            Ir a vacantes por revisar
          </button>
        </section>
      )}
      <section
        className="panel jobs-monitor"
        aria-label="Estado de recolección"
      >
        <div>
          <span className="eyebrow">MONITOREO LOCAL</span>
          <strong>
            {status
              ? status.collectionEnabled
                ? "Recolección disponible"
                : "Recolección deshabilitada"
              : "Comprobando estado…"}
          </strong>
          <p>
            {status?.processRunning
              ? "La aplicación está ejecutando el monitor local."
              : "El monitor local no ha confirmado actividad."}{" "}
            Debe permanecer abierta para ejecutar horarios.
          </p>
        </div>
        <dl>
          <div>
            <dt>Última recolección correcta</dt>
            <dd>{jobMoment(status?.lastSuccessfulFetchAt)}</dd>
          </div>
          <div>
            <dt>En cola / recolectando / fallidas</dt>
            <dd>
              {status
                ? `${status.queued ?? 0} / ${status.running ?? 0} / ${status.failed ?? 0}`
                : "—"}
            </dd>
          </div>
        </dl>
        <p className="field-help">
          El horario indica cuándo se pondrá una lectura en cola, no garantiza
          su éxito. Las fuentes de este panel se guardan localmente. GitHub
          Actions mantiene un registro independiente. Publica las vacantes
          revisadas desde este admin y comprueba su despliegue; una lectura
          local no actualiza el sitio por sí sola.
        </p>
      </section>
      {operation && (
        <section className="panel" aria-live="polite">
          <h2>Tu solicitud</h2>
          <Badge state={operation.state} />
          {operation.last_code && (
            <p>
              {jobOperationMessage(
                operation.state,
                operation.last_code,
                operation.result?.status,
              )}
            </p>
          )}
          {operation.result && <RunSummary run={operation.result} />}
          <button onClick={() => onNavigate("collection-runs")}>
            Ver recolecciones
          </button>
        </section>
      )}
      {isSources && (adding || !sources.length) && (
        <section className="panel jobs-onboarding">
          <div className="eyebrow">1 / ENCUENTRA LA FUENTE</div>
          <h2>Añade una empresa por su página de empleos</h2>
          <p>
            Pega la URL de la empresa, una bolsa Greenhouse, Lever o
            SmartRecruiters, o un enlace individual compatible de Globant o
            HireHive. Comprobaremos qué se puede leer, sin habilitar la fuente
            todavía.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                const r = await request("/job-sources/discover", {
                  method: "POST",
                  headers: headers(),
                  body: JSON.stringify({ careersUrl, company }),
                });
                setDiscovery(r);
                setProposed((r as any).supported ? (r as any).config : null);
              });
            }}
          >
            <div className="form-grid">
              <label>
                URL de empleos
                <input
                  type="url"
                  required
                  placeholder="https://empresa.com/careers"
                  value={careersUrl}
                  onChange={(e) => {
                    setCareersUrl(e.target.value);
                    setDiscovery(null);
                    setProposed(null);
                  }}
                />
              </label>
              <label>
                Empresa (opcional)
                <input
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="Nombre de la empresa"
                />
              </label>
            </div>
            <button
              className="primary"
              disabled={busy || !publicHref(careersUrl)}
            >
              Comprobar fuente
            </button>
          </form>
          {discovery && !discovery.supported && (
            <div className="alert info">
              <h3>No encontramos una fuente compatible</h3>
              <p>{discoveryReason(discovery.reason)}</p>
              <Link href={careersUrl}>Abrir la página original</Link>
              {allowed(user, "jobs:curate") && (
                <button
                  type="button"
                  onClick={() => {
                    setIntakeEditing(null);
                    setIntakeOpen(true);
                  }}
                >
                  Añadir una vacante desde su enlace original
                </button>
              )}
              <p>
                Conservamos la URL para que puedas corregirla. No se creó una
                fuente ni se recolectaron vacantes.
              </p>
            </div>
          )}
          {proposed && (
            <section className="jobs-discovery">
              <div className="eyebrow">2 / CONFIRMA LA EMPRESA</div>
              <h3>Fuente detectada: {jobSourceLabel(proposed.adapter)}</h3>
              <label>
                Nombre de empresa
                <input
                  required
                  value={proposed.company}
                  onChange={(e) =>
                    setProposed({ ...proposed, company: e.target.value })
                  }
                />
              </label>
              <Link href={discovery.canonicalUrl}>Ver fuente detectada</Link>
              {proposed.coverage === "single-detail" && (
                <p className="alert info">
                  Esta fuente verifica una sola vacante mediante su enlace
                  original. No recorre toda la bolsa de la empresa.
                </p>
              )}
              <p>
                Se guardará pausada. Tú revisarás sus condiciones antes de
                habilitar lecturas o programarlas.
              </p>
              <button
                disabled={busy || !proposed.company?.trim()}
                onClick={() =>
                  void action(async () => {
                    await saveSource(proposed);
                    setNotice(
                      "Empresa guardada sin activar. Revisa la fuente para habilitarla.",
                    );
                  })
                }
              >
                Guardar fuente sin activar
              </button>
            </section>
          )}
        </section>
      )}
      <label className="jobs-search">
        Buscar{" "}
        {isSources
          ? "empresa o fuente"
          : isRuns
            ? "fuente en recolecciones"
            : "vacantes"}
        <input
          type="search"
          disabled={dirty}
          title={
            dirty
              ? "Guarda o cancela los cambios antes de filtrar la lista."
              : undefined
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {section === "jobs-candidates" && (
        <section
          className="panel"
          aria-label="Alcance geográfico de la revisión"
        >
          <label>
            Alcance geográfico
            <select
              aria-label="Alcance geográfico"
              value={geographyScope}
              disabled={busy || dirty}
              onChange={(e) => setGeographyScope(e.target.value)}
            >
              <option value="qualified">Perú y remoto LATAM</option>
              <option value="ineligible">Otras / sin confirmar</option>
              <option value="all">Todas las ubicaciones</option>
            </select>
          </label>
          <p className="field-help">
            La cola principal incluye solo vacantes con evidencia de Perú o
            trabajo remoto desde LATAM. Las demás conservan su fuente e
            historial en las otras vistas.
          </p>
          <p role="status">
            {loading
              ? "Comprobando vacantes…"
              : `Mostrando ${items.length} vacantes en esta vista`}
          </p>
        </section>
      )}
      <div className="jobs-manager-grid">
        <section
          className="panel jobs-manager-list"
          aria-label={
            isSources
              ? "Fuentes guardadas"
              : isRuns
                ? "Historial de recolecciones"
                : "Vacantes"
          }
        >
          {loading ? (
            <p role="status">Cargando…</p>
          ) : isSources ? (
            visibleSources.length ? (
              visibleSources.map((s) => (
                <button
                  className={selected?.id === s.id ? "selected" : ""}
                  key={s.id}
                  onClick={() => choose(s)}
                >
                  <AppIcon name="organizations" size={22} />
                  <strong>{s.config.company}</strong>
                  <span>
                    {s.retired
                      ? "Retirada"
                      : s.config.enabled
                        ? "Habilitada"
                        : "Pausada"}{" "}
                    · {jobSourceLabel(s.config.adapter)}
                  </span>
                  <small>
                    Último éxito: {jobMoment(s.runtime?.lastSuccessfulFetchAt)}
                  </small>
                </button>
              ))
            ) : (
              <Empty
                title="Todavía no hay empresas"
                action={() => setAdding(true)}
                label="Añadir empresa"
              />
            )
          ) : isRuns && !runs.length ? (
            <Empty
              title="Todavía no hay recolecciones"
              action={() => onNavigate("job-sources")}
              label="Abrir empresas y recolectar"
            />
          ) : isRuns ? (
            runs
              .filter((r) => String(r.source_id).includes(query))
              .map((r) => (
                <button key={r.id} onClick={() => choose(r)}>
                  <strong>
                    {sources.find((s) => s.id === r.source_id)?.config
                      .company ?? r.source_id}
                  </strong>
                  <Badge state={r.status} />
                  <small>{jobMoment(r.created_at)}</small>
                </button>
              ))
          ) : items.length ? (
            items.map((r) => (
              <button
                key={r.id}
                className={selected?.id === r.id ? "selected" : ""}
                onClick={() => choose(r)}
              >
                <strong>{r.payload.title}</strong>
                <span>{r.payload.company}</span>
                <Badge
                  state={
                    r.payload.closureReason === "curator-withdrawn"
                      ? "curator-withdrawn"
                      : r.payload.status
                  }
                />
                <span>{jobGeographyLabel(r.geography)}</span>
                <small>
                  {r.payload.locations?.join(" · ") ||
                    "Ubicación por confirmar"}
                </small>
              </button>
            ))
          ) : (
            <Empty
              title={
                section === "jobs-candidates" && geographyScope === "qualified"
                  ? "No hay vacantes con evidencia de Perú o remoto LATAM en esta búsqueda"
                  : "No hay vacantes en esta vista"
              }
              action={() => onNavigate("job-sources")}
              label="Revisar empresas y recolectar"
            />
          )}
          {isRuns && !runs.length && !loading && (
            <Empty
              title="Todavía no hay recolecciones"
              action={() => onNavigate("job-sources")}
              label="Recolectar desde una empresa"
            />
          )}
        </section>
        <section
          className="panel jobs-manager-detail"
          aria-label="Detalle de oportunidad o fuente"
        >
          {!selected ? (
            <>
              <h2>De la fuente a una oportunidad revisada</h2>
              <ol>
                <li>Añade y revisa una empresa.</li>
                <li>Habilita una lectura puntual o un horario local.</li>
                <li>
                  Revisa los puestos y su elegibilidad antes de aprobarlos.
                </li>
              </ol>
              <p>
                Una recolección no publica contenido. Los errores de una fuente
                no cierran sus vacantes.
              </p>
            </>
          ) : source ? (
            <>
              <div className="eyebrow">EMPRESA / FUENTE</div>
              <h2>{source.config.company}</h2>
              <Link href={source.config.careersUrl}>Página de empleos</Link>
              <p>
                {jobSourceLabel(source.config.adapter)} ·{" "}
                {source.config.boardIdentifier} ·{" "}
                {source.retired
                  ? "Retirada"
                  : source.config.enabled
                    ? "Habilitada"
                    : "Pausada"}
              </p>
              <LifecycleActions
                target={{
                  module: "job-sources",
                  id: source.id,
                  version: source.version,
                  name: source.config.company || source.id,
                }}
                disabled={busy || dirty}
                onReload={async () => {
                  const rows = await allSources();
                  const row = rows.find((r: any) => r.id === source.id);
                  if (!row) throw new Error("La fuente no está disponible.");
                  choose(row);
                }}
                onDescriptor={setSelectedLifecycle}
                onComplete={async (result, capability) => {
                  if (result?.config) setSelected(result);
                  setSourceEdit(null);
                  await load();
                  setNotice(lifecycleCopy[capability.effect].outcome);
                }}
              />
              {sourceRetired && (
                <p className="alert info">
                  Fuente retirada: no se habilitan ni programan nuevas
                  recolecciones. Sus vacantes y resultados se conservan.
                </p>
              )}
              <dl>
                <div>
                  <dt>Último intento</dt>
                  <dd>{jobMoment(source.runtime?.lastAttemptAt)}</dd>
                </div>
                <div>
                  <dt>Último éxito</dt>
                  <dd>{jobMoment(source.runtime?.lastSuccessfulFetchAt)}</dd>
                </div>
                <div>
                  <dt>Próxima puesta en cola</dt>
                  <dd>
                    {source.config.enabled && source.config.schedule?.enabled
                      ? jobMoment(source.runtime?.nextDueAt)
                      : "Sin programar"}
                  </dd>
                </div>
              </dl>
              {source.runtime?.lastErrorCode && (
                <p role="status" className="alert error">
                  {jobFailureMessage(source.runtime.lastErrorCode)}
                </p>
              )}
              {source.runtime?.lastOperation && (
                <p>
                  Última solicitud:{" "}
                  <Badge state={source.runtime.lastOperation.state} />
                  {source.runtime.lastOperation.lastCode
                    ? ` · ${jobOperationMessage(source.runtime.lastOperation.state, source.runtime.lastOperation.lastCode, source.runtime.lastOperation.outcome)}`
                    : ""}
                </p>
              )}
              {source.runtime?.lastStatus && (
                <p>
                  Último resultado: <Badge state={source.runtime.lastStatus} />
                </p>
              )}
              <div className="toolbar">
                <button
                  className="primary"
                  disabled={
                    busy ||
                    Boolean(sourceRetired) ||
                    !source.config.enabled ||
                    status?.collectionEnabled !== true
                  }
                  onClick={() => void collect(source)}
                >
                  Recolectar ahora
                </button>
                <button
                  disabled={busy || Boolean(sourceRetired)}
                  onClick={() => {
                    setSourceEdit(editableSourceConfig(source.config));
                    setReviewed(false);
                  }}
                >
                  Revisar fuente y horario
                </button>
                {source.config.enabled && !sourceRetired && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await saveSource(
                          {
                            ...source.config,
                            enabled: false,
                            schedule: {
                              ...source.config.schedule,
                              enabled: false,
                            },
                          },
                          source.version,
                        );
                        setNotice(
                          "Fuente pausada. No se solicitarán nuevas lecturas programadas.",
                        );
                      })
                    }
                  >
                    Pausar fuente
                  </button>
                )}
              </div>
              {sourceEdit && !sourceRetired && (
                <form
                  className="jobs-source-review"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(async () => {
                      await saveSource(
                        {
                          ...sourceEdit,
                          enabled: true,
                          reviewedAt: new Date().toISOString(),
                        },
                        source.version,
                      );
                      setNotice(
                        "Fuente revisada y habilitada. Puedes recolectar ahora.",
                      );
                    });
                  }}
                >
                  <h3>Revisión antes de habilitar</h3>
                  <p>
                    Registra lo que has comprobado. No afirmamos permisos ni
                    aprobación de la empresa por ti.
                  </p>
                  <label>
                    URL de términos revisados
                    <input
                      type="url"
                      required
                      value={sourceEdit.termsUrl ?? ""}
                      onChange={(e) =>
                        setSourceEdit({
                          ...sourceEdit,
                          termsUrl: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Base de permiso o condiciones de lectura
                    <textarea
                      required
                      value={sourceEdit.permissionBasis ?? ""}
                      onChange={(e) =>
                        setSourceEdit({
                          ...sourceEdit,
                          permissionBasis: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Referencia de tu revisión
                    <input
                      required
                      value={sourceEdit.reviewReference ?? ""}
                      onChange={(e) =>
                        setSourceEdit({
                          ...sourceEdit,
                          reviewReference: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Atribución pública
                    <input
                      value={sourceEdit.attribution ?? ""}
                      onChange={(e) =>
                        setSourceEdit({
                          ...sourceEdit,
                          attribution: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={sourceEdit.schedule?.enabled ?? false}
                      onChange={(e) =>
                        setSourceEdit({
                          ...sourceEdit,
                          schedule: {
                            intervalHours:
                              sourceEdit.schedule?.intervalHours ?? 12,
                            enabled: e.target.checked,
                          },
                        })
                      }
                    />
                    Programar lecturas mientras la aplicación esté abierta
                  </label>
                  {sourceEdit.schedule?.enabled && (
                    <label>
                      Intervalo de lectura
                      <select
                        value={sourceEdit.schedule.intervalHours}
                        onChange={(e) =>
                          setSourceEdit({
                            ...sourceEdit,
                            schedule: {
                              ...sourceEdit.schedule,
                              intervalHours: Number(e.target.value),
                            },
                          })
                        }
                      >
                        {[1, 6, 12, 24, 72, 168].map((h) => (
                          <option key={h} value={h}>
                            Cada {h} horas
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="check-field">
                    <input
                      type="checkbox"
                      required
                      checked={reviewed}
                      onChange={(e) => setReviewed(e.target.checked)}
                    />
                    He revisado esta fuente y autorizo sus lecturas públicas con
                    estas condiciones
                  </label>
                  <div className="toolbar">
                    <button className="primary" disabled={busy || !reviewed}>
                      Guardar revisión y habilitar
                    </button>
                    <button type="button" onClick={() => setSourceEdit(null)}>
                      Cancelar
                    </button>
                  </div>
                </form>
              )}
            </>
          ) : isRuns ? (
            <>
              <h2>Resultado de recolección</h2>
              <LifecycleRetention />
              <Badge state={selected.status} />
              <RunSummary run={selected.summary ?? {}} />
              <p>
                Un resultado incompleto o fallido no acredita que las vacantes
                hayan cerrado.
              </p>
              <button onClick={() => onNavigate("jobs-candidates")}>
                Revisar vacantes
              </button>
            </>
          ) : job ? (
            <>
              <div className="eyebrow">VACANTE / EVIDENCIA</div>
              <h2>{job.title}</h2>
              <p>{job.company}</p>
              <Badge
                state={
                  job.closureReason === "curator-withdrawn"
                    ? "curator-withdrawn"
                    : job.status
                }
              />
              <p>
                <strong>{jobGeographyLabel(selected.geography)}</strong>
              </p>
              {selected.geography?.qualified !== true && (
                <p className="alert info">
                  Esta vacante no tiene evidencia geográfica válida para la cola
                  principal. Se conserva para inspección; cambiar la
                  elegibilidad por sí solo no la habilita para aprobar o
                  publicar.
                </p>
              )}
              <p>{job.locations?.join(" · ") || "Ubicación por confirmar"}</p>
              <div className="toolbar">
                <Link href={job.sourceUrl}>Ver fuente original</Link>
                <Link href={job.applyUrl}>Abrir postulación</Link>
              </div>
              <LifecycleActions
                target={{
                  module: "jobs",
                  id: selected.id,
                  version: selected.version,
                  name: job.title || selected.id,
                }}
                disabled={busy || dirty}
                onReload={async () => choose(await findJob(selected.id))}
                onComplete={async (result, capability) => {
                  if (result?.payload) {
                    setSelected(result);
                    setSummary(
                      result.payload.summary ?? { "es-pe": "", en: "" },
                    );
                    setEligibility(result.payload.eligibility ?? "unknown");
                  }
                  setReason("");
                  setEditExpiry(false);
                  await load();
                  setNotice(
                    `«${job.title}»: ${lifecycleCopy[capability.effect].outcome}`,
                  );
                }}
              />
              <p>
                Familias detectadas:{" "}
                {job.roleFamily ||
                  job.roleFamilies?.join(" · ") ||
                  "Consulta el título y la evidencia original"}
              </p>
              {job.intake?.kind === "single-detail" &&
                allowed(user, "jobs:curate") && (
                  <button
                    disabled={busy || dirty}
                    onClick={() => {
                      setIntakeEditing(selected);
                      setIntakeOpen(true);
                      window.scrollTo({ top: 0, behavior: "instant" });
                    }}
                  >
                    Editar datos de la vacante original
                  </button>
                )}
              {duplicates
                .filter((g) => g.ids.includes(selected.id))
                .map((g) => (
                  <section className="alert info" key={g.ids.join("|")}>
                    <h3>Posible vacante duplicada</h3>
                    <p>
                      {g.reason === "shared-requisition"
                        ? "Estas publicaciones comparten una requisición de la empresa."
                        : "Estas publicaciones comparten el mismo enlace original."}{" "}
                      Revisa las referencias y excluye el duplicado antes de
                      aprobar.
                    </p>
                    <ul>
                      {g.ids
                        .filter((id: string) => id !== selected.id)
                        .map((id: string) => {
                          const other = items.find((r) => r.id === id);
                          return (
                            <li key={id}>
                              {other ? (
                                <button onClick={() => choose(other)}>
                                  {other.payload.company} ·{" "}
                                  {other.payload.title}
                                </button>
                              ) : (
                                <code>{id}</code>
                              )}
                            </li>
                          );
                        })}
                    </ul>
                  </section>
                ))}
              <p>Última verificación: {jobMoment(job.lastVerifiedAt)}</p>
              {job.expiresAt && (
                <p>Vencimiento informado: {jobMoment(job.expiresAt)}</p>
              )}
              {job.closureReason && (
                <p>
                  {job.closureReason === "curator-withdrawn"
                    ? "Retirada editorial solicitada. Esto no indica que la empresa haya cerrado la vacante; comprueba la publicación y su despliegue."
                    : `Motivo del cierre: ${job.closureReason}`}
                </p>
              )}
              <label>
                Elegibilidad para Perú
                <select
                  value={eligibility}
                  onChange={(e) => setEligibility(e.target.value)}
                >
                  <option value="unknown">Por confirmar</option>
                  <option value="peru">Perú</option>
                  <option value="remote-peru">Remoto desde Perú</option>
                  <option value="remote-latam-confirmed">
                    Latinoamérica confirmada
                  </option>
                  <option value="restricted">Restringida</option>
                </select>
              </label>
              {(["es-pe", "en"] as const).map((lang) => (
                <div className="jobs-summary-field" key={lang}>
                  <label htmlFor={`job-summary-${lang}`}>
                    {lang === "en"
                      ? "Resumen revisado (inglés)"
                      : "Resumen revisado (español)"}
                  </label>
                  <textarea
                    id={`job-summary-${lang}`}
                    value={summary[lang]}
                    onChange={(e) =>
                      setSummary({ ...summary, [lang]: e.target.value })
                    }
                  />
                </div>
              ))}
              <label>
                Motivo y evidencia
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <details>
                <summary>Vencimiento y cierre revisados</summary>
                <p>
                  Un error de lectura no confirma un cierre. Registra una fecha
                  solo si existe evidencia en la fuente.
                </p>
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={editExpiry}
                    onChange={(e) => setEditExpiry(e.target.checked)}
                  />
                  Editar vencimiento informado
                </label>
                {editExpiry && (
                  <label>
                    Vencimiento en Lima (vacío elimina la fecha)
                    <input
                      type="datetime-local"
                      value={expiry}
                      onChange={(e) => setExpiry(e.target.value)}
                    />
                  </label>
                )}
                <NamedConfirmation
                  target={{
                    module: "jobs",
                    id: selected.id,
                    version: selected.version,
                    name: job.title || selected.id,
                  }}
                  label="Marcar cerrada por la empresa…"
                  title="Registrar el cierre informado de"
                  description="Usa esta acción solo si la fuente original confirma que la empresa cerró la vacante. La retirada editorial del sitio se gestiona por separado y no acredita un cierre de la empresa."
                  confirmLabel="Registrar cierre con evidencia"
                  minReasonLength={1}
                  reasonLabel="Evidencia del cierre de la empresa"
                  disabled={busy || dirty || job.status === "closed"}
                  onConfirm={async ({ target, reason: closeReason }) => {
                    const result: any = await request(
                      `/jobs/${encodeURIComponent(target.id)}/review`,
                      {
                        method: "POST",
                        headers: headers(),
                        body: JSON.stringify({
                          decision: "close",
                          version: target.version,
                          reason: closeReason,
                        }),
                      },
                    );
                    setSelected(result);
                    setReason("");
                    setEditExpiry(false);
                    await load();
                    setNotice(
                      "Cierre informado guardado; comprueba por separado la retirada del sitio.",
                    );
                  }}
                />
              </details>
              <div className="toolbar">
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !reason.trim() ||
                    selected.geography?.qualified !== true ||
                    job.status === "closed" ||
                    Boolean(
                      job.expiresAt && Date.parse(job.expiresAt) <= Date.now(),
                    ) ||
                    !summary["es-pe"].trim() ||
                    !summary.en.trim() ||
                    ["unknown", "restricted"].includes(eligibility)
                  }
                  onClick={() => void review("approve")}
                >
                  Aprobar oportunidad
                </button>
              </div>
              {allowed(user, "content:publish") &&
                [
                  "candidate",
                  "needs-review",
                  "active",
                  "stale",
                  "closed",
                ].includes(job.status) && (
                  <JobsPublication
                    key={`${selected.id}:${jobPublicationRevision(job)}`}
                    user={user}
                    jobId={selected.id}
                    version={selected.version}
                    blocked={
                      dirty ||
                      (job.status !== "closed" &&
                        selected.geography?.qualified !== true)
                    }
                    onReconciled={async () => {
                      const rows = await load();
                      if (dirtyRef.current) return;
                      const fresh = rows?.find((r) => r.id === selected.id);
                      if (fresh) {
                        setSelected(fresh);
                        setSummary(
                          fresh.payload.summary ?? { "es-pe": "", en: "" },
                        );
                        setEligibility(fresh.payload.eligibility ?? "unknown");
                      }
                    }}
                  />
                )}
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
function Empty({
  title,
  action,
  label,
}: {
  title: string;
  action: () => void;
  label: string;
}) {
  return (
    <div className="workspace-empty">
      <AppIcon name="jobs" size={30} />
      <h3>{title}</h3>
      <button onClick={action}>{label}</button>
    </div>
  );
}
function RunSummary({ run }: { run: any }) {
  return (
    <dl className="jobs-run-summary">
      {[
        ["Alcance", jobRunScope(run)],
        ["Inicio", jobMoment(run.startedAt)],
        ["Fin", jobMoment(run.finishedAt)],
        ["Puestos recibidos", run.recordsFetched ?? "—"],
        ["Puestos del área", run.relevantRecords ?? "—"],
        [
          "Nuevos / actualizados / cerrados",
          `${run.newRecords ?? 0} / ${run.changedRecords ?? 0} / ${run.closedRecords ?? 0}`,
        ],
        ["Resultado público revisado", run.publicCount ?? "—"],
        ["Observación", jobFailureMessage(run.errorCode)],
      ].map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
function discoveryReason(reason: string) {
  return (
    (
      {
        ROBOTS_DISALLOWED: "La página no permite esta lectura automática.",
        ROBOTS_UNAVAILABLE:
          "No pudimos comprobar las reglas de lectura de la página.",
        MULTIPLE_BOARDS_REQUIRE_SELECTION:
          "Encontramos varias bolsas. Pega la URL directa de la empresa en Greenhouse, Lever o SmartRecruiters.",
        UNSUPPORTED_CAREERS_PAGE:
          "No pudimos automatizar esta URL. Abre la página original y añade una vacante individual con evidencia, o prueba un enlace de una bolsa compatible.",
      } as Record<string, string>
    )[reason] ??
    "Esta fuente necesita una revisión o un adaptador específico. No simulamos una recolección vacía."
  );
}
