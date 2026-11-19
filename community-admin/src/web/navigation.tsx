const pepMark = new URL("../../public/brand/mark.png", import.meta.url).href;
import React, { useEffect, useRef, useState } from "react";
import type { User } from "../shared/types";
import { AppIcon } from "./icons";
export interface Destination {
  id: string;
  label: string;
  icon: string;
  description: string;
}
export interface Workspace {
  id: string;
  label: string;
  icon: string;
  description: string;
  items: Destination[];
}
export const workspaces: Workspace[] = [
  {
    id: "home",
    label: "Inicio",
    icon: "overview",
    description: "Tu comunidad de un vistazo",
    items: [
      {
        id: "overview",
        label: "Resumen",
        icon: "overview",
        description: "Prioridades y próximos pasos",
      },
    ],
  },
  {
    id: "content",
    label: "Contenido",
    icon: "content",
    description: "Lo que compartimos",
    items: [
      {
        id: "content-memories",
        label: "Memories",
        icon: "image",
        description: "Momentos de nuestra comunidad",
      },
      {
        id: "blog",
        label: "Blog",
        icon: "content",
        description: "Publicaciones sociales confirmadas",
      },
      {
        id: "resources",
        label: "Recursos",
        icon: "resources",
        description: "Lecturas y herramientas útiles",
      },
      {
        id: "courses",
        label: "Cursos",
        icon: "courses",
        description: "Aprendizaje para compartir",
      },
      {
        id: "organizers",
        label: "Organizadores",
        icon: "people",
        description: "Las personas detrás del proyecto",
      },
      {
        id: "events",
        label: "Eventos",
        icon: "calendar",
        description: "Encuentros y actividades",
      },
      {
        id: "speakers",
        label: "Ponentes públicos",
        icon: "speakers",
        description: "Perfiles visibles en el sitio",
      },
      {
        id: "brands",
        label: "Marca",
        icon: "palette",
        description: "Identidad y material oficial",
      },
      {
        id: "settings",
        label: "Configuración",
        icon: "controls",
        description: "Enlaces e información del sitio",
      },
    ],
  },
  {
    id: "community",
    label: "Comunidad",
    icon: "people",
    description: "Relaciones que importan",
    items: [
      {
        id: "people",
        label: "Contactos",
        icon: "user",
        description: "Personas y puntos de contacto",
      },
      {
        id: "organizations",
        label: "Organizaciones",
        icon: "organizations",
        description: "Equipos y aliados",
      },
      {
        id: "speaker-profiles",
        label: "Ponentes privados",
        icon: "speakers",
        description: "Conversaciones y perfiles internos",
      },
      {
        id: "proposals",
        label: "Propuestas",
        icon: "message",
        description: "Ideas que pueden convertirse en encuentros",
      },
      {
        id: "participations",
        label: "Participaciones",
        icon: "participation",
        description: "Colaboraciones confirmadas",
      },
      {
        id: "sessions",
        label: "Sesiones",
        icon: "calendar",
        description: "Agenda, salas y ponentes",
      },
      {
        id: "followups",
        label: "Seguimientos",
        icon: "clock",
        description: "El siguiente paso con cada persona",
      },
      {
        id: "consents",
        label: "Consentimientos",
        icon: "shield",
        description: "Permisos y procedencia",
      },
    ],
  },
  {
    id: "jobs",
    label: "Oportunidades",
    icon: "jobs",
    description: "Vacantes de empresas para compartir",
    items: [
      {
        id: "jobs-candidates",
        label: "Vacantes por revisar",
        icon: "inbox",
        description: "Vacantes de empresas pendientes de revisión",
      },
      {
        id: "jobs-active",
        label: "Activas",
        icon: "jobs",
        description: "Vacantes disponibles",
      },
      {
        id: "jobs-stale",
        label: "Por verificar",
        icon: "scan",
        description: "Información que necesita confirmación",
      },
      {
        id: "jobs-closed",
        label: "Cerradas",
        icon: "archive",
        description: "Oportunidades finalizadas",
      },
      {
        id: "job-sources",
        label: "Fuentes",
        icon: "globe",
        description: "De dónde llegan las oportunidades",
      },
      {
        id: "collection-runs",
        label: "Recolecciones",
        icon: "refresh",
        description: "Revisar las últimas búsquedas",
      },
      {
        id: "job-exclusions",
        label: "Exclusiones",
        icon: "excluded",
        description: "Criterios para no volver a incluir",
      },
    ],
  },
  {
    id: "publishing",
    label: "Publicaciones",
    icon: "publish",
    description: "Del plan a la publicación",
    items: [
      {
        id: "calendar",
        label: "Calendario",
        icon: "calendar",
        description: "Organiza las próximas publicaciones",
      },
      {
        id: "linkedin",
        label: "LinkedIn",
        icon: "linkedin",
        description: "Mensajes para la red profesional",
      },
      {
        id: "youtube",
        label: "YouTube",
        icon: "youtube",
        description: "Videos y grabaciones",
      },
      {
        id: "publication-history",
        label: "Historial",
        icon: "history",
        description: "Resultados de cada publicación",
      },
    ],
  },
  {
    id: "administration",
    label: "Administración",
    icon: "settings",
    description: "Cuidar el espacio",
    items: [
      {
        id: "changesets",
        label: "Sitio web",
        icon: "approved",
        description: "Publicar contenido y comprobar su despliegue",
      },
      {
        id: "audit",
        label: "Auditoría",
        icon: "history",
        description: "Actividad y decisiones registradas",
      },
      {
        id: "operations",
        label: "Trabajos",
        icon: "activity",
        description: "Estado de los procesos",
      },
      {
        id: "integrations",
        label: "Integraciones",
        icon: "link",
        description: "Servicios conectados y permisos",
      },
      {
        id: "members",
        label: "Miembros y roles",
        icon: "shield",
        description: "Quién puede hacer cada cosa",
      },
    ],
  },
];
const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
export function pageInfo(active: string) {
  const route = active === "memories" ? "content-memories" : active;
  const workspace =
    workspaces.find((w) => w.items.some((i) => i.id === route)) ??
    workspaces[0];
  return {
    workspace,
    page:
      active === "memories"
        ? { ...workspace.items[0], label: "Recuerdos de prueba" }
        : (workspace.items.find((i) => i.id === route) ?? workspace.items[0]),
  };
}
export type SelectDestination = (id: string) => boolean | void;
function useDestinationFocus() {
  const observer = useRef<MutationObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), []);
  return () =>
    requestAnimationFrame(() => {
      observer.current?.disconnect();
      const focus = () => {
        const main = document.getElementById("main-content");
        if (!main) return false;
        main.focus();
        return document.activeElement === main;
      };
      if (focus()) return;
      observer.current = new MutationObserver(() => {
        if (focus()) observer.current?.disconnect();
      });
      observer.current.observe(
        document.getElementById("root") ?? document.body,
        { childList: true, subtree: true },
      );
    });
}
export function ProductNavigation({
  active,
  onSelect,
}: {
  active: string;
  onSelect: SelectDestination;
}) {
  const { workspace } = pageInfo(active),
    dialog = useRef<HTMLDialogElement>(null),
    focusDestination = useDestinationFocus();
  const [remembered, setRemembered] = useState<Record<string, string>>({});
  useEffect(() => {
    const open = () => dialog.current?.showModal();
    window.addEventListener("admin-open-workspaces", open);
    return () => window.removeEventListener("admin-open-workspaces", open);
  }, []);
  useEffect(() => {
    setRemembered((r) => ({ ...r, [workspace.id]: active }));
  }, [workspace.id, active]);
  function select(w: Workspace) {
    const destination = remembered[w.id] ?? w.items[0].id;
    if (onSelect(destination) === false) return;
    dialog.current?.close();
    focusDestination();
  }
  const items = (mobile = false) =>
    workspaces.map((w) => (
      <button
        key={w.id}
        className="shell-workspace"
        aria-current={workspace.id === w.id ? "page" : undefined}
        onClick={() => select(w)}
      >
        <span className="shell-workspace-icon">
          <AppIcon name={w.icon} size={22} />
        </span>
        <span>
          <strong>{w.label}</strong>
          <small>{w.description}</small>
        </span>
        {mobile && <AppIcon name="chevronRight" size={16} />}
      </button>
    ));
  return (
    <>
      <aside className="shell-sidebar">
        <a
          className="shell-brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            if (onSelect("overview") !== false) focusDestination();
          }}
          aria-label="Community Admin · Inicio"
        >
          <img
            className="shell-pep-mark"
            src={pepMark}
            width="48"
            height="48"
            alt=""
          />
          <span className="shell-brand-overline">
            PLATFORM ENGINEERING PERÚ
          </span>
          <strong>
            Community<span>Admin</span>
          </strong>
          <small>Un espacio para conectar.</small>
        </a>
        <div className="shell-sidebar-label">TU ESPACIO DE TRABAJO</div>
        <nav
          className="shell-primary"
          aria-label="Administración de la comunidad"
        >
          {items()}
        </nav>
        <div className="shell-sidebar-note">
          <span className="shell-note-icon">
            <AppIcon name="network" size={22} />
          </span>
          <strong>Hecho en comunidad.</strong>
          <p>Ideas, personas y momentos que merecen un buen lugar.</p>
        </div>
        <span className="shell-sidebar-foot">
          Platform Engineering Perú<span aria-hidden="true"> / </span>Comunidad
        </span>
      </aside>
      <dialog
        className="shell-dialog shell-workspaces-dialog"
        id="workspace-dialog"
        ref={dialog}
        aria-labelledby="workspace-title"
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current.close();
        }}
      >
        <div className="shell-dialog-heading">
          <div>
            <span className="shell-eyebrow">TU ESPACIO DE TRABAJO</span>
            <h2 id="workspace-title">¿Dónde seguimos?</h2>
          </div>
          <button
            className="shell-icon-button"
            aria-label="Cerrar espacios de trabajo"
            onClick={() => dialog.current?.close()}
          >
            <AppIcon name="close" />
          </button>
        </div>
        <nav
          className="shell-workspace-grid"
          aria-label="Elegir espacio de trabajo"
        >
          {items(true)}
        </nav>
      </dialog>
    </>
  );
}
const roleNames: Record<string, string> = {
  editor: "Edición",
  reviewer: "Revisión",
  viewer: "Solo lectura",
  owner: "Propietario",
  coordinator: "Coordinación",
  jobs_curator: "Curación de oportunidades",
  publisher: "Publicación",
};
export function ShellHeader({
  active,
  onSelect,
  user,
  darkTheme,
  onTheme,
  onLogout,
  onReverify,
  busy,
  localMode,
  fixtureMode,
}: {
  active: string;
  onSelect: SelectDestination;
  user: User;
  darkTheme: boolean;
  onTheme: () => void;
  onLogout: () => void;
  onReverify: () => void;
  busy: boolean;
  localMode: boolean;
  fixtureMode: boolean;
}) {
  const { workspace, page } = pageInfo(active),
    searchDialog = useRef<HTMLDialogElement>(null),
    searchInput = useRef<HTMLInputElement>(null),
    searchTrigger = useRef<HTMLButtonElement>(null),
    session = useRef<HTMLDetailsElement>(null),
    contextMenu = useRef<HTMLDetailsElement>(null),
    chrome = useRef<HTMLDivElement>(null),
    [query, setQuery] = useState("");
  const focusDestination = useDestinationFocus();
  useEffect(() => {
    const element = chrome.current,
      stage = element?.closest<HTMLElement>(".admin-stage");
    if (!element || !stage) return;
    const update = () =>
      stage.style.setProperty(
        "--shell-chrome-height",
        `${Math.ceil(element.getBoundingClientRect().height)}px`,
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      stage.style.removeProperty("--shell-chrome-height");
    };
  }, []);

  const all = workspaces.flatMap((w) =>
      w.items.map((i) => ({ ...i, workspace: w.label })),
    ),
    matches = all.filter((i) =>
      normalize(`${i.label} ${i.workspace} ${i.description}`).includes(
        normalize(query),
      ),
    ),
    results = query ? matches : all.slice(0, 8);
  const openSearch = () => {
    searchDialog.current?.showModal();
    searchInput.current?.focus();
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openSearch();
      }
      if (e.key === "Escape" && session.current?.open) {
        session.current.open = false;
        session.current.querySelector("summary")?.focus();
      }
      if (e.key === "Escape" && contextMenu.current?.open) {
        contextMenu.current.open = false;
        contextMenu.current.querySelector("summary")?.focus();
      }
    };
    const outside = (e: PointerEvent) => {
      if (session.current?.open && !session.current.contains(e.target as Node))
        session.current.open = false;
      if (
        contextMenu.current?.open &&
        !contextMenu.current.contains(e.target as Node)
      )
        contextMenu.current.open = false;
    };
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("pointerdown", outside);
    };
  }, []);
  function select(id: string) {
    if (onSelect(id) === false) return;
    searchDialog.current?.close();
    if (contextMenu.current) contextMenu.current.open = false;
    setQuery("");
    focusDestination();
  }
  return (
    <>
      <div className="shell-chrome" ref={chrome}>
        <header className="shell-header">
          <div className="shell-location">
            <button
              className="shell-icon-button shell-mobile-trigger"
              aria-label="Abrir espacios de trabajo"
              aria-haspopup="dialog"
              aria-controls="workspace-dialog"
              onClick={() =>
                window.dispatchEvent(new Event("admin-open-workspaces"))
              }
            >
              <AppIcon name="menu" />
            </button>
            <span className="shell-location-icon">
              <AppIcon name={workspace.icon} />
            </span>
            <div className="shell-breadcrumb">
              <span>
                Tu espacio <AppIcon name="chevronRight" size={12} />
                {workspace.label}
              </span>
              <strong>{page.label}</strong>
            </div>
          </div>
          <div className="shell-header-actions">
            <button
              className="shell-search-trigger"
              ref={searchTrigger}
              onClick={openSearch}
              aria-label="Buscar sección"
              aria-haspopup="dialog"
            >
              <AppIcon name="search" size={18} />
              <span>¿Qué quieres gestionar?</span>
              <kbd>
                <AppIcon name="command" size={12} /> K
              </kbd>
            </button>
            <button
              className="shell-icon-button shell-theme"
              aria-label="Cambiar tema"
              aria-pressed={darkTheme}
              title={darkTheme ? "Usar tema claro" : "Usar tema oscuro"}
              onClick={onTheme}
            >
              <AppIcon name={darkTheme ? "sun" : "moon"} />
            </button>
            {(localMode || fixtureMode) && (
              <span
                className="shell-local-badge"
                title={
                  localMode
                    ? "Revisión local · GitHub CLI verificado"
                    : "Cuenta de prueba local"
                }
              >
                <AppIcon name="local" size={13} />
                <span>Local</span>
              </span>
            )}
            <details className="shell-session" ref={session}>
              <summary aria-label={`Cuenta de ${user.name}`}>
                <span className="shell-avatar" aria-hidden="true">
                  {user.name
                    .split(" ")
                    .slice(0, 2)
                    .map((n) => n[0])
                    .join("")}
                </span>
                <span className="shell-account-caption">
                  <strong>{user.name.split(" ")[0]}</strong>
                  <small>{roleNames[user.role] ?? user.role}</small>
                </span>
                <AppIcon name="chevronDown" size={14} />
              </summary>
              <div className="shell-session-panel">
                <div className="shell-session-identity">
                  <span className="shell-avatar" aria-hidden="true">
                    {user.name
                      .split(" ")
                      .slice(0, 2)
                      .map((n) => n[0])
                      .join("")}
                  </span>
                  <div>
                    <strong>{user.name}</strong>
                    {user.github ? (
                      <a
                        href={user.github.profileUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        @{user.github.login}
                        <AppIcon name="external" size={12} />
                      </a>
                    ) : (
                      <small>{roleNames[user.role] ?? user.role}</small>
                    )}
                  </div>
                </div>
                <div className="shell-session-mode">
                  <AppIcon name={localMode ? "local" : "shield"} size={16} />
                  <div>
                    <strong>
                      {localMode
                        ? "Revisión local con GitHub CLI"
                        : fixtureMode
                          ? "Cuenta de prueba local"
                          : "Sesión privada"}
                    </strong>
                    <small>
                      {localMode || fixtureMode
                        ? "Tus permisos y la revisión se verifican al publicar."
                        : "Tus permisos se verifican en cada acción."}
                    </small>
                  </div>
                </div>
                {user.github && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      session.current!.open = false;
                      onReverify();
                    }}
                  >
                    <AppIcon name="refresh" size={17} />
                    Reverificar GitHub CLI
                  </button>
                )}
                <button disabled={busy} onClick={onLogout}>
                  <AppIcon name="logout" size={17} />
                  {localMode ? "Cerrar sesión" : "Cambiar cuenta"}
                </button>
              </div>
            </details>
          </div>
        </header>
        <div className="shell-context">
          <div className="shell-context-heading">
            <span>{workspace.label}</span>
            <small>{workspace.description}</small>
          </div>
          <details className="shell-context-mobile" ref={contextMenu}>
            <summary>
              <AppIcon name={page.icon} size={18} />
              <span>{page.label}</span>
              <small>Cambiar sección</small>
              <AppIcon name="chevronDown" size={15} />
            </summary>
            <nav aria-label={`Secciones móviles de ${workspace.label}`}>
              {workspace.items.map((i) => (
                <button
                  key={i.id}
                  aria-current={active === i.id ? "page" : undefined}
                  onClick={() => select(i.id)}
                >
                  <AppIcon name={i.icon} size={18} />
                  <span>{i.label}</span>
                  {active === i.id && <AppIcon name="check" size={16} />}
                </button>
              ))}
            </nav>
          </details>
          <nav
            aria-label={`Secciones de ${workspace.label}`}
            className="shell-context-nav"
          >
            {workspace.items.map((i) => (
              <button
                key={i.id}
                aria-current={active === i.id ? "page" : undefined}
                onClick={() => select(i.id)}
              >
                <AppIcon name={i.icon} size={17} />
                <span>{i.label}</span>
                {active === i.id && (
                  <span className="shell-context-current" aria-hidden="true" />
                )}
              </button>
            ))}
          </nav>
        </div>
      </div>
      <dialog
        className="shell-dialog shell-search-dialog"
        ref={searchDialog}
        aria-labelledby="section-search-title"
        onClose={() => setQuery("")}
        onKeyDownCapture={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          searchDialog.current?.close();
          searchTrigger.current?.focus();
        }}
        onClick={(e) => {
          if (e.target === searchDialog.current) searchDialog.current.close();
        }}
      >
        <div className="shell-dialog-heading">
          <div>
            <span className="shell-eyebrow">ENCUENTRA TU LUGAR</span>
            <h2 id="section-search-title">Ir a una sección</h2>
          </div>
          <button
            className="shell-icon-button"
            aria-label="Cerrar búsqueda"
            onClick={() => searchDialog.current?.close()}
          >
            <AppIcon name="close" />
          </button>
        </div>
        <label className="shell-search-field">
          <AppIcon name="search" />
          <span className="shell-sr-only">Buscar sección</span>
          <input
            ref={searchInput}
            autoFocus
            type="search"
            placeholder="Personas, recuerdos, publicaciones…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                searchDialog.current
                  ?.querySelector<HTMLButtonElement>(".shell-search-result")
                  ?.focus();
              }
            }}
          />
        </label>
        <span className="shell-search-caption">
          {query
            ? `${results.length} secciones encontradas`
            : "Accesos rápidos · Escribe para explorar todo"}
        </span>
        <ul className="shell-search-results">
          {results.map((i, index) => (
            <li key={i.id}>
              <button
                className="shell-search-result"
                onClick={() => select(i.id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  const next = index + (e.key === "ArrowDown" ? 1 : -1),
                    buttons =
                      searchDialog.current?.querySelectorAll<HTMLButtonElement>(
                        ".shell-search-result",
                      );
                  if (next < 0) searchInput.current?.focus();
                  else buttons?.[Math.min(next, results.length - 1)]?.focus();
                }}
              >
                <span className="shell-search-result-icon">
                  <AppIcon name={i.icon} />
                </span>
                <span>
                  <strong>{i.label}</strong>
                  <small>{i.description}</small>
                </span>
                <span className="shell-search-workspace">{i.workspace}</span>
                <AppIcon name="arrowRight" size={16} />
              </button>
            </li>
          ))}
        </ul>
        {results.length === 0 && (
          <div className="shell-search-empty" role="status">
            <AppIcon name="search" size={28} />
            <strong>No encontramos esa sección</strong>
            <p>Prueba con «personas», «recursos» o «publicaciones».</p>
          </div>
        )}
        <div className="shell-search-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> para explorar
          </span>
          <span>
            <kbd>esc</kbd> para cerrar
          </span>
        </div>
      </dialog>
    </>
  );
}
