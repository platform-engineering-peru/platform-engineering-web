import { mediaSelectable } from "./lifecycle";
import React, { useState, useEffect } from "react";
import {
  LifecycleActions,
  publishMediaInventory,
  useMediaInventoryUpdates,
} from "./lifecycle-actions";
import { request } from "./client";
import { AppIcon } from "./icons";
import { recordCoverSource } from "./record-cover";

export function RecordCover({
  record,
  className = "",
}: {
  record: any;
  className?: string;
}) {
  const source = recordCoverSource(record);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source, record.revision]);
  const unavailableLabel = failed
    ? "Vista previa no disponible"
    : record.type === "organizers"
      ? "Figura oficial no disponible"
      : record.type === "brands"
        ? "Archivo sin vista previa de imagen"
        : "Sin vista previa";
  const icon =
    record.type === "people" ||
    record.type === "speaker-profiles" ||
    record.type === "organizers"
      ? "people"
      : record.type === "events" || record.type === "sessions"
        ? "calendar"
        : "content";
  return (
    <div className={`record-cover ${className}`} data-kind={record.type}>
      {source && !failed ? (
        <img
          key={`${source}:${record.revision ?? ""}`}
          src={source}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className="record-cover-unavailable"
          role="img"
          aria-label={unavailableLabel}
          title={unavailableLabel}
        >
          <AppIcon name={icon} size={36} />
          {(failed ||
            record.type === "brands" ||
            record.type === "organizers") && <small>{unavailableLabel}</small>}
        </span>
      )}
    </div>
  );
}
export function EmptyState({
  icon = "folder",
  title,
  description,
  action,
}: {
  icon?: any;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="workspace-empty">
      <span className="empty-symbol">
        <AppIcon name={icon} size={30} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function EditorSections({
  active,
  onChange,
  media = true,
  review = true,
  content = true,
  publicReview = true,
}: {
  active: string;
  onChange: (id: string) => void;
  media?: boolean;
  review?: boolean;
  content?: boolean;
  publicReview?: boolean;
}) {
  const sections = [
    ["info", "settings", "Información", "Datos principales"],
    ...(content
      ? [["content", "content", "Contenido", "Textos bilingües"]]
      : []),
    ["relationships", "people", "Relaciones", "Personas y enlaces"],
    ...(media ? [["media", "image", "Medios", "Imágenes y archivos"]] : []),
    ...(review
      ? [
          [
            "review",
            "review",
            publicReview ? "Revisión" : "Proyección pública",
            publicReview ? "Aprobar y publicar" : "Crear un borrador",
          ],
        ]
      : []),
    ["history", "history", "Historial", "Versiones y actividad"],
  ];
  return (
    <nav className="editor-section-nav" aria-label="Secciones del editor">
      {sections.map(([id, icon, title, description]) => (
        <button
          key={id}
          type="button"
          aria-current={active === id ? "step" : undefined}
          onClick={() => onChange(id)}
        >
          <AppIcon name={icon as any} size={20} />
          <span>
            <strong>{title}</strong>
            <small>{description}</small>
          </span>
          {active === id && <span className="section-dot" />}
        </button>
      ))}
    </nav>
  );
}
export function MediaLibrary({
  media,
  value,
  onSelect,
  label = "Biblioteca de imágenes",
  referencedIds = [],
}: {
  media: any[];
  value?: string;
  onSelect: (id: string) => void;
  label?: string;
  referencedIds?: string[];
}) {
  const [inventory, setInventory] = useState(media);
  const [managing, setManaging] = useState<string | null>(null);
  useEffect(() => setInventory(media), [media]);
  useMediaInventoryUpdates(setInventory);
  const managed = inventory.find((asset) => asset.id === managing);
  const [editorDirty, setEditorDirty] = useState(false);
  useEffect(() => {
    const listener = (event: Event) =>
      setEditorDirty(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener("product-dirty", listener);
    return () => window.removeEventListener("product-dirty", listener);
  }, []);

  const search = React.useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const matches = inventory.filter((m) =>
    `${m.label} ${m.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="visual-library" aria-label={label}>
      <div className="library-heading">
        <div>
          <AppIcon name="image" size={20} />
          <strong>{label}</strong>
          <span>{inventory.length} archivos</span>
        </div>
        <label>
          <span className="sr-only">Buscar imagen en {label}</span>
          <AppIcon name="search" size={16} />
          <input
            type="search"
            ref={search}
            value={query}
            placeholder="Buscar en la biblioteca"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {notice && <p role="status">{notice}</p>}
      <div className="library-grid">
        {matches.map((m) => (
          <article
            className="library-asset-card"
            data-cleanup-pending={!mediaSelectable(m) || undefined}
            key={m.id}
          >
            {!mediaSelectable(m) ? (
              <div className="library-asset">
                <strong>{m.label || "Archivo propio"}</strong>
                <p>
                  Limpieza de bytes pendiente. No se puede adjuntar; abre sus
                  acciones para comprobarla o reintentar.
                </p>
              </div>
            ) : (
              <button
                type="button"
                className="library-asset"
                aria-pressed={value === m.id}
                onClick={() => onSelect(m.id)}
              >
                <div>
                  <img src={`/api/media/${m.id}`} alt="" loading="lazy" />
                  {value === m.id && (
                    <span>
                      <AppIcon name="check" size={16} />
                    </span>
                  )}
                </div>
                <strong>{m.label || "Imagen sin título"}</strong>
                <small>
                  {m.width} × {m.height}
                </small>
              </button>
            )}
            <button type="button" onClick={() => setManaging(m.id)}>
              Ver uso y acciones de {m.label || "este archivo"}
            </button>
          </article>
        ))}
      </div>
      {managed && (
        <section
          className="panel"
          aria-label="Gestión del archivo seleccionado"
        >
          <h3>{managed.label || "Archivo sin título"}</h3>
          <p className="field-help">
            Quitar una imagen del formulario solo separa una referencia.
            Eliminar un archivo requiere comprobar propiedad, uso actual e
            historial.
          </p>
          {(value === managed.id || referencedIds.includes(managed.id)) && (
            <p>
              Este archivo está seleccionado en el editor; quita o guarda esa
              referencia antes de solicitar su eliminación.
            </p>
          )}
          <LifecycleActions
            target={{
              module: "media",
              id: managed.id,
              version: managed.sha256 ?? "",
              name: managed.label || managed.id,
            }}
            disabled={
              editorDirty ||
              value === managed.id ||
              referencedIds.includes(managed.id)
            }
            onReload={async () => setInventory(await request<any[]>("/media"))}
            onComplete={async (result) => {
              const refreshed = await request<any[]>("/media");
              setInventory(refreshed);
              publishMediaInventory(refreshed);
              if (result?.cleanupPending) {
                setNotice(
                  "La referencia se retiró, pero la limpieza de bytes sigue pendiente. El archivo no se puede adjuntar; vuelve a confirmar su checksum si deseas reintentar.",
                );
              } else {
                setManaging(null);
                setNotice(
                  result?.bytesRemoved || result?.removed
                    ? "Archivo propio retirado del almacenamiento. Su historial se conserva."
                    : "Consulta el estado del archivo; no se confirmó la eliminación de sus bytes.",
                );
                requestAnimationFrame(() => search.current?.focus());
              }
            }}
          />
          <button type="button" onClick={() => setManaging(null)}>
            Cerrar gestión del archivo
          </button>
        </section>
      )}
      {!matches.length && (
        <p className="field-help">
          No hay imágenes que coincidan. Prueba otro nombre o sube un archivo.
        </p>
      )}
    </section>
  );
}
export function WorkflowTrack({ state }: { state: string }) {
  const index = ["draft", "submitted", "approved"].indexOf(state);
  return (
    <ol className="workflow-track" aria-label="Flujo editorial">
      {[
        ["draft", "Borrador"],
        ["submitted", "Revisión"],
        ["approved", "Aprobado"],
      ].map(([id, label], i) => (
        <li key={id} className={index >= i ? "complete" : ""}>
          <span>{index > i ? <AppIcon name="check" size={14} /> : i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}
