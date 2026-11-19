import { mediaSelectable, takeLifecycleReference } from "./lifecycle";
import React, { useEffect, useState, useRef, lazy, Suspense } from "react";
import {
  LifecycleActions,
  useMediaInventoryUpdates,
} from "./lifecycle-actions";
import { createRoot } from "react-dom/client";
import type { User, Draft, AuditEvent } from "../shared/types";
import type { MemoryPayload, VerifiedMedia } from "../shared/content";
import "./style.css";
import "./named-confirmation.css";
import "./design.css";
import { ProductNavigation, ShellHeader } from "./navigation";
import "./shell.css";
import "./record-cover.css";
import "./jobs-workspace.css";
import {
  defaultSection,
  sectionFromUrl,
  sectionUrl,
  validSection,
} from "./section-route";
const ProductPage = lazy(() =>
  import("./product").then((module) => ({ default: module.ProductPage })),
);
class RequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fieldErrors: { path: string; message: string }[] = [],
    public currentRevision?: number,
  ) {
    super(message);
  }
}
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const e = await response
      .json()
      .catch(() => ({ message: "No se pudo conectar con el servicio local." }));
    throw new RequestError(
      response.status,
      e.code ?? "NETWORK_ERROR",
      e.message,
      e.fieldErrors ?? [],
      e.currentRevision,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
function fieldLabel(path: string) {
  const locale = path.endsWith("/en") ? "inglés" : "español";
  if (path.includes("/title")) return `Título (${locale})`;
  if (path.includes("/description")) return `Descripción (${locale})`;
  if (path.includes("/alt")) return `Texto alternativo (${locale})`;
  if (path.includes("/asset") || path.includes("/media")) return "Imagen";
  if (path.includes("/slug")) return "Slug";
  if (path.includes("/displayOrder")) return "Orden editorial";
  if (path.includes("/captureYear")) return "Año conocido";
  if (path.includes("/tags")) return "Etiquetas";
  return "Contenido";
}
const labels = {
  draft: "Borrador",
  submitted: "En revisión",
  approved: "Aprobado",
  changes_requested: "Cambios solicitados",
};
const actions: Record<string, string> = {
  draft_created: "Borrador creado",
  draft_updated: "Nueva revisión guardada",
  approval_invalidated: "Aprobación anterior invalidada",
  review_submitted: "Enviado a revisión",
  approved: "Revisión aprobada",
  changes_requested: "Cambios solicitados",
  public_json_exported: "JSON público exportado",
};
function App() {
  const [section, setSection] = useState(() =>
    sectionFromUrl(new URL(location.href)),
  );
  const historyIndex = useRef(0);
  const restoringHistory = useRef(false);
  function restoreSection(role: string, fixtureEnabled: boolean) {
    const next = sectionFromUrl(
      new URL(location.href),
      defaultSection(role),
      fixtureEnabled,
    );
    historyIndex.current = Number.isSafeInteger(
      history.state?.adminNavigationIndex,
    )
      ? history.state.adminNavigationIndex
      : 0;
    history.replaceState(
      { ...history.state, adminNavigationIndex: historyIndex.current },
      "",
      sectionUrl(new URL(location.href), next),
    );
    setSection(next);
  }
  const [productDirty, setProductDirty] = useState(false);
  const [darkTheme, setDarkTheme] = useState(
    () => localStorage.getItem("admin-theme") === "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = darkTheme ? "dark" : "light";
    localStorage.setItem("admin-theme", darkTheme ? "dark" : "light");
  }, [darkTheme]);
  useEffect(() => {
    const listener = (event: Event) =>
      setProductDirty((event as CustomEvent<boolean>).detail);
    window.addEventListener("product-dirty", listener);
    return () => window.removeEventListener("product-dirty", listener);
  }, []);
  const [config, setConfig] = useState<{
      fixtureAuthEnabled: boolean;
      oauthConfigured?: boolean;
      localGhAuthEnabled?: boolean;
      localGhAuthRequested?: boolean;
    } | null>(null),
    [user, setUser] = useState<User | null>(null),
    [booting, setBooting] = useState(true),
    [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [media, setMedia] = useState<VerifiedMedia[]>([]),
    [selected, setSelected] = useState<Draft | null>(null),
    [form, setForm] = useState<MemoryPayload | null>(null),
    [audit, setAudit] = useState<AuditEvent[]>([]);
  useMediaInventoryUpdates(setMedia);
  const [tagsText, setTagsText] = useState("");
  const [sessionError, setSessionError] = useState<RequestError | null>(null);
  const [error, setError] = useState<RequestError | null>(null),
    [notice, setNotice] = useState(""),
    [filter, setFilter] = useState("all"),
    [previewLang, setPreviewLang] = useState<"es-pe" | "en">("es-pe"),
    [reviewComment, setReviewComment] = useState(""),
    [conflictCopy, setConflictCopy] = useState("");
  useEffect(() => {
    setTagsText(selected?.payload.tags.join(", ") ?? "");
  }, [selected?.id, selected?.revision]);
  const dirty = Boolean(
    selected &&
    form &&
    JSON.stringify(selected.payload) !== JSON.stringify(form),
  );
  const fail = (e: unknown) => {
    const value =
      e instanceof RequestError
        ? e
        : new RequestError(
            0,
            "NETWORK_ERROR",
            "No se pudo conectar. Tu texto sigue en esta pantalla.",
          );
    setError(value);
    if (value.status === 401)
      setNotice("La sesión venció. Copia tu texto antes de volver a ingresar.");
  };
  async function refreshList(append = false, next = cursor) {
    const list = await api<{ items: Draft[]; nextCursor: string | null }>(
      `/drafts?limit=50${append && next ? `&cursor=${next}` : ""}`,
    );
    setDrafts((previous) =>
      append ? [...previous, ...list.items] : list.items,
    );
    setCursor(list.nextCursor);
    const linked = takeLifecycleReference("drafts");
    if (linked) await openDraft(linked);
  }
  async function openDraft(id: string) {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const [d, events] = await Promise.all([
        api<Draft>(`/drafts/${id}`),
        api<AuditEvent[]>(`/drafts/${id}/audit`),
      ]);
      setSelected(d);
      setForm(structuredClone(d.payload));
      setAudit(events);
      setConflictCopy("");
      setReviewComment("");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function loadWorkspace() {
    setMedia(await api<VerifiedMedia[]>("/media"));
    await refreshList();
  }
  useEffect(() => {
    void (async () => {
      try {
        const authConfig = await api<{
          fixtureAuthEnabled: boolean;
          oauthConfigured?: boolean;
          localGhAuthEnabled?: boolean;
          localGhAuthRequested?: boolean;
        }>("/config");
        setConfig(authConfig);
        try {
          const currentUser = await api<User>("/me");
          setUser(currentUser);
          restoreSection(
            String(currentUser.role),
            authConfig.fixtureAuthEnabled,
          );
          if (["editor", "reviewer", "viewer"].includes(currentUser.role))
            await loadWorkspace();
        } catch (e) {
          if (!(e instanceof RequestError && e.status === 401)) throw e;
          if (
            authConfig.localGhAuthEnabled &&
            sessionStorage.getItem("local-gh-paused") !== "1"
          )
            await authenticateLocalGh();
        }
      } catch (e) {
        fail(e);
      } finally {
        setBooting(false);
      }
    })();
  }, []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty || productDirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, productDirty]);
  async function authenticateLocalGh() {
    const challenge = await api<{ csrfToken: string }>(
      "/auth/local-gh/challenge",
    );
    await api<User>("/auth/local-gh", {
      method: "POST",
      headers: { "X-CSRF-Token": challenge.csrfToken },
      body: "{}",
    });
    const current = await api<User>("/me");
    sessionStorage.removeItem("local-gh-paused");
    setUser(current);
    setSessionError(null);
    restoreSection(String(current.role), false);
    setError(null);
  }
  async function reverifyLocalGh() {
    await run(async () => {
      await api<User>("/auth/local-gh/reverify", {
        method: "POST",
        headers: headers(),
        body: "{}",
      });
      setUser(await api<User>("/me"));
      setSessionError(null);
      setNotice("Cuenta de GitHub CLI verificada nuevamente.");
    });
  }
  useEffect(() => {
    if (!user?.github) return;
    const timer = window.setInterval(() => {
      void api<User>("/me")
        .then((current) => {
          setUser(current);
          setSessionError(null);
        })
        .catch((error) => {
          setSessionError(
            error instanceof RequestError
              ? error
              : new RequestError(
                  0,
                  "NETWORK_ERROR",
                  "No se pudo comprobar la sesión. Tu texto sigue en esta pantalla.",
                ),
          );
        });
    }, 15000);
    return () => window.clearInterval(timer);
  }, [user?.id, Boolean(user?.github)]);
  async function login(persona: string) {
    setBusy(true);
    setError(null);
    try {
      await api<User>("/dev/login", {
        method: "POST",
        body: JSON.stringify({ persona }),
      });
      // Use the canonical session DTO, including community and current capabilities.
      const u = await api<User>("/me");
      setUser(u);
      setSessionError(null);
      setSelected(null);
      setForm(null);
      restoreSection(String(u.role), Boolean(config?.fixtureAuthEnabled));
      if (["editor", "reviewer", "viewer"].includes(u.role))
        await loadWorkspace();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  const headers = () => ({
    "X-CSRF-Token": user!.csrfToken,
    ...(selected ? { "If-Match": `"${selected.revision}"` } : {}),
  });
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await action();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    await run(async () => {
      const d = await api<Draft>("/drafts", {
        method: "POST",
        headers: headers(),
        body: "{}",
      });
      await refreshList();
      setSelected(d);
      setForm(structuredClone(d.payload));
      setAudit(await api(`/drafts/${d.id}/audit`));
      setNotice("Borrador privado de prueba creado. Completa ambos idiomas.");
    });
  }
  async function save() {
    if (!selected || !form) return;
    await run(async () => {
      try {
        const d = await api<Draft>(`/drafts/${selected.id}`, {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({ payload: form }),
        });
        setSelected(d);
        setForm(structuredClone(d.payload));
        setConflictCopy("");
        await refreshList();
        setAudit(await api(`/drafts/${d.id}/audit`));
        setNotice(
          "Revisión guardada. Cualquier aprobación anterior quedó invalidada.",
        );
      } catch (e) {
        if (e instanceof RequestError && e.status === 409)
          setConflictCopy(JSON.stringify(form, null, 2));
        throw e;
      }
    });
  }
  useEffect(() => {
    if (!dirty || busy || error || user?.role !== "editor") return;
    const timer = window.setTimeout(() => void save(), 800);
    return () => window.clearTimeout(timer);
  }, [form, dirty, busy, error, user?.role]);
  async function submit() {
    if (!selected) return;
    await run(async () => {
      const d = await api<Draft>(`/drafts/${selected.id}/submit`, {
        method: "POST",
        headers: headers(),
        body: "{}",
      });
      setSelected(d);
      await refreshList();
      setAudit(await api(`/drafts/${d.id}/audit`));
      setNotice(
        "Enviado. Cambia a la cuenta de revisor para aprobar esta revisión.",
      );
    });
  }
  async function review(decision: string) {
    if (!selected) return;
    await run(async () => {
      const d = await api<Draft>(`/drafts/${selected.id}/review`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          decision,
          revisionHash: selected.revisionHash,
          comment: reviewComment,
        }),
      });
      setSelected(d);
      await refreshList();
      setAudit(await api(`/drafts/${d.id}/audit`));
      setNotice(
        decision === "approved"
          ? "Revisión aprobada. El JSON ya se puede descargar; no se publicará nada."
          : "Cambios solicitados. El editor puede guardar una nueva revisión.",
      );
    });
  }
  async function download() {
    if (!selected) return;
    await run(async () => {
      const response = await fetch(`/api/drafts/${selected.id}/export`);
      if (!response.ok) {
        const e = await response.json();
        throw new RequestError(
          response.status,
          e.code,
          e.message,
          e.fieldErrors,
        );
      }
      const blob = await response.blob(),
        url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = `${selected.id}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice("JSON descargado. No se creó una PR ni se publicó contenido.");
      setAudit(await api(`/drafts/${selected.id}/audit`));
    });
  }
  async function logout() {
    if (
      (dirty || productDirty) &&
      !confirm("Hay cambios sin guardar. ¿Descartarlos y cerrar la sesión?")
    )
      return;
    if (config?.localGhAuthRequested)
      sessionStorage.setItem("local-gh-paused", "1");
    await run(async () => {
      await api("/logout", { method: "POST", headers: headers(), body: "{}" });
      setUser(null);
      setSessionError(null);
      setSelected(null);
      setForm(null);
      setDrafts([]);
      setNotice("");
    });
  }
  function patch<K extends keyof MemoryPayload>(
    key: K,
    value: MemoryPayload[K],
  ) {
    if (form) setForm({ ...form, [key]: value });
  }
  function choose(id: string) {
    if (
      (dirty || productDirty) &&
      !confirm("Hay cambios sin guardar. ¿Descartarlos y abrir otro borrador?")
    )
      return;
    void openDraft(id);
  }
  useEffect(() => {
    if (!user) return;
    const listener = () => {
      const nextIndex = Number.isSafeInteger(
        history.state?.adminNavigationIndex,
      )
        ? history.state.adminNavigationIndex
        : historyIndex.current;
      if (restoringHistory.current) {
        restoringHistory.current = false;
        return;
      }
      const next = sectionFromUrl(
        new URL(location.href),
        defaultSection(String(user.role)),
        Boolean(config?.fixtureAuthEnabled),
      );
      if (
        next !== section &&
        (dirty || productDirty) &&
        !confirm("Hay cambios sin guardar. ¿Descartarlos y cambiar de sección?")
      ) {
        const delta = historyIndex.current - nextIndex;
        if (delta) {
          restoringHistory.current = true;
          history.go(delta);
        } else
          history.replaceState(
            { ...history.state, adminNavigationIndex: historyIndex.current },
            "",
            sectionUrl(new URL(location.href), section),
          );
        return;
      }
      historyIndex.current = nextIndex;
      history.replaceState(
        { ...history.state, adminNavigationIndex: nextIndex },
        "",
        sectionUrl(new URL(location.href), next),
      );
      if (next !== section) {
        setProductDirty(false);
        if (dirty && selected) setForm(structuredClone(selected.payload));
        setSection(next);
      }
    };
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, [
    user?.id,
    user?.role,
    config?.fixtureAuthEnabled,
    section,
    dirty,
    productDirty,
  ]);
  useEffect(() => {
    setError(null);
    setNotice("");
  }, [section]);
  const visibleError = error ?? sessionError;
  const errorBox = visibleError && (
    <div className="alert error" role="alert">
      <strong>
        {visibleError.code === "REVISION_CONFLICT"
          ? "Hay cambios de otra sesión"
          : visibleError.status === 403
            ? "Esta acción no está permitida"
            : "No se pudo completar la acción"}
      </strong>
      <p>{visibleError.message}</p>
      {visibleError.fieldErrors.length > 0 && (
        <ul>
          {visibleError.fieldErrors.map((f, i) => (
            <li key={i}>
              <strong>{fieldLabel(f.path)}</strong>:{" "}
              {visibleError.code === "CONTENT_INVALID"
                ? "Completa este campo con texto en el idioma indicado."
                : "Revisa el valor y la longitud de este campo."}
            </li>
          ))}
        </ul>
      )}
      {visibleError.code === "REVISION_CONFLICT" && selected && (
        <>
          <p>
            Tu texto se conserva. Copia la versión local antes de cargar la
            guardada.
          </p>
          <details>
            <summary>Ver y copiar mi borrador local</summary>
            <textarea
              aria-label="Borrador local para copiar"
              readOnly
              value={conflictCopy}
            />
          </details>
          <button onClick={() => void openDraft(selected.id)}>
            Cargar versión guardada
          </button>
        </>
      )}
    </div>
  );
  if (booting)
    return (
      <main className="loading" aria-live="polite">
        Cargando el editor local…
      </main>
    );
  if (!user)
    return (
      <>
        <div className="shell-login-note">
          <strong>Community Admin</strong>
          <span>
            {config?.localGhAuthRequested
              ? "Identificación local con GitHub CLI · No autoriza publicaciones"
              : "Acceso de prueba separado de GitHub y de las integraciones"}
          </span>
        </div>
        <main className="login login-gateway">
          <div className="eyebrow">PLATFORM ENGINEERING PERÚ / ADMIN</div>
          <h1>
            Conecta tu comunidad.
            <br />
            <em>Cuida cada detalle.</em>
          </h1>
          <p>
            Administra contenido, comunidad, oportunidades y publicaciones con
            revisiones claras.
          </p>
          {errorBox}
          {config?.oauthConfigured && !config.localGhAuthRequested && (
            <p>
              <a className="oauth-login" href="/api/auth/github/start">
                Ingresar con GitHub
              </a>
            </p>
          )}
          {config?.localGhAuthRequested ? (
            <section
              className="alert warning"
              aria-label="Acceso local con GitHub CLI"
            >
              <strong>GitHub CLI · Revisión local</strong>
              <p>
                {config.localGhAuthEnabled
                  ? "Verificamos la cuenta activa de gh en este equipo. Si cerraste sesión, puedes volver a verificarla cuando quieras."
                  : "El modo local requiere desarrollo, origen127.0.0.1 y una identidad autorizada en la configuración del servidor."}
              </p>
              <button
                disabled={busy || !config.localGhAuthEnabled}
                onClick={() => void run(authenticateLocalGh)}
              >
                Verificar GitHub CLI e ingresar
              </button>
            </section>
          ) : !config?.fixtureAuthEnabled ? (
            <div className="alert warning">
              <strong>Acceso de prueba deshabilitado</strong>
              <p>
                Para una prueba local, inicia el servidor con{" "}
                <code>DEV_FIXTURE_AUTH=1</code>. En producción, este acceso
                siempre permanece deshabilitado.
              </p>
              <button onClick={() => location.reload()}>
                Volver a comprobar
              </button>
            </div>
          ) : (
            <section
              className="personas"
              aria-label="Cuentas sintéticas de desarrollo"
            >
              {[
                [
                  "editor",
                  "01",
                  "Editor",
                  "Crea y edita borradores. Solicita una revisión.",
                ],
                [
                  "reviewer",
                  "02",
                  "Revisor",
                  "Revisa una versión exacta y aprueba su exportación.",
                ],
                [
                  "viewer",
                  "03",
                  "Lector",
                  "Explora los borradores en modo de solo lectura.",
                ],
                [
                  "owner",
                  "04",
                  "Propietario",
                  "Acceso local de prueba a roles, configuración y operaciones.",
                ],
                [
                  "coordinator",
                  "05",
                  "Coordinador",
                  "Directorio privado, propuestas, sesiones y seguimiento.",
                ],
                [
                  "jobs_curator",
                  "06",
                  "Curador de oportunidades",
                  "Revisa fuentes, vacantes y evidencia de recolección.",
                ],
                [
                  "publisher",
                  "07",
                  "Publicador",
                  "Prepara publicaciones y changesets aprobados.",
                ],
              ].map(([role, n, name, description]) => (
                <button
                  key={role}
                  disabled={busy}
                  onClick={() => void login(role)}
                >
                  <span className="persona-number">{n}</span>
                  <strong>Entrar como {name.toLowerCase()}</strong>
                  <span>{description}</span>
                  <b aria-hidden="true">↗</b>
                </button>
              ))}
            </section>
          )}
          <p className="fine">
            {config?.localGhAuthRequested
              ? "Tu identidad se verifica en este equipo. Este acceso local no autoriza publicaciones."
              : "Estas cuentas son fixtures visibles para desarrollo, no autenticación de GitHub ni seguridad lista para producción. No ingreses datos reales."}
          </p>
        </main>
      </>
    );
  const asset = media.find((m) => m.id === form?.media[0].assetId),
    editable = user.role === "editor";
  const shown = drafts.filter((d) => filter === "all" || d.state === filter);
  const navigateSection = (next: string) => {
    if (!validSection(next, Boolean(config?.fixtureAuthEnabled))) return false;
    if (next === section) return true;
    if (
      (dirty || productDirty) &&
      !confirm("Hay cambios sin guardar. ¿Descartarlos y cambiar de sección?")
    )
      return false;
    historyIndex.current += 1;
    history.pushState(
      { ...history.state, adminNavigationIndex: historyIndex.current },
      "",
      sectionUrl(new URL(location.href), next),
    );
    setProductDirty(false);
    if (dirty && selected) setForm(structuredClone(selected.payload));
    setSection(next);
    return true;
  };
  return (
    <div className="admin-shell">
      <a className="skip-link" href="#main-content">
        Saltar al contenido
      </a>
      <ProductNavigation active={section} onSelect={navigateSection} />
      <div className="admin-stage">
        <ShellHeader
          active={section}
          onSelect={navigateSection}
          user={user}
          darkTheme={darkTheme}
          onTheme={() => setDarkTheme(!darkTheme)}
          onLogout={() => void logout()}
          onReverify={() => void reverifyLocalGh()}
          busy={busy}
          localMode={Boolean(config?.localGhAuthRequested)}
          fixtureMode={Boolean(config?.fixtureAuthEnabled)}
        />
        <div className="admin-content">
          {section !== "memories" && user.github && (errorBox || notice) && (
            <div className="local-auth-status">
              {errorBox}
              {notice && <p role="status">{notice}</p>}
            </div>
          )}
          {section !== "memories" ? (
            <Suspense
              fallback={
                <main className="product-main" role="status">
                  Cargando el módulo…
                </main>
              }
            >
              <ProductPage
                key={section}
                section={section}
                user={user}
                onNavigate={navigateSection}
              />{" "}
            </Suspense>
          ) : (
            <main id="main-content" tabIndex={-1} className="workspace">
              <div className="page-heading">
                <div>
                  <div className="eyebrow">SITIO WEB / CONTENIDO</div>
                  <h1>
                    Memories<span>.</span>
                  </h1>
                  <p>Del borrador a un JSON revisado. Un paso a la vez.</p>
                </div>
                {editable && (
                  <button
                    className="primary"
                    disabled={busy || dirty}
                    onClick={() => void create()}
                  >
                    + Nuevo recuerdo
                  </button>
                )}
              </div>
              {errorBox}
              {notice && (
                <div className="alert success" role="status">
                  {notice}
                </div>
              )}
              {user.role === "viewer" && (
                <div className="alert info">
                  Modo de solo lectura. Usa la cuenta de editor para modificar
                  contenido o la de revisor para aprobar.
                </div>
              )}
              <div className="editor-grid">
                <aside className="draft-list">
                  <div className="list-heading">
                    <h2>Recuerdos</h2>
                    <span>
                      {drafts.length}
                      {cursor ? "+" : ""}
                    </span>
                  </div>
                  <label className="filter-label">
                    Mostrar
                    <select
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    >
                      <option value="all">Todos los estados</option>
                      <option value="draft">Borradores</option>
                      <option value="submitted">Pendientes de revisión</option>
                      <option value="approved">Aprobados</option>
                      <option value="changes_requested">
                        Con cambios solicitados
                      </option>
                    </select>
                  </label>
                  {busy && drafts.length === 0 ? (
                    <p role="status">Cargando…</p>
                  ) : shown.length === 0 ? (
                    <div className="list-empty">
                      <span aria-hidden="true">◌</span>
                      <strong>Aún no hay recuerdos aquí</strong>
                      <p>
                        {editable
                          ? "Crea un borrador para comenzar."
                          : "El editor puede crear el primer borrador de prueba."}
                      </p>
                    </div>
                  ) : (
                    <ul>
                      {shown.map((d) => (
                        <li key={d.id}>
                          <button
                            className={selected?.id === d.id ? "selected" : ""}
                            onClick={() => choose(d.id)}
                            disabled={busy}
                          >
                            <span className={`badge ${d.state}`}>
                              {labels[d.state]}
                            </span>
                            <strong>
                              {d.payload.title["es-pe"] ||
                                "Recuerdo sin título"}
                            </strong>
                            <small>
                              Revisión {d.revision} <span>↗</span>
                            </small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {cursor && (
                    <button
                      disabled={busy}
                      onClick={() => void run(() => refreshList(true))}
                    >
                      Cargar más
                    </button>
                  )}
                  <button
                    className="quiet refresh"
                    disabled={busy}
                    onClick={() => void run(() => refreshList())}
                  >
                    ↻ Actualizar lista
                  </button>
                </aside>
                {!selected || !form ? (
                  <section className="empty-editor">
                    <div className="empty-art" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </div>
                    <div className="eyebrow">EL ARCHIVO EMPIEZA AQUÍ</div>
                    <h2>Un momento para compartir.</h2>
                    <p>
                      Abre un recuerdo para editar sus dos idiomas, ver la
                      imagen y seguir su revisión.
                    </p>
                    {editable && (
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() => void create()}
                      >
                        Crear mi primer recuerdo
                      </button>
                    )}
                  </section>
                ) : (
                  <section className="editor-panel" aria-busy={busy}>
                    <div className="editor-header">
                      <div>
                        <span className={`badge ${selected.state}`}>
                          {labels[selected.state]}
                        </span>
                        <h2>
                          {selected.payload.title["es-pe"] || "Nuevo recuerdo"}
                        </h2>
                        <p>
                          Revisión {selected.revision} ·{" "}
                          {new Date(selected.updatedAt).toLocaleString("es-PE")}
                        </p>
                      </div>
                      <span
                        className={dirty ? "save-state dirty" : "save-state"}
                      >
                        {busy
                          ? "Procesando…"
                          : dirty
                            ? "Cambios sin guardar"
                            : "Guardado"}
                      </span>
                    </div>
                    <LifecycleActions
                      user={user}
                      target={{
                        module: "drafts",
                        id: selected.id,
                        version: selected.revision,
                        name:
                          selected.payload.title["es-pe"] ||
                          "Recuerdo sin título",
                      }}
                      disabled={busy || dirty}
                      onReload={() => openDraft(selected.id)}
                      onComplete={async () => {
                        const name =
                          selected.payload.title["es-pe"] || "Recuerdo";
                        setSelected(null);
                        setForm(null);
                        await refreshList();
                        setNotice(
                          `Borrador local de «${name}» descartado. Su historial se conserva; el sitio no cambió.`,
                        );
                        requestAnimationFrame(() =>
                          document
                            .querySelector<HTMLElement>(".draft-list button")
                            ?.focus(),
                        );
                      }}
                    />
                    <ol className="steps" aria-label="Progreso del recuerdo">
                      <li className="done">
                        1 <span>Borrador</span>
                      </li>
                      <li
                        className={
                          selected.state === "submitted" ||
                          selected.state === "approved"
                            ? "done"
                            : ""
                        }
                      >
                        2 <span>Revisión</span>
                      </li>
                      <li
                        className={selected.state === "approved" ? "done" : ""}
                      >
                        3 <span>JSON aprobado</span>
                      </li>
                    </ol>
                    <div className="editing-columns">
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void save();
                        }}
                      >
                        <fieldset disabled={!editable || busy}>
                          <legend>Contenido bilingüe</legend>
                          <p className="field-help">
                            Ambos idiomas son obligatorios al enviar a revisión.
                            Puedes guardar un borrador incompleto.
                          </p>
                          {(["es-pe", "en"] as const).map((lang) => (
                            <section className="locale-fields" key={lang}>
                              <h3>
                                {lang === "es-pe"
                                  ? "Español · Perú"
                                  : "English"}
                              </h3>
                              <label>
                                Título{" "}
                                {lang === "en" ? "(inglés)" : "(español)"}
                                <input
                                  name={`title-${lang}`}
                                  aria-label={`Título (${lang === "en" ? "inglés" : "español"})`}
                                  maxLength={120}
                                  value={form.title[lang]}
                                  onChange={(e) =>
                                    patch("title", {
                                      ...form.title,
                                      [lang]: e.target.value,
                                    })
                                  }
                                />
                              </label>
                              <label>
                                Descripción{" "}
                                {lang === "en" ? "(inglés)" : "(español)"}
                                <textarea
                                  name={`description-${lang}`}
                                  aria-label={`Descripción (${lang === "en" ? "inglés" : "español"})`}
                                  maxLength={4000}
                                  rows={4}
                                  value={form.description[lang]}
                                  onChange={(e) =>
                                    patch("description", {
                                      ...form.description,
                                      [lang]: e.target.value,
                                    })
                                  }
                                />
                              </label>
                              <label>
                                Texto alternativo{" "}
                                {lang === "en" ? "(inglés)" : "(español)"}
                                <textarea
                                  name={`alt-${lang}`}
                                  aria-label={`Texto alternativo (${lang === "en" ? "inglés" : "español"})`}
                                  maxLength={500}
                                  rows={2}
                                  value={form.media[0].alt[lang]}
                                  onChange={(e) =>
                                    patch("media", [
                                      {
                                        ...form.media[0],
                                        alt: {
                                          ...form.media[0].alt,
                                          [lang]: e.target.value,
                                        },
                                      },
                                    ])
                                  }
                                />
                              </label>
                            </section>
                          ))}
                          <h3>Imagen y organización</h3>
                          <label>
                            Imagen sintética verificada
                            <select
                              name="asset"
                              aria-label="Imagen sintética verificada"
                              value={form.media[0].assetId}
                              onChange={(e) =>
                                patch("media", [
                                  { ...form.media[0], assetId: e.target.value },
                                ])
                              }
                            >
                              {media.filter(mediaSelectable).map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <p className="field-help">
                            Solo imágenes de prueba decodificadas y verificadas.
                            Se muestran completas, sin recorte. Esta versión no
                            acepta subidas.
                          </p>
                          <label>
                            Slug
                            <input
                              name="slug"
                              value={form.slug}
                              maxLength={120}
                              pattern="[a-z0-9]+(-[a-z0-9]+)*"
                              onChange={(e) => patch("slug", e.target.value)}
                            />
                          </label>
                          <div className="field-row">
                            <label>
                              Orden editorial
                              <input
                                type="number"
                                min="0"
                                max="1000000"
                                step="1"
                                value={form.displayOrder}
                                onChange={(e) =>
                                  patch("displayOrder", Number(e.target.value))
                                }
                              />
                            </label>
                            <label>
                              Año conocido (opcional)
                              <input
                                type="number"
                                min="1"
                                max="9999"
                                step="1"
                                placeholder="Desconocido"
                                value={form.captureYear ?? ""}
                                onChange={(e) =>
                                  patch(
                                    "captureYear",
                                    e.target.value
                                      ? Number(e.target.value)
                                      : null,
                                  )
                                }
                              />
                            </label>
                          </div>
                          <p className="field-help">
                            No inventes un día a partir del año ni del nombre de
                            un archivo.
                          </p>
                          <label>
                            Etiquetas, separadas por comas
                            <input
                              value={tagsText}
                              onChange={(e) => {
                                setTagsText(e.target.value);
                                patch(
                                  "tags",
                                  e.target.value
                                    .split(",")
                                    .map((t) => t.trim())
                                    .filter(Boolean),
                                );
                              }}
                            />
                          </label>
                        </fieldset>
                        {editable && (
                          <div className="form-actions">
                            <button
                              className="primary"
                              type="submit"
                              disabled={busy || !dirty}
                            >
                              Guardar revisión
                            </button>
                            <button
                              type="button"
                              disabled={
                                busy ||
                                dirty ||
                                selected.state === "submitted" ||
                                selected.state === "approved"
                              }
                              onClick={() => void submit()}
                            >
                              Enviar a revisión
                            </button>
                          </div>
                        )}
                        {editable && (
                          <p className="field-help">
                            Guardar una modificación invalida la aprobación
                            anterior. Otra cuenta debe revisar la nueva versión.
                          </p>
                        )}
                      </form>
                      <aside className="preview-column">
                        <div className="preview-heading">
                          <h3>Vista del contenido</h3>
                          <div
                            className="segmented"
                            aria-label="Idioma de la vista previa"
                          >
                            {(["es-pe", "en"] as const).map((lang) => (
                              <button
                                key={lang}
                                aria-pressed={previewLang === lang}
                                onClick={() => setPreviewLang(lang)}
                              >
                                {lang === "es-pe" ? "ES" : "EN"}
                              </button>
                            ))}
                          </div>
                        </div>
                        <article className="preview-card">
                          <div className="preview-image">
                            {asset && (
                              <img
                                src={`/api/media/${asset.id}`}
                                alt={
                                  form.media[0].alt[previewLang] ||
                                  "Imagen sintética de prueba sin texto alternativo aún"
                                }
                              />
                            )}
                          </div>
                          <div>
                            <small>IMAGEN SINTÉTICA / PRUEBA LOCAL</small>
                            <h3>
                              {form.title[previewLang] ||
                                "Tu título aparecerá aquí"}
                            </h3>
                            <p>
                              {form.description[previewLang] ||
                                "Completa la descripción para contar este momento."}
                            </p>
                          </div>
                        </article>
                        {asset && (
                          <p className="media-meta">
                            {asset.width} × {asset.height} px · PNG verificado
                            <br />
                            <a
                              href={`/api/media/${asset.id}?download=1`}
                              download
                            >
                              Descargar imagen de prueba ↗
                            </a>
                          </p>
                        )}
                        <p className="field-help">
                          Previsualización del contenido; no reproduce la cinta
                          WebGL del sitio.
                        </p>
                        {user.role === "reviewer" &&
                          selected.state === "submitted" && (
                            <section className="review-box">
                              <h3>Revisar esta versión</h3>
                              <p>
                                Tu decisión corresponde únicamente a la revisión{" "}
                                {selected.revision}. Editarla exigirá una nueva
                                aprobación.
                              </p>
                              <label>
                                Comentario para el editor
                                <textarea
                                  maxLength={2000}
                                  aria-label="Comentario para el editor"
                                  value={reviewComment}
                                  onChange={(e) =>
                                    setReviewComment(e.target.value)
                                  }
                                />
                              </label>
                              <button
                                className="primary"
                                disabled={busy}
                                onClick={() => void review("approved")}
                              >
                                Aprobar revisión {selected.revision}
                              </button>
                              <button
                                disabled={busy}
                                onClick={() => void review("changes_requested")}
                              >
                                Solicitar cambios
                              </button>
                            </section>
                          )}
                        {selected.state === "approved" &&
                          user.role !== "viewer" && (
                            <section className="export-box">
                              <h3>Lista para exportar</h3>
                              <p>
                                Descarga el JSON público aprobado y su imagen de
                                prueba. La integración con GitHub todavía no
                                está habilitada.
                              </p>
                              <button
                                className="primary"
                                disabled={busy || dirty}
                                onClick={() => void download()}
                              >
                                Descargar JSON aprobado
                              </button>
                              <small>
                                Exportar no publica ni despliega contenido.
                              </small>
                            </section>
                          )}
                        <details className="identity">
                          <summary>Identidad de esta revisión</summary>
                          <p>
                            El ID permanece aunque cambien el título o el slug.
                          </p>
                          <code>{selected.id}</code>
                          <p>Hash de la revisión</p>
                          <code>{selected.revisionHash}</code>
                        </details>
                      </aside>
                    </div>
                    <section className="history">
                      <h3>Actividad del recuerdo</h3>
                      {audit.length === 0 ? (
                        <p>Sin actividad todavía.</p>
                      ) : (
                        <ol>
                          {audit.map((event) => (
                            <li key={event.id}>
                              <span className="history-dot" />
                              <div>
                                <strong>
                                  {actions[event.action] ?? event.action}
                                </strong>
                                <small>
                                  {event.actor} ·{" "}
                                  {new Date(event.created_at).toLocaleString(
                                    "es-PE",
                                  )}
                                </small>
                                {typeof event.details.comment === "string" &&
                                  event.details.comment && (
                                    <p className="review-comment">
                                      {event.details.comment}
                                    </p>
                                  )}
                              </div>
                            </li>
                          ))}
                        </ol>
                      )}
                      <p className="field-help">
                        Se muestran las últimas 100 acciones. El historial no se
                        puede modificar mediante la API.
                      </p>
                    </section>
                  </section>
                )}
              </div>
            </main>
          )}
        </div>
        <footer className="shell-footer">
          Platform Engineering Perú · Administración de la comunidad
          {config?.fixtureAuthEnabled && (
            <button
              className="quiet"
              onClick={() => {
                if (navigateSection("memories"))
                  void loadWorkspace().catch(fail);
              }}
            >
              Abrir recuerdos de prueba
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
