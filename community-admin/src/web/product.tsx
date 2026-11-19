import { SocialHandoff } from "./social-handoff";
import { NamedConfirmation } from "./named-confirmation";
import { mediaSelectable, takeLifecycleReference } from "./lifecycle";
import {
  pendingPublication,
  rememberPublication,
  forgetPublication,
} from "./publication-intent";
import {
  LifecycleActions,
  LifecycleProvider,
  LifecycleRetention,
  useMediaInventoryUpdates,
} from "./lifecycle-actions";
import { lifecycleCopy } from "./lifecycle";
import { RecordPublication } from "./jobs-publication";
import { PublicationStatus } from "./publication-status";
import { publicationView } from "./publication-state";
import React, { useEffect, useState, useRef } from "react";
import type { User } from "../shared/types";
import { AppIcon, ProviderLogo } from "./icons";
import {
  RecordCover,
  EmptyState,
  EditorSections,
  MediaLibrary,
  WorkflowTrack,
} from "./product-ui";
import { ApiError, downloadFile, request } from "./client";
import { getValue, setValue } from "./fields";
import { orderManagerRecords } from "./record-cover";
import {
  fieldInputType,
  fieldGroup,
  fieldSection,
  fieldPriority,
} from "./field-presentation";
import { nextUpcomingEvent, loadEventPages } from "./next-event";
import {
  PublicationCalendar,
  type CalendarPublication,
} from "./publication-calendar";
import { EditorialWorkspace } from "./editorial-workspace";
import { JobsWorkspace } from "./jobs-workspace";
import { providerCanAuthorize, validDestination } from "./jobs-ui";
import { EditorialConnection } from "./editorial-connection";
import {
  editorialStateLabel,
  type EditorialDraft,
  type EditorialSnapshot,
  type EditorialStatus,
} from "./editorial-state";
import { hashFile } from "./file-hash";
import { localTimeToInstant } from "./schedule";
import { contactColumns, readImportRows, mappedImport } from "./csv-import";

type Actor = User & {
  capabilities?: string[];
  roles?: string[];
  communityId?: string;
};
type EntityField = {
  key: string;
  label: string;
  kind: string;
  required?: boolean;
  options?: any[];
  target?: string;
  multiple?: boolean;
  nullable?: boolean;
};
type Definition = {
  type: string;
  label: string;
  scope: "public" | "private";
  fields: EntityField[];
  defaults: Record<string, any>;
};
type RecordDTO = {
  id: string;
  type: string;
  payload: Record<string, any>;
  revision: number;
  revisionHash: string;
  state: string;
  updatedAt: string;
  approvedHash: string | null;
  desiredStatus?: string;
};
const stateNames: Record<string, string> = {
  draft: "Borrador",
  queued: "En cola",
  complete: "Completado",
  deadletter: "Requiere intervención",
  healthy: "Conectado",
  disconnected: "Desconectado",
  submitted: "En revisión",
  approved: "Aprobado",
  changes_requested: "Cambios solicitados",
  active: "Activo",
  archived: "Archivado",
  scheduled: "Programado",
  sending: "Enviando",
  published: "Publicado",
  failed: "Fallido",
  unknown: "Resultado desconocido",
  unconfigured: "Sin configurar",
  pr_open: "PR abierta",
  checks_passed: "Checks aprobados",
  merged: "Integrado",
  deployed: "Desplegado",
  deploy_failed: "Despliegue fallido",
  checks_failed: "Checks fallidos",
  conflict: "Conflicto",
  cancelled: "Cancelado",
  candidate: "Vacante por revisar",
  stale: "Sin verificación reciente",
  closed: "Cerrado",
  excluded: "Excluido",
};
export const titleOf = (r: any): string =>
  String(
    r?.payload?.title?.["es-pe"] ??
      r?.payload?.title ??
      r?.payload?.name ??
      r?.payload?.preferredName ??
      r?.payload?.summary ??
      r?.title ??
      r?.name ??
      r?.id ??
      "Sin título",
  );
function fieldPath(path: string) {
  return path
    .replaceAll("/", ".")
    .replace(/^\./, "")
    .replace(/^payload\./, "");
}
function fieldName(path: string) {
  const parts = fieldPath(path).split(".");
  const labels: Record<string, string> = {
    tags: "Etiquetas",
    title: "Título",
    description: "Descripción",
    bio: "Biografía",
    name: "Nombre",
    media: "Imágenes",
    alt: "Texto alternativo",
    assetId: "Imagen",
    url: "URL",
    slug: "Identificador",
    date: "Fecha",
    year: "Año",
    email: "Correo",
    source: "Procedencia",
    permissionBasis: "Base de permiso",
  };
  return parts
    .map(
      (part) =>
        labels[part] ??
        (part === "es-pe"
          ? "español"
          : part === "en"
            ? "inglés"
            : /^\d+$/.test(part)
              ? String(Number(part) + 1)
              : part),
    )
    .join(" · ");
}
export function ErrorPanel({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div className="alert error" role="alert">
      <strong>
        {e.status === 403
          ? "Tu cuenta no tiene permiso"
          : e.code === "SESSION_OVERLAP"
            ? "Hay una superposición en la agenda"
            : e.status === 409
              ? "Hay un conflicto de revisión"
              : e.status === 0
                ? "Sin conexión"
                : "No se pudo completar la acción"}
      </strong>
      <p>{e.message}</p>
      {e.fieldErrors?.length > 0 && (
        <ul>
          {e.fieldErrors.map((f, i) => (
            <li key={i}>
              <a
                href={`#field-${fieldPath(f.path)}`}
                onClick={(e) => {
                  window.dispatchEvent(
                    new CustomEvent("reveal-editor-field", {
                      detail: `field-${fieldPath(f.path)}`,
                    }),
                  );
                  const target =
                    document.getElementById(`field-${fieldPath(f.path)}`) ??
                    document.getElementById(
                      `field-${fieldPath(f.path).split(".")[0]}`,
                    );
                  if (target) {
                    const disclosure = target.closest("details");
                    if (disclosure) disclosure.open = true;
                    e.preventDefault();
                    target.focus();
                    target.scrollIntoView({ block: "center" });
                  }
                }}
              >
                {fieldName(f.path)}
              </a>
              : {f.message}
            </li>
          ))}
        </ul>
      )}
      {retry && <button onClick={retry}>Volver a intentar</button>}
    </div>
  );
}
function Badge({ state }: { state: string }) {
  return <span className={`badge ${state}`}>{stateNames[state] ?? state}</span>;
}
function StructuredValue({
  label,
  value,
  onChange,
  disabled = false,
  template,
}: {
  label: string;
  value: any;
  onChange: (v: any) => void;
  disabled?: boolean;
  template?: any;
}) {
  if (Array.isArray(value))
    return (
      <fieldset className="structured-field" disabled={disabled}>
        <legend>{label}</legend>
        {value.map((item, i) => (
          <div className="array-item" key={i}>
            <StructuredValue
              label={`${label} ${i + 1}`}
              value={item}
              onChange={(next) =>
                onChange(value.map((x, n) => (n === i ? next : x)))
              }
            />
            <button
              type="button"
              onClick={() => onChange(value.filter((_, n) => n !== i))}
            >
              Quitar {i + 1}
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            onChange([
              ...value,
              template
                ? structuredClone(template)
                : typeof value[0] === "object"
                  ? Object.fromEntries(
                      Object.entries(value[0]).map(([k, v]) => [
                        k,
                        typeof v === "object" ? structuredClone(v) : "",
                      ]),
                    )
                  : "",
            ])
          }
        >
          Añadir {label.toLowerCase()}
        </button>
      </fieldset>
    );
  if (value && typeof value === "object")
    return (
      <fieldset className="structured-field" disabled={disabled}>
        <legend>{label}</legend>
        {Object.entries(value).map(([key, v]) => (
          <StructuredValue
            key={key}
            label={
              key === "es-pe"
                ? `${label} (español)`
                : key === "en"
                  ? `${label} (inglés)`
                  : ((
                      {
                        label: "Etiqueta",
                        href: "Enlace",
                        type: "Tipo",
                        value: "Valor",
                        visibility: "Visibilidad",
                        provenance: "Procedencia",
                        permissionBasis: "Base de permiso",
                      } as Record<string, string>
                    )[key] ?? key)
            }
            value={v}
            onChange={(next) => onChange({ ...value, [key]: next })}
          />
        ))}
      </fieldset>
    );
  const enumOptions =
    label === "Tipo"
      ? ["email", "phone", "url"]
      : label === "Visibilidad"
        ? ["private", "restricted"]
        : null;
  if (enumOptions)
    return (
      <label>
        {label}
        <select
          disabled={disabled}
          value={value ?? enumOptions[0]}
          onChange={(e) => onChange(e.target.value)}
        >
          {enumOptions.map((option) => (
            <option key={option} value={option}>
              {
                (
                  {
                    email: "Correo",
                    phone: "Teléfono",
                    url: "Enlace",
                    private: "Privado",
                    restricted: "Restringido",
                  } as Record<string, string>
                )[option]
              }
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <label>
      {label}
      <input
        disabled={disabled}
        type={
          typeof value === "number"
            ? "number"
            : typeof value === "boolean"
              ? "checkbox"
              : "text"
        }
        checked={typeof value === "boolean" ? value : undefined}
        value={typeof value === "boolean" ? undefined : (value ?? "")}
        onChange={(e) =>
          onChange(
            typeof value === "number"
              ? Number(e.target.value)
              : typeof value === "boolean"
                ? e.target.checked
                : e.target.value,
          )
        }
      />
    </label>
  );
}
function TagsField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [text, setText] = useState(value.join(", "));
  const saved = useRef(JSON.stringify(value));
  useEffect(() => {
    const serialized = JSON.stringify(value);
    if (serialized !== saved.current) {
      saved.current = serialized;
      setText(value.join(", "));
    }
  }, [value]);
  return (
    <label>
      {label}
      <input
        aria-label={label}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const next = e.target.value
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
          saved.current = JSON.stringify(next);
          onChange(next);
        }}
        onBlur={() => setText(value.join(", "))}
      />
      <small>Separa los valores con comas.</small>
    </label>
  );
}
function Fields({
  definition,
  payload,
  onChange,
  disabled,
  media,
  errors = [],
  referenceOptions,
}: {
  definition: Definition;
  payload: Record<string, any>;
  onChange: (v: any) => void;
  disabled: boolean;
  media: any[];
  errors?: { path: string; message: string }[];
  referenceOptions?: Record<string, any[]>;
}) {
  const [localeMode, setLocaleMode] = useState("compare");
  useEffect(() => {
    const reveal = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (definition.fields.some((f) => id.startsWith(`field-${f.key}`)))
        setLocaleMode("compare");
    };
    window.addEventListener("reveal-editor-field", reveal);
    return () => window.removeEventListener("reveal-editor-field", reveal);
  }, [definition.fields]);
  const errorFor = (key: string) =>
    errors.find(
      (e) =>
        e.path
          .replaceAll("/", ".")
          .replace(/^\./, "")
          .replace(/^payload\./, "") === key,
    )?.message;
  const errorProps = (key: string) => ({
    id: `field-${key}`,
    "aria-invalid": errorFor(key) ? true : undefined,
    "aria-describedby": errorFor(key) ? `field-error-${key}` : undefined,
  });
  return (
    <fieldset disabled={disabled} className="content-fields">
      <legend className="sr-only">Campos del registro</legend>
      {definition.fields.some((f) => f.kind === "localized") && (
        <div className="locale-toolbar">
          <div>
            <AppIcon name="content" size={18} />
            <span>Edición bilingüe</span>
            <small className="locale-completion">
              {
                definition.fields.filter(
                  (f) =>
                    f.kind === "localized" &&
                    String(getValue(payload, f.key)?.["es-pe"] ?? "").trim() &&
                    String(getValue(payload, f.key)?.en ?? "").trim(),
                ).length
              }
              /{definition.fields.filter((f) => f.kind === "localized").length}{" "}
              completos
            </small>
          </div>
          <div className="locale-switch" aria-label="Idioma de edición">
            {[
              ["es-pe", "Español"],
              ["en", "English"],
              ["compare", "Comparar idiomas"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={localeMode === id}
                onClick={() => setLocaleMode(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="field-help">
        Completa la información principal y sus traducciones. Los cambios se
        guardan como borrador.
      </p>
      {[
        "Información principal",
        "Contenido bilingüe",
        "Imágenes y archivos",
        "Relaciones y enlaces",
        "Opciones avanzadas",
      ].map((group) => {
        const fields = definition.fields.filter(
          (f) => fieldGroup(f.key, f.kind) === group,
        );
        const Group = group === "Opciones avanzadas" ? "details" : "section";
        return (
          fields.length > 0 && (
            <Group className="field-group" key={group}>
              {group === "Opciones avanzadas" && (
                <summary>
                  Identidad y presentación{" "}
                  <span>Slug, orden y preferencias</span>
                </summary>
              )}
              <h3 hidden={group === "Opciones avanzadas"}>
                <AppIcon
                  name={
                    group === "Contenido bilingüe"
                      ? "content"
                      : group === "Imágenes y archivos"
                        ? "image"
                        : group === "Relaciones y enlaces"
                          ? "external"
                          : "settings"
                  }
                  size={18}
                />
                {group}
              </h3>
              {fields.map((f) => {
                const rendered = (() => {
                  if (definition.type === "blog" && f.key.startsWith("source"))
                    return (
                      <label key={f.key}>
                        {f.label}
                        <input readOnly value={payload[f.key] ?? ""} />
                        <small>
                          Origen confirmado; no se cambia desde el editor.
                        </small>
                      </label>
                    );
                  const value = getValue(payload, f.key);
                  const change = (v: any) =>
                    onChange(setValue(payload, f.key, v));
                  if (f.kind === "localized")
                    return (
                      <section className="locale-fields" key={f.key}>
                        <h3>{f.label}</h3>
                        <div
                          className="localized-pair"
                          data-locale-mode={localeMode}
                        >
                          {["es-pe", "en"].map((lang) => (
                            <label
                              key={lang}
                              hidden={
                                localeMode !== "compare" && localeMode !== lang
                              }
                            >
                              {f.label} ({lang === "en" ? "inglés" : "español"})
                              {f.key.match(
                                /description|bio|abstract|summary|content|body/,
                              ) ? (
                                <textarea
                                  rows={4}
                                  {...errorProps(`${f.key}.${lang}`)}
                                  aria-label={`${f.label} (${lang === "en" ? "inglés" : "español"})`}
                                  value={value?.[lang] ?? ""}
                                  onChange={(e) =>
                                    change({ ...value, [lang]: e.target.value })
                                  }
                                />
                              ) : (
                                <input
                                  type="text"
                                  {...errorProps(`${f.key}.${lang}`)}
                                  aria-label={`${f.label} (${lang === "en" ? "inglés" : "español"})`}
                                  value={value?.[lang] ?? ""}
                                  onChange={(e) =>
                                    change({ ...value, [lang]: e.target.value })
                                  }
                                />
                              )}
                              {errorFor(`${f.key}.${lang}`) && (
                                <span
                                  className="field-error"
                                  id={`field-error-${f.key}.${lang}`}
                                >
                                  {errorFor(`${f.key}.${lang}`)}
                                </span>
                              )}
                            </label>
                          ))}
                        </div>
                        {f.required && (
                          <small className="field-help">
                            Completa ambos idiomas antes de enviar a revisión.
                          </small>
                        )}
                      </section>
                    );
                  if (f.kind === "media")
                    return (
                      <fieldset
                        className="media-picker"
                        key={f.key}
                        id={`field-${f.key}`}
                        tabIndex={-1}
                        aria-invalid={
                          errors.some((e) =>
                            fieldPath(e.path).startsWith(f.key),
                          ) || undefined
                        }
                      >
                        <legend>{f.label}</legend>
                        {errors
                          .filter((e) => fieldPath(e.path).startsWith(f.key))
                          .map((e) => (
                            <p className="field-error" key={e.path}>
                              {fieldName(e.path)}: {e.message}
                            </p>
                          ))}
                        {Array.isArray(value) ? (
                          value.map((item: any, i: number) => (
                            <section key={i}>
                              <label>
                                Imagen {i + 1}
                                <select
                                  aria-label={`Imagen ${i + 1}`}
                                  value={item.assetId ?? ""}
                                  onChange={(e) =>
                                    change(
                                      value.map((v: any, n: number) =>
                                        n === i
                                          ? { ...v, assetId: e.target.value }
                                          : v,
                                      ),
                                    )
                                  }
                                >
                                  <option value="">
                                    Selecciona una imagen
                                  </option>
                                  {media.filter(mediaSelectable).map((m) => (
                                    <option key={m.id} value={m.id}>
                                      {m.label} · {m.width} × {m.height}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <details className="picker-browser">
                                <summary>
                                  <AppIcon name="grid" size={16} /> Explorar
                                  biblioteca para imagen {i + 1}
                                </summary>
                                <MediaLibrary
                                  media={media}
                                  value={item.assetId}
                                  label={`Seleccionar imagen ${i + 1}`}
                                  onSelect={(assetId) =>
                                    change(
                                      value.map((v: any, n: number) =>
                                        n === i ? { ...v, assetId } : v,
                                      ),
                                    )
                                  }
                                />
                              </details>
                              {item.assetId && (
                                <img
                                  className="media-thumb"
                                  src={`/api/media/${item.assetId}`}
                                  alt={item.alt?.["es-pe"] ?? ""}
                                />
                              )}
                              <StructuredValue
                                label="Texto alternativo"
                                value={item.alt ?? { "es-pe": "", en: "" }}
                                onChange={(alt) =>
                                  change(
                                    value.map((v: any, n: number) =>
                                      n === i ? { ...v, alt } : v,
                                    ),
                                  )
                                }
                              />
                              <div className="field-row">
                                <label>
                                  Ajuste de imagen
                                  <select
                                    value={item.fit ?? "contain"}
                                    onChange={(e) =>
                                      change(
                                        value.map((v: any, n: number) =>
                                          n === i
                                            ? { ...v, fit: e.target.value }
                                            : v,
                                        ),
                                      )
                                    }
                                  >
                                    <option value="contain">
                                      Completa, sin recorte
                                    </option>
                                    <option value="cover">
                                      Recorte editorial
                                    </option>
                                  </select>
                                </label>
                                <label>
                                  Crédito público (opcional)
                                  <input
                                    value={item.credit ?? ""}
                                    onChange={(e) =>
                                      change(
                                        value.map((v: any, n: number) =>
                                          n === i
                                            ? {
                                                ...v,
                                                credit: e.target.value || null,
                                              }
                                            : v,
                                        ),
                                      )
                                    }
                                  />
                                </label>
                              </div>
                              <button
                                type="button"
                                disabled={i === 0}
                                onClick={() => {
                                  const copy = [...value];
                                  [copy[i - 1], copy[i]] = [
                                    copy[i],
                                    copy[i - 1],
                                  ];
                                  change(copy);
                                }}
                              >
                                Mover imagen {i + 1} antes
                              </button>
                              <button
                                type="button"
                                disabled={value.length <= 1}
                                onClick={() =>
                                  change(
                                    value.filter(
                                      (_: any, n: number) => n !== i,
                                    ),
                                  )
                                }
                              >
                                Quitar imagen {i + 1}
                              </button>
                            </section>
                          ))
                        ) : (
                          <label>
                            {f.label}
                            <select
                              value={value ?? ""}
                              onChange={(e) => change(e.target.value)}
                            >
                              <option value="">Sin imagen</option>
                              {media.filter(mediaSelectable).map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.label}
                                </option>
                              ))}
                            </select>
                            {value && (
                              <img
                                className="media-thumb"
                                src={`/api/media/${value}`}
                                alt="Recurso seleccionado"
                              />
                            )}
                          </label>
                        )}
                        {Array.isArray(value) && (
                          <button
                            type="button"
                            onClick={() =>
                              change([
                                ...value,
                                { assetId: "", alt: { "es-pe": "", en: "" } },
                              ])
                            }
                          >
                            Añadir imagen
                          </button>
                        )}
                      </fieldset>
                    );
                  if (f.kind === "reference")
                    return (
                      <ReferenceField
                        key={f.key}
                        field={f}
                        value={value}
                        onChange={change}
                        media={media}
                        sourceOptions={referenceOptions?.[f.target ?? ""]}
                      />
                    );
                  if (f.kind === "json")
                    return (
                      <StructuredValue
                        key={f.key}
                        label={f.label}
                        value={
                          f.key === "globalLinks"
                            ? {
                                home: "",
                                whatIs: "",
                                blog: "",
                                tooling: "",
                                reports: "",
                                university: "",
                                introCourse: "",
                                platformcon: "",
                                platformWeekly: "",
                                ...value,
                              }
                            : (value ?? {})
                        }
                        template={
                          f.key === "links"
                            ? { label: "", href: "" }
                            : f.key === "contactPoints"
                              ? {
                                  type: "email",
                                  value: "",
                                  visibility: "private",
                                  provenance: "",
                                  permissionBasis: "",
                                }
                              : undefined
                        }
                        onChange={change}
                      />
                    );
                  if (f.kind === "select")
                    return (
                      <label key={f.key}>
                        {f.label}
                        <select
                          value={value ?? ""}
                          onChange={(e) => change(e.target.value)}
                        >
                          <option value="">Selecciona</option>
                          {f.options?.map((o) => (
                            <option
                              key={typeof o === "string" ? o : o.value}
                              value={typeof o === "string" ? o : o.value}
                            >
                              {typeof o === "string"
                                ? (stateNames[o] ?? o)
                                : o.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  if (f.kind === "boolean")
                    return (
                      <label className="check-field" key={f.key}>
                        <input
                          type="checkbox"
                          checked={Boolean(value)}
                          onChange={(e) => change(e.target.checked)}
                        />
                        {f.label}
                      </label>
                    );
                  if (f.kind === "tags")
                    return (
                      <TagsField
                        key={f.key}
                        label={f.label}
                        value={value ?? []}
                        onChange={change}
                      />
                    );
                  return (
                    <label key={f.key}>
                      {f.label}
                      {f.kind === "textarea" ? (
                        <textarea
                          rows={4}
                          value={value ?? ""}
                          onChange={(e) => change(e.target.value)}
                        />
                      ) : (
                        <input
                          type={fieldInputType(f.key, f.kind)}
                          {...errorProps(f.key)}
                          value={value ?? ""}
                          onChange={(e) =>
                            change(
                              f.kind === "number"
                                ? e.target.value === ""
                                  ? null
                                  : Number(e.target.value)
                                : e.target.value === "" &&
                                    (f.nullable ||
                                      definition.defaults[f.key] === null)
                                  ? null
                                  : e.target.value,
                            )
                          }
                        />
                      )}{" "}
                      {errorFor(f.key) && (
                        <span
                          className="field-error"
                          id={`field-error-${f.key}`}
                        >
                          {errorFor(f.key)}
                        </span>
                      )}
                      {f.required && (
                        <small>Obligatorio para enviar a revisión.</small>
                      )}
                    </label>
                  );
                })();
                if (
                  !["reference", "json", "select", "boolean", "tags"].includes(
                    f.kind,
                  )
                )
                  return rendered;
                const matches = errors.filter(
                  (e) =>
                    fieldPath(e.path) === f.key ||
                    fieldPath(e.path).startsWith(f.key + "."),
                );
                return (
                  <div
                    key={f.key}
                    id={`field-${f.key}`}
                    tabIndex={-1}
                    role="group"
                    aria-invalid={matches.length > 0 || undefined}
                    aria-describedby={
                      matches.length ? `field-errors-${f.key}` : undefined
                    }
                  >
                    {rendered}
                    {matches.length > 0 && (
                      <div id={`field-errors-${f.key}`}>
                        {matches.map((e) => (
                          <p className="field-error" key={e.path}>
                            {fieldName(e.path)}: {e.message}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </Group>
          )
        );
      })}
    </fieldset>
  );
}
function ReferenceField({
  field,
  value,
  onChange,
  media,
  sourceOptions,
}: {
  field: EntityField;
  value: any;
  onChange: (v: any) => void;
  media: any[];
  sourceOptions?: any[];
}) {
  const [known, setKnown] = useState<Record<string, string>>({});
  const [query, setQuery] = useState(""),
    [items, setItems] = useState<any[]>([]),
    [error, setError] = useState<unknown>(null),
    [cursor, setCursor] = useState<string | null>(null);
  async function load(more = false) {
    try {
      if (sourceOptions) {
        setItems(
          sourceOptions.filter((item) =>
            titleOf(item)
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase()),
          ),
        );
        setCursor(null);
        setError(null);
        return;
      }
      if (field.target === "media") {
        setItems(
          media
            .filter(mediaSelectable)
            .map((m) => ({ id: m.id, payload: { name: m.label } })),
        );
        return;
      }
      const result = await request<{ items: any[]; nextCursor: string | null }>(
        `/records?type=${encodeURIComponent(field.target ?? "")}&q=${encodeURIComponent(query)}&limit=25${more && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      setItems((old) => (more ? [...old, ...result.items] : result.items));
      setCursor(result.nextCursor);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }
  useEffect(() => {
    void load();
  }, [field.target, query, media, sourceOptions]);
  useEffect(() => {
    const selectedIds: string[] = field.multiple
      ? (value ?? [])
      : value
        ? [value]
        : [];
    const missing = selectedIds.filter(
      (id) => !known[id] && !items.some((x) => x.id === id),
    );
    if (sourceOptions) {
      setKnown(
        Object.fromEntries(
          sourceOptions.map((item) => [item.id, titleOf(item)]),
        ),
      );
      return;
    }
    if (field.target === "media" || !missing.length) return;
    let active = true;
    void Promise.all(
      missing.map(async (id) => {
        try {
          return [id, titleOf(await request(`/records/${id}`))] as const;
        } catch {
          return [id, "Registro no disponible"] as const;
        }
      }),
    ).then((entries) => {
      if (active)
        setKnown((old) => ({ ...old, ...Object.fromEntries(entries) }));
    });
    return () => {
      active = false;
    };
  }, [value, items, field.target, sourceOptions]);
  return (
    <div className="reference-field">
      <label>
        Buscar {field.label.toLowerCase()}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {field.multiple ? (
        <div className="relationship-picker">
          <div className="selected-relationships">
            <h4>{field.label} seleccionados</h4>
            {(value ?? []).map((id: string) => (
              <div key={id}>
                <span className="relationship-avatar">
                  <AppIcon name="people" size={18} />
                </span>
                <strong>
                  {items.find((x) => x.id === id)
                    ? titleOf(items.find((x) => x.id === id))
                    : (known[id] ??
                      (sourceOptions
                        ? "Referencia no disponible en esta versión"
                        : "Cargando nombre…"))}
                </strong>
                <button
                  type="button"
                  aria-label={`Quitar ${items.find((x) => x.id === id) ? titleOf(items.find((x) => x.id === id)) : id}`}
                  onClick={() =>
                    onChange(value.filter((x: string) => x !== id))
                  }
                >
                  <AppIcon name="close" size={16} />
                </button>
              </div>
            ))}
            {!value?.length && <p>No has añadido registros todavía.</p>}
          </div>
          <div className="available-relationships">
            {items
              .filter((item) => !value?.includes(item.id))
              .map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onChange([...(value ?? []), item.id])}
                >
                  <AppIcon name="plus" size={16} />
                  {titleOf(item)}
                </button>
              ))}
          </div>
        </div>
      ) : (
        <label>
          {field.label}
          <select
            aria-label={field.label}
            multiple={field.multiple}
            value={field.multiple ? (value ?? []) : (value ?? "")}
            onChange={(e) =>
              onChange(
                field.multiple
                  ? Array.from(e.target.selectedOptions, (o) => o.value)
                  : e.target.value || null,
              )
            }
          >
            {!field.multiple && <option value="">Sin asociación</option>}
            {(field.multiple ? (value ?? []) : value ? [value] : [])
              .filter((id: string) => !items.some((x) => x.id === id))
              .map((id: string) => (
                <option key={id} value={id}>
                  {id} (selección actual)
                </option>
              ))}
            {items.map((item) => (
              <option value={item.id} key={item.id}>
                {titleOf(item)}
              </option>
            ))}
          </select>
        </label>
      )}
      {field.target === "media" && !field.multiple && (
        <details className="picker-browser">
          <summary>
            <AppIcon name="image" size={18} /> Elegir visualmente
          </summary>
          <MediaLibrary
            media={media}
            value={value}
            onSelect={onChange}
            label={field.label}
          />
        </details>
      )}
      {cursor && (
        <button type="button" onClick={() => void load(true)}>
          Más opciones
        </button>
      )}
      {field.target === "media" && value && (
        <img
          className="media-thumb"
          src={`/api/media/${value}`}
          alt="Recurso asociado a esta identidad"
        />
      )}
      <ErrorPanel error={error} />
    </div>
  );
}
function useAction(user: Actor) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState("");
  const headers = (revision?: number) => ({
    "X-CSRF-Token": user.csrfToken,
    "Idempotency-Key": crypto.randomUUID(),
    ...(revision ? { "If-Match": `"${revision}"` } : {}),
  });
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, notice, setNotice, headers, run };
}
export function ProductPage({
  section,
  user,
  onNavigate,
}: {
  section: string;
  user: Actor;
  onNavigate: (s: string) => void;
}) {
  const [editorialMode, setEditorialMode] = useState("local");
  const [catalog, setCatalog] = useState<Definition[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let active = true;
    Promise.all([
      request<{ entities: Definition[] }>("/catalog"),
      request<{ editorialMode?: string }>("/config"),
    ])
      .then(([c, config]) => {
        if (active) {
          setCatalog(c.entities);
          setEditorialMode(config.editorialMode ?? "local");
        }
      })
      .catch((e) => {
        if (active) setError(e);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const type = section === "content-memories" ? "memories" : section;
  const definition = catalog.find((d) => d.type === type);
  return (
    <LifecycleProvider value={{ user, navigate: onNavigate }}>
      <main id="main-content" tabIndex={-1} className="product-main">
        <div className="product-breadcrumb">
          PLATFORM ENGINEERING PERÚ <span>/ ADMINISTRACIÓN</span>
        </div>
        {[
          "audit",
          "operations",
          "collection-runs",
          "publication-history",
          "changesets",
        ].includes(section) && <LifecycleRetention />}
        {["integrations", "members"].includes(section) && (
          <LifecycleRetention kind="access" />
        )}
        {section === "overview" && <LifecycleRetention kind="overview" />}
        {["linkedin", "youtube", "calendar"].includes(section) && (
          <LifecycleRetention kind="provider" />
        )}
        {loading ? (
          <section className="panel loading-panel" role="status">
            <strong>Cargando módulos…</strong>
            <p>Preparando el contenido y los permisos de tu cuenta.</p>
            <div className="loading-line" aria-hidden="true" />
            <div className="loading-line" aria-hidden="true" />
          </section>
        ) : error ? (
          <ErrorPanel error={error} retry={() => location.reload()} />
        ) : definition?.type === "events" && editorialMode === "github" ? (
          <EditorialWorkspace
            key="github-events"
            user={user}
            defaults={definition.defaults}
            onDirty={reportEditorialDirty}
            renderFields={(
              payload,
              onChange,
              disabled,
              errors,
              pane,
              references,
            ) => (
              <Fields
                definition={{
                  ...definition,
                  fields: definition.fields.filter(
                    (f) => fieldSection(f.key, f.kind, f.target) === pane,
                  ),
                }}
                payload={payload}
                onChange={onChange}
                disabled={disabled}
                errors={errors}
                media={[]}
                referenceOptions={references}
              />
            )}
          />
        ) : definition ? (
          <>
            {definition.type === "events" && (
              <div className="alert info">
                <strong>Fuente local de este equipo</strong>
                <p>
                  Estos eventos no se comparten automáticamente con GitHub. El
                  modo editorial compartido se configura por separado.
                </p>
              </div>
            )}
            <RecordWorkspace
              definition={definition}
              user={user}
              onNavigate={onNavigate}
            />
          </>
        ) : section === "overview" ? (
          <Overview user={user} onNavigate={onNavigate} />
        ) : (
          <OperationalPage
            section={section}
            user={user}
            onNavigate={onNavigate}
          />
        )}
      </main>
    </LifecycleProvider>
  );
}
function reportEditorialDirty(dirty: boolean) {
  window.dispatchEvent(new CustomEvent("product-dirty", { detail: dirty }));
}
function useDirtyGuard(dirty: boolean) {
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("product-dirty", { detail: dirty }));
    return () => {
      window.dispatchEvent(new CustomEvent("product-dirty", { detail: false }));
    };
  }, [dirty]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
}
function RecordWorkspace({
  definition,
  user,
  onNavigate,
}: {
  definition: Definition;
  user: Actor;
  onNavigate: (section: string) => void;
}) {
  const a = useAction(user);
  const [csvMapping, setCsvMapping] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [editorSection, setEditorSection] = useState("info");
  const [managerView, setManagerView] = useState<"grid" | "list">(
    ["memories", "organizers", "speakers", "brands"].includes(definition.type)
      ? "grid"
      : "list",
  );
  const [uploadSource, setUploadSource] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploadPermission, setUploadPermission] = useState("");
  const [exportReason, setExportReason] = useState("");
  const [items, setItems] = useState<RecordDTO[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [query, setQuery] = useState(""),
    [state, setState] = useState(""),
    [selected, setSelected] = useState<RecordDTO | null>(null),
    [payload, setPayload] = useState<Record<string, any>>({}),
    [media, setMedia] = useState<any[]>([]),
    [events, setEvents] = useState<any[]>([]),
    [comment, setComment] = useState(""),
    [preview, setPreview] = useState(""),
    [conflict, setConflict] = useState(false),
    [csv, setCsv] = useState(""),
    [importReport, setImportReport] = useState<any>(null),
    [showImport, setShowImport] = useState(false);
  useMediaInventoryUpdates(setMedia);
  let csvRows: string[][] = [],
    csvError = "";
  try {
    csvRows = readImportRows(csv);
  } catch {
    csvError =
      "No se pudo leer el CSV. Revisa comillas, separadores y columnas de cada fila.";
  }
  useEffect(() => {
    try {
      const rows = readImportRows(csv),
        headers = rows[0] ?? [];
      setCsvMapping(
        Object.fromEntries(
          Object.keys(contactColumns).map((key) => [
            key,
            headers.includes(key) ? String(headers.indexOf(key)) : "",
          ]),
        ),
      );
    } catch {
      setCsvMapping({});
    }
  }, [csv]);
  const importCsv = mappedImport(csvRows, csvMapping);
  const has = (cap: string) =>
    (user.capabilities?.includes("*") || user.capabilities?.includes(cap)) ??
    (user.role === "editor" && cap === "content:write");
  const writable = has(
    definition.scope === "public"
      ? "content:write"
      : definition.type === "people" || definition.type === "organizations"
        ? "contacts:write"
        : "community:write",
  );
  const dirty =
    !!selected && JSON.stringify(payload) !== JSON.stringify(selected.payload);
  const dirtyPublicationRef = useRef(dirty);
  dirtyPublicationRef.current = dirty;
  const selectedPublicationRef = useRef(selected);
  selectedPublicationRef.current = selected;
  useDirtyGuard(dirty);
  async function load(append = false) {
    const result = await request<{
      items: RecordDTO[];
      nextCursor: string | null;
    }>(
      `/records?type=${encodeURIComponent(definition.type)}&q=${encodeURIComponent(query)}${state ? `&state=${encodeURIComponent(state)}` : ""}&limit=25${append && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    setItems((old) => (append ? [...old, ...result.items] : result.items));
    setCursor(result.nextCursor);
  }
  useEffect(() => {
    void a.run(async () => {
      await load();
      if (definition.scope === "public") setMedia(await request("/media"));
    });
  }, [query, state, definition.type]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  async function open(id: string) {
    if (
      dirty &&
      !confirm("Hay cambios sin guardar. ¿Descartarlos y abrir otro registro?")
    )
      return;
    await a.run(async () => {
      const record = await request<RecordDTO>(`/records/${id}`);
      setSelected(record);
      setEditing(true);
      setEditorSection("info");
      setPayload(structuredClone(record.payload));
      setConflict(false);
      setPreview("");
      setEvents(await request(`/records/${id}/audit`));
      if (window.matchMedia("(max-width: 950px)").matches)
        requestAnimationFrame(() =>
          document.getElementById("record-editor")?.focus(),
        );
    });
  }
  useEffect(() => {
    const raw = sessionStorage.getItem("admin-open-record");
    if (!raw) return;
    try {
      const intent = JSON.parse(raw);
      if (intent.type === definition.type) {
        sessionStorage.removeItem("admin-open-record");
        void open(intent.id);
      }
    } catch {
      sessionStorage.removeItem("admin-open-record");
    }
  }, [definition.type]);
  async function save() {
    if (!selected) return;
    const snapshot = structuredClone(payload);
    setSaving(true);
    await a.run(async () => {
      try {
        const record = await request<RecordDTO>(`/records/${selected.id}`, {
          method: "PATCH",
          headers: a.headers(selected.revision),
          body: JSON.stringify({ payload: snapshot }),
        });
        setSelected(record);
        setPayload((current) =>
          JSON.stringify(current) === JSON.stringify(snapshot)
            ? structuredClone(record.payload)
            : current,
        );
        await load();
        a.setNotice(
          "Revisión guardada. Las aprobaciones anteriores quedan invalidadas.",
        );
      } catch (e) {
        if (
          (e as ApiError).status === 409 &&
          (e as ApiError).code === "REVISION_CONFLICT"
        )
          setConflict(true);
        throw e;
      }
    });
    setSaving(false);
  }
  useEffect(() => {
    if (!dirty || !writable || a.busy || a.error || conflict) return;
    const timer = setTimeout(() => void save(), 800);
    return () => clearTimeout(timer);
  }, [payload, dirty, writable, a.busy, a.error, conflict]);
  async function create() {
    await a.run(async () => {
      const record = await request<RecordDTO>("/records", {
        method: "POST",
        headers: a.headers(),
        body: JSON.stringify({
          type: definition.type,
          payload:
            definition.type === "events"
              ? { ...definition.defaults, communityKind: "own" }
              : definition.defaults,
        }),
      });
      setSelected(record);
      setEditing(true);
      setEditorSection("info");
      setPayload(structuredClone(record.payload));
      setEvents([]);
      setConflict(false);
      await load();
      requestAnimationFrame(() =>
        document.getElementById("record-editor")?.focus(),
      );
      a.setNotice(
        "Registro creado. Completa sus campos; los cambios se guardan automáticamente.",
      );
    });
  }
  async function action(name: string, body: any = {}) {
    if (!selected) return;
    await a.run(async () => {
      const result = await request<any>(`/records/${selected.id}/${name}`, {
        method: "POST",
        headers: a.headers(selected.revision),
        body: JSON.stringify(body),
      });
      if (name === "preview") {
        setPreview(result.url);
        a.setNotice(
          "Vista previa privada lista. El contenido sigue sin publicarse.",
        );
        return;
      }
      if (result.id) {
        setSelected(result);
        setPayload(structuredClone(result.payload));
      }
      await load();
      setEvents(await request(`/records/${selected.id}/audit`));
      a.setNotice(
        name === "submit"
          ? "Revisión enviada. Otra persona debe revisar esta versión."
          : name === "review"
            ? "Decisión registrada para esta revisión."
            : "Acción registrada.",
      );
    });
  }
  async function upload(file?: File) {
    if (!file) return;
    setUploadStatus(`Verificando ${file.name}…`);
    await a.run(async () => {
      const data = new FormData();
      data.append("file", file);
      data.append("source", uploadSource);
      data.append("permissionBasis", uploadPermission);
      const response = await fetch("/api/media/uploads", {
        method: "POST",
        headers: { "X-CSRF-Token": user.csrfToken },
        body: data,
      }).catch((error) => {
        setUploadStatus(
          `La transferencia de ${file.name} se interrumpió. Vuelve a seleccionar el archivo para intentar de nuevo.`,
        );
        throw new ApiError(
          0,
          "UPLOAD_CONNECTION_FAILED",
          "La conexión se interrumpió. Vuelve a seleccionar el archivo para intentar de nuevo.",
        );
      });
      if (!response.ok) {
        const e = await response.json().catch(() => ({
          code: "UPLOAD_FAILED",
          message:
            "El servidor no pudo verificar la imagen. Vuelve a seleccionar el archivo para intentar de nuevo.",
        }));
        setUploadStatus(
          `No se pudo verificar ${file.name}. Revisa el error y vuelve a seleccionarlo.`,
        );
        throw new ApiError(response.status, e.code, e.message, e.fieldErrors);
      }
      const result = await response.json().catch(() => {
        setUploadStatus(
          `No se pudo leer la verificación de ${file.name}. Vuelve a seleccionar el archivo.`,
        );
        throw new ApiError(
          502,
          "UPLOAD_RESPONSE_INVALID",
          "El servidor no devolvió una verificación válida. Intenta de nuevo.",
        );
      });
      setUploadStatus(
        `${file.name} verificado. Ya está disponible para seleccionar.`,
      );
      setMedia(await request("/media"));
      const disclosure = document.querySelector<HTMLDetailsElement>(
        ".record-editor details.panel",
      );
      if (disclosure) disclosure.open = false;
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(
            ".record-editor .media-picker select, .record-editor .media-thumb",
          )
          ?.focus(),
      );
      a.setNotice(
        `Imagen verificada: ${result.width ?? ""} × ${result.height ?? ""}. Selecciónala en el contenido.`,
      );
    });
  }
  const selectedTitle = titleOf(selected);
  const isMediaField = (f: EntityField) =>
    f.kind === "media" || f.target === "media";
  useEffect(() => {
    const reveal = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      const field = definition.fields.find((f) =>
        path.startsWith(`field-${f.key}`),
      );
      setEditing(true);
      setEditorSection(
        field ? fieldSection(field.key, field.kind, field.target) : "info",
      );
      requestAnimationFrame(() => document.getElementById(path)?.focus());
    };
    window.addEventListener("reveal-editor-field", reveal);
    return () => window.removeEventListener("reveal-editor-field", reveal);
  }, [definition]);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {definition.scope === "public"
              ? "CONTENIDO DEL SITIO"
              : "DIRECTORIO PRIVADO"}
          </div>
          <h1>
            {definition.label}
            <span className="collection-count">
              {items.length}
              {cursor ? "+" : ""}
            </span>
          </h1>
          <p>
            {definition.scope === "public"
              ? "Borradores privados. Revisión antes de publicar."
              : "Directorio privado"}
          </p>
        </div>
        {writable && (
          <button
            className="primary"
            disabled={a.busy || dirty}
            onClick={() =>
              definition.type === "blog"
                ? onNavigate("publication-history")
                : void create()
            }
          >
            <AppIcon name="plus" size={18} />{" "}
            {definition.type === "blog"
              ? "Registrar publicación social"
              : "Nuevo registro"}
          </button>
        )}
      </div>
      <ErrorPanel error={a.error} retry={() => void a.run(() => load())} />
      {a.notice && (
        <div className="alert success" role="status">
          {a.notice}
        </div>
      )}
      {!writable && (
        <p className="alert info">
          Tu cuenta puede revisar los registros permitidos. Las acciones
          dependen de tus permisos.
        </p>
      )}
      {definition.type === "people" && !editing && (
        <section className="toolbar people-csv-toolbar">
          <button onClick={() => setShowImport(!showImport)}>
            Importar CSV
          </button>
          {has("contacts:export") && (
            <label>
              Motivo de la exportación privada
              <input
                value={exportReason}
                onChange={(e) => setExportReason(e.target.value)}
              />
            </label>
          )}
          {has("contacts:export") && (
            <button
              disabled={exportReason.trim().length < 5}
              onClick={() =>
                void a.run(async () => {
                  const response = await fetch("/api/people/exports", {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      ...a.headers(),
                    },
                    body: JSON.stringify({ reason: exportReason }),
                  });
                  if (!response.ok) {
                    const error = await response.json();
                    throw new ApiError(
                      response.status,
                      error.code,
                      error.message,
                      error.fieldErrors,
                    );
                  }
                  downloadFile(
                    await response.text(),
                    "contacts.csv",
                    "text/csv",
                  );
                  a.setNotice("Exportación privada registrada en auditoría.");
                })
              }
            >
              Exportar CSV privado
            </button>
          )}
        </section>
      )}
      {showImport && (
        <section className="panel">
          <h2>Importar contactos con revisión</h2>
          <p>
            Primero revisa los errores y las posibles coincidencias. No se
            fusionan personas automáticamente.
          </p>
          <label>
            Archivo CSV
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                void e.target.files?.[0]?.text().then(setCsv);
                setImportReport(null);
              }}
            />
          </label>
          <label>
            Contenido CSV
            <textarea
              rows={6}
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setImportReport(null);
              }}
            />
          </label>
          <button
            type="button"
            onClick={() =>
              downloadFile(
                Object.keys(contactColumns).join(",") + "\r\n",
                "contact-import-template.csv",
                "text/csv",
              )
            }
          >
            Descargar plantilla CSV
          </button>
          {csvError && (
            <p className="alert error" role="alert">
              {csvError}
            </p>
          )}
          {csvRows.length > 0 && (
            <fieldset>
              <legend>Asignar columnas del archivo</legend>
              <p className="field-help">
                Las columnas sin asignar no se importan. Nombre, procedencia y
                base de permiso son obligatorios.
              </p>
              <div className="form-grid">
                {Object.entries(contactColumns).map(([key, label]) => (
                  <label key={key}>
                    Columna para {label.toLowerCase()}
                    <select
                      aria-label={`Columna para ${label.toLowerCase()}`}
                      value={csvMapping[key] ?? ""}
                      onChange={(e) => {
                        setCsvMapping({ ...csvMapping, [key]: e.target.value });
                        setImportReport(null);
                      }}
                    >
                      <option value="">No importar</option>
                      {csvRows[0].map((header, index) => (
                        <option key={index} value={String(index)}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <button
            disabled={!csv || Boolean(csvError) || a.busy}
            onClick={() =>
              void a.run(async () =>
                setImportReport(
                  await request("/people/import", {
                    method: "POST",
                    headers: a.headers(),
                    body: JSON.stringify({ csv: importCsv, dryRun: true }),
                  }),
                ),
              )
            }
          >
            Previsualizar importación
          </button>
          {importReport && (
            <>
              <ResultView value={importReport} />
              <button
                disabled={
                  a.busy ||
                  Boolean(importReport.errors?.length) ||
                  !importReport.accepted
                }
                onClick={() =>
                  void a.run(async () => {
                    setImportReport(
                      await request("/people/import", {
                        method: "POST",
                        headers: a.headers(),
                        body: JSON.stringify({ csv: importCsv, dryRun: false }),
                      }),
                    );
                    await load();
                    a.setNotice(
                      "Importación procesada. Revisa el informe de filas.",
                    );
                  })
                }
              >
                Importar filas válidas
              </button>
            </>
          )}
        </section>
      )}
      <div
        className="record-grid manager-workspace"
        data-editing={editing}
        data-view={managerView}
      >
        <aside
          id="record-list"
          tabIndex={-1}
          className="panel record-list"
          hidden={editing}
        >
          <div className="collection-toolbar">
            <div className="collection-search">
              <label>
                Buscar
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Nombre, título o referencia"
                />
              </label>
            </div>
            <div className="collection-filter">
              <AppIcon name="filter" size={18} />
              <label>
                Estado
                <select
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                >
                  <option value="">Todos</option>
                  {(definition.scope === "public"
                    ? [
                        "draft",
                        "submitted",
                        "approved",
                        "changes_requested",
                        "archived",
                      ]
                    : ["active", "archived"]
                  ).map((s) => (
                    <option key={s} value={s}>
                      {stateNames[s]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="collection-view" aria-label="Vista del gestor">
              <button
                aria-label="Vista de tarjetas"
                aria-pressed={managerView === "grid"}
                onClick={() => setManagerView("grid")}
              >
                <AppIcon name="grid" size={18} />
              </button>
              <button
                aria-label="Vista de lista"
                aria-pressed={managerView === "list"}
                onClick={() => setManagerView("list")}
              >
                <AppIcon name="list" size={18} />
              </button>
            </div>
          </div>
          <div className="collection-caption">
            <span>
              <AppIcon
                name={definition.scope === "private" ? "shield" : "folder"}
                size={16}
              />
              {definition.scope === "private"
                ? "Directorio privado"
                : "Archivo editorial"}
            </span>
            <p className="field-help">
              {items.length}
              {cursor ? "+" : ""} registros cargados
            </p>
          </div>
          {items.length === 0 ? (
            <div className="list-empty">
              <strong>
                {a.busy
                  ? "Cargando…"
                  : query || state
                    ? "No hay coincidencias"
                    : "Todavía no hay registros"}
              </strong>
              <p>
                {query || state
                  ? "Prueba otra búsqueda o restablece los filtros."
                  : definition.scope === "public"
                    ? "Importa el contenido del sitio desde Resumen o crea un borrador."
                    : "Crea un registro autorizado para comenzar."}
              </p>
              {(query || state) && (
                <button
                  onClick={() => {
                    setQuery("");
                    setState("");
                  }}
                >
                  Restablecer filtros
                </button>
              )}
            </div>
          ) : (
            <ul>
              {orderManagerRecords(items, definition.type).map((r) => (
                <li key={r.id}>
                  <button
                    className={selected?.id === r.id ? "selected" : ""}
                    aria-current={selected?.id === r.id ? "true" : undefined}
                    onClick={() => void open(r.id)}
                  >
                    <RecordCover record={r} />
                    <div className="record-card-copy">
                      <Badge state={r.state} />
                      <strong>{titleOf(r)}</strong>
                      <p>
                        {String(
                          r.payload.description?.["es-pe"] ??
                            r.payload.role?.["es-pe"] ??
                            r.payload.company ??
                            r.payload.preferredName ??
                            "",
                        ).slice(0, 120)}
                      </p>
                      <small>
                        Revisión {r.revision} ·{" "}
                        {new Date(r.updatedAt).toLocaleDateString("es-PE")}
                      </small>
                    </div>
                    <span className="card-open">
                      <AppIcon name="arrowRight" size={18} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {cursor && (
            <button
              disabled={a.busy}
              onClick={() => void a.run(() => load(true))}
            >
              Cargar más
            </button>
          )}
          <button
            className="quiet"
            disabled={a.busy}
            onClick={() => void a.run(() => load())}
          >
            Actualizar lista
          </button>
        </aside>
        {!selected ? (
          <section className="empty-editor">
            <div className="eyebrow">TODO TIENE SU LUGAR</div>
            <h2>Abre un registro para comenzar.</h2>
            <p>
              Contenido, traducciones, medios y decisiones de revisión se
              mantienen juntos.
            </p>
          </section>
        ) : (
          <section
            id="record-editor"
            tabIndex={-1}
            className="panel record-editor focused-editor"
            hidden={!editing}
            aria-busy={a.busy}
          >
            <div className="editor-header">
              <button
                type="button"
                className="back-to-records"
                onClick={() => {
                  setEditing(false);
                  requestAnimationFrame(() =>
                    document.getElementById("record-list")?.focus(),
                  );
                }}
              >
                <AppIcon name="arrowLeft" size={18} /> Volver a la lista
              </button>
              <div>
                <Badge state={selected.state} />
                <h2>{selectedTitle}</h2>
                <p>
                  Revisión {selected.revision} ·{" "}
                  {new Date(selected.updatedAt).toLocaleString("es-PE")}
                </p>
              </div>
              <span
                className={`save-state ${conflict ? "conflict" : dirty ? "dirty" : ""}`}
              >
                {conflict
                  ? "Conflicto"
                  : saving
                    ? "Guardando…"
                    : dirty
                      ? "Cambios sin guardar"
                      : "Guardado"}
              </span>
            </div>
            {definition.scope === "public" && (
              <WorkflowTrack state={selected.state} />
            )}
            <div className="focused-editor-layout">
              <EditorSections
                active={editorSection}
                onChange={setEditorSection}
                media={definition.scope === "public"}
                content={definition.fields.some(
                  (f) => fieldSection(f.key, f.kind, f.target) === "content",
                )}
                review={
                  definition.scope === "public" ||
                  definition.type === "speaker-profiles"
                }
                publicReview={definition.scope === "public"}
              />
              <div
                className="editor-section-content"
                data-section={editorSection}
              >
                {conflict && (
                  <div className="alert warning">
                    <strong>Tu versión local se conserva.</strong>
                    <p>
                      Descarga tu copia antes de cargar la versión guardada y
                      comparar cambios.
                    </p>
                    <button
                      onClick={() =>
                        downloadFile(payload, `${selected.id}-local.json`)
                      }
                    >
                      Descargar mi copia
                    </button>
                    <button
                      onClick={() => {
                        setPayload(selected.payload);
                        void open(selected.id);
                      }}
                    >
                      Cargar versión guardada
                    </button>
                  </div>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                  }}
                >
                  {writable && (
                    <div className="form-actions">
                      <span
                        className={`save-state ${conflict ? "conflict" : dirty ? "dirty" : ""}`}
                        role="status"
                      >
                        {conflict
                          ? "Conflicto: conserva tu copia"
                          : saving
                            ? "Guardando…"
                            : dirty
                              ? "Cambios sin guardar"
                              : "Guardado"}
                      </span>
                      <button
                        className="primary"
                        disabled={a.busy || !dirty || conflict}
                      >
                        Guardar revisión
                      </button>
                      {definition.scope === "public" && (
                        <button
                          type="button"
                          disabled={
                            dirty ||
                            a.busy ||
                            ["submitted", "approved"].includes(selected.state)
                          }
                          onClick={() => void action("submit")}
                        >
                          Enviar a revisión
                        </button>
                      )}
                    </div>
                  )}
                  <LifecycleActions
                    target={{
                      module: "records",
                      id: selected.id,
                      version: selected.revision,
                      name: selectedTitle,
                    }}
                    disabled={a.busy || dirty}
                    onReload={() => open(selected.id)}
                    onComplete={async (result, capability) => {
                      if (capability.effect === "private-erasure") {
                        setSelected(null);
                        setPayload({});
                        setEditing(false);
                        requestAnimationFrame(() =>
                          document.getElementById("record-list")?.focus(),
                        );
                      } else if (result?.payload) {
                        setSelected(result);
                        setPayload(structuredClone(result.payload));
                      }
                      a.setNotice(
                        `«${selectedTitle}»: ${lifecycleCopy[capability.effect].outcome}`,
                      );
                      await load();
                    }}
                  />
                  {selected.desiredStatus === "archived" && (
                    <p className="alert info">
                      Este registro solicita retirarse del sitio. Publica la
                      retirada y consulta la prueba de despliegue; guardar aquí
                      no confirma que haya dejado de ser visible.
                    </p>
                  )}
                  {writable && definition.scope === "public" && (
                    <details
                      className="panel upload-zone"
                      hidden={editorSection !== "media"}
                    >
                      <summary>
                        <AppIcon name="upload" size={22} /> Subir una imagen
                      </summary>
                      <p className="field-help">
                        Primero indica su procedencia y permiso. Al elegir un
                        archivo comienza la carga; después podrás seleccionarlo
                        en los campos de imagen.
                      </p>
                      <p>
                        PNG, JPEG o WebP. Se verifican dimensiones y se elimina
                        la metadata privada.
                      </p>
                      <label>
                        Procedencia de la imagen
                        <input
                          value={uploadSource}
                          onChange={(e) => setUploadSource(e.target.value)}
                        />
                      </label>
                      <label>
                        Base de permiso para publicar
                        <input
                          value={uploadPermission}
                          onChange={(e) => setUploadPermission(e.target.value)}
                        />
                      </label>
                      <label>
                        Archivo de imagen
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          disabled={
                            a.busy ||
                            !uploadSource.trim() ||
                            !uploadPermission.trim()
                          }
                          onChange={(e) => {
                            void upload(e.target.files?.[0]);
                            e.target.value = "";
                          }}
                        />
                      </label>
                      {uploadStatus && (
                        <p className="upload-status" role="status">
                          {uploadStatus}
                        </p>
                      )}
                    </details>
                  )}
                  {["info", "content", "relationships"].map((pane) => (
                    <div
                      key={pane}
                      data-editor-pane={pane}
                      hidden={editorSection !== pane}
                    >
                      <div className="section-intro">
                        <h2>
                          {pane === "info"
                            ? "Información principal"
                            : pane === "content"
                              ? "Contenido editorial"
                              : "Personas y enlaces"}
                        </h2>
                        <p>
                          {pane === "info"
                            ? "Empieza con lo que las personas necesitan saber."
                            : pane === "content"
                              ? "Cuenta la misma historia en español e inglés."
                              : "Conecta este registro con su contexto y sus referencias."}
                        </p>
                      </div>
                      <Fields
                        key={`${selected.id}-${pane}`}
                        definition={{
                          ...definition,
                          fields: definition.fields
                            .filter(
                              (f) =>
                                fieldSection(f.key, f.kind, f.target) === pane,
                            )
                            .sort(
                              (a, b) =>
                                fieldPriority(a.key) - fieldPriority(b.key),
                            ),
                        }}
                        payload={payload}
                        onChange={(next) => {
                          setPayload(next);
                          const error = a.error as ApiError;
                          if (error?.status === 422) {
                            const remaining = (error.fieldErrors ?? []).filter(
                              (e) =>
                                JSON.stringify(
                                  getValue(payload, fieldPath(e.path)),
                                ) ===
                                JSON.stringify(
                                  getValue(next, fieldPath(e.path)),
                                ),
                            );
                            a.setError(
                              remaining.length
                                ? new ApiError(
                                    error.status,
                                    error.code,
                                    error.message,
                                    remaining,
                                  )
                                : null,
                            );
                          }
                        }}
                        disabled={!writable || conflict}
                        media={media}
                        errors={(a.error as ApiError)?.fieldErrors}
                      />
                    </div>
                  ))}
                  <div
                    data-editor-pane="media"
                    hidden={editorSection !== "media"}
                  >
                    <div className="section-intro">
                      <h2>Medios del registro</h2>
                      <p>
                        Elige imágenes verificadas, organiza su orden y describe
                        lo que muestran en ambos idiomas.
                      </p>
                    </div>{" "}
                    <Fields
                      key={`${selected.id}-media`}
                      definition={{
                        ...definition,
                        fields: definition.fields.filter(isMediaField),
                      }}
                      payload={payload}
                      onChange={(next) => {
                        setPayload(next);
                        const error = a.error as ApiError;
                        if (error?.status === 422) {
                          const remaining = (error.fieldErrors ?? []).filter(
                            (e) =>
                              JSON.stringify(
                                getValue(payload, fieldPath(e.path)),
                              ) ===
                              JSON.stringify(getValue(next, fieldPath(e.path))),
                          );
                          a.setError(
                            remaining.length
                              ? new ApiError(
                                  error.status,
                                  error.code,
                                  error.message,
                                  remaining,
                                )
                              : null,
                          );
                        }
                      }}
                      disabled={!writable || conflict}
                      media={media}
                      errors={(a.error as ApiError)?.fieldErrors}
                    />
                  </div>{" "}
                </form>
                {definition.scope === "public" && (
                  <section
                    className="review-box review-workspace"
                    hidden={editorSection !== "review"}
                  >
                    <h3>
                      <AppIcon name="review" size={22} /> Revisión y publicación
                    </h3>
                    <p>
                      Revisa los campos y permisos públicos antes de enviar esta
                      versión directamente a main. El commit y su despliegue se
                      comprueban por separado.
                    </p>
                    <div className="toolbar">
                      <button
                        disabled={dirty || a.busy}
                        onClick={() => void action("preview")}
                      >
                        Generar vista previa del sitio
                      </button>
                      {selected.state === "approved" && (
                        <button
                          onClick={() =>
                            void a.run(async () =>
                              downloadFile(
                                await request(`/records/${selected.id}/export`),
                                `${selected.id}.json`,
                              ),
                            )
                          }
                        >
                          Descargar JSON público
                        </button>
                      )}
                    </div>
                    {has("content:publish") && (
                      <RecordPublication
                        key={`${selected.id}:${selected.revision}`}
                        user={user}
                        recordId={selected.id}
                        recordType={selected.type}
                        revision={selected.revision}
                        blocked={dirty || saving || a.busy}
                        onReconciled={async () => {
                          const fresh = await request<RecordDTO>(
                            `/records/${selected.id}`,
                          );
                          const current = selectedPublicationRef.current;
                          if (
                            current?.id !== fresh.id ||
                            fresh.revision < current.revision
                          )
                            return;
                          setSelected(fresh);
                          if (!dirtyPublicationRef.current)
                            setPayload(structuredClone(fresh.payload));
                        }}
                      />
                    )}
                    {preview && (
                      <a href={preview} target="_blank" rel="noreferrer">
                        Abrir vista previa privada ↗
                      </a>
                    )}
                    {has("content:review") &&
                      selected.state === "submitted" && (
                        <>
                          <label>
                            Comentario de revisión
                            <textarea
                              value={comment}
                              onChange={(e) => setComment(e.target.value)}
                            />
                          </label>
                          <button
                            disabled={a.busy}
                            onClick={() =>
                              void action("review", {
                                decision: "approved",
                                revisionHash: selected.revisionHash,
                                comment,
                              })
                            }
                          >
                            Aprobar revisión {selected.revision}
                          </button>
                          <button
                            disabled={a.busy}
                            onClick={() =>
                              void action("review", {
                                decision: "changes_requested",
                                revisionHash: selected.revisionHash,
                                comment,
                              })
                            }
                          >
                            Solicitar cambios
                          </button>
                        </>
                      )}
                  </section>
                )}
                {definition.type === "speaker-profiles" && writable && (
                  <section
                    className="panel"
                    hidden={editorSection !== "review"}
                  >
                    <h3>Crear perfil público para revisión</h3>
                    <p>
                      Solo se copian nombre, biografía, foto, temas y enlace
                      autorizados. Correo, teléfono, notas, disponibilidad y
                      condiciones siguen privados.
                    </p>
                    <button
                      disabled={
                        dirty ||
                        a.busy ||
                        !payload.publicConsent ||
                        !payload.consentEvidence
                      }
                      onClick={() =>
                        void a.run(async () => {
                          const result = await request<any>(
                            `/speaker-profiles/${selected.id}/public-projection`,
                            {
                              method: "POST",
                              headers: a.headers(selected.revision),
                              body: "{}",
                            },
                          );
                          a.setNotice(
                            `Perfil público creado como borrador: ${result.id}. Revisa y aprueba desde Ponentes públicos.`,
                          );
                        })
                      }
                    >
                      Crear borrador público autorizado
                    </button>
                  </section>
                )}

                <details
                  className="identity history-workspace"
                  open={editorSection === "history"}
                  hidden={editorSection !== "history"}
                >
                  <summary>
                    <AppIcon name="history" size={20} /> Identidad estable e
                    historial
                  </summary>
                  <p>Este ID permanece aunque cambien el nombre y el orden.</p>
                  <code>{selected.id}</code>
                  <code>{selected.revisionHash}</code>
                  <ol>
                    {events.map((e: any, i) => (
                      <li key={e.id ?? i}>
                        {e.action} ·{" "}
                        {new Date(e.createdAt ?? e.created_at).toLocaleString(
                          "es-PE",
                        )}
                      </li>
                    ))}
                  </ol>
                </details>
              </div>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
function ResultView({ value }: { value: any }) {
  if (value === null || value === undefined) return <span>Sin datos</span>;
  if (Array.isArray(value))
    return value.length ? (
      <ul className="result-list">
        {value.map((v, i) => (
          <li key={i}>
            <ResultView value={v} />
          </li>
        ))}
      </ul>
    ) : (
      <p className="field-help">Sin registros.</p>
    );
  if (typeof value === "object")
    return (
      <dl className="result-grid">
        {Object.entries(value).map(([k, v]) => (
          <div key={k}>
            <dt>
              {(
                {
                  oauthConfigured: "Autenticación con GitHub configurada",
                  liveIntegrationsEnabled:
                    "Publicación en servicios externos habilitada",
                  storage: "Almacenamiento de medios",
                  state: "Estado",
                  files: "Archivos",
                  result: "Resultado",
                  pr_number: "Pull request",
                  head_sha: "Commit del envío",
                  merged_sha: "Commit integrado",
                  deployed_sha: "Commit desplegado",
                  created_at: "Creado",
                  updated_at: "Actualizado",
                  sourceId: "Fuente",
                  lastVerifiedAt: "Última verificación",
                  last_code: "Último resultado",
                  attempts: "Intentos",
                  available_at: "Próximo intento",
                  schedule_at: "Fecha programada",
                  remote_url: "URL confirmada",
                  remote_id: "Identidad del proveedor",
                  destination: "Destino",
                  channel: "Canal",
                  version: "Versión",
                  revision_hash: "Hash de revisión",
                  approved_hash: "Hash aprobado",
                  sourceUrl: "Fuente original",
                  applyUrl: "Enlace de postulación",
                  eligibility: "Elegibilidad",
                  relevanceScore: "Relevancia",
                  reviewReason: "Motivo de revisión",
                } as Record<string, string>
              )[k] ?? k}
            </dt>
            <dd>
              <ResultView value={v} />
            </dd>
          </div>
        ))}
      </dl>
    );
  if (typeof value === "boolean") return <span>{value ? "Sí" : "No"}</span>;
  if (typeof value === "string" && /^https:\/\//.test(value))
    return (
      <a href={value} target="_blank" rel="noreferrer">
        {value} ↗
      </a>
    );
  return <span>{String(value)}</span>;
}
function Overview({
  user,
  onNavigate,
}: {
  user: Actor;
  onNavigate: (s: string) => void;
}) {
  const a = useAction(user);
  const [summary, setSummary] = useState<any>(null),
    [report, setReport] = useState<any>(null),
    [nextEvent, setNextEvent] = useState<any>(null),
    [eventsLoaded, setEventsLoaded] = useState(false),
    [reviews, setReviews] = useState<any[]>([]);
  const [eventSource, setEventSource] = useState("");
  async function load() {
    setEventsLoaded(false);
    const data = await request<any>("/overview");
    setSummary(data);
    const editorial = await request<EditorialStatus>("/editorial/status");
    let events: any[] = [];
    if (editorial.mode === "github") {
      setEventSource(
        editorial.configured
          ? "Eventos: versión de GitHub consultada."
          : "Eventos: GitHub no configurado. No se muestran eventos locales como compartidos.",
      );
      if (editorial.configured)
        try {
          const snapshot =
            await request<EditorialSnapshot>("/editorial/events");
          events = snapshot.records.map((r) => ({
            id: r.id,
            type: "events",
            state: r.status,
            payload: r,
          }));
          if (snapshot.stale)
            setEventSource(
              "Eventos: última versión de GitHub consultada · sin conexión.",
            );
        } catch (error) {
          if (error instanceof ApiError && error.code === "CACHE_EMPTY")
            setEventSource(
              "Eventos: consulta GitHub desde el espacio de Eventos para cargar una versión compartida.",
            );
          else throw error;
        }
    } else {
      setEventSource("Eventos: fuente local de este equipo.");
      events = await loadEventPages<any>((cursor) =>
        request(
          `/records?type=events&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      );
    }
    setNextEvent(nextUpcomingEvent(events));
    setEventsLoaded(true);
    setReviews(
      await Promise.all(
        (data.reviewQueue ?? [])
          .filter(
            (r: any) => editorial.mode !== "github" || r.type !== "events",
          )
          .map(async (r: any) => {
            try {
              return await request(`/records/${r.id}`);
            } catch {
              return r;
            }
          }),
      ),
    );
  }
  useEffect(() => {
    void a.run(load);
  }, []);
  function visit(record: any) {
    sessionStorage.setItem(
      "admin-open-record",
      JSON.stringify({ type: record.type, id: record.id }),
    );
    onNavigate(record.type === "memories" ? "content-memories" : record.type);
  }
  const counts = summary?.counts ?? {};
  const tasks = [
    {
      section: "events",
      icon: "calendar",
      title: "Preparar un encuentro",
      copy: "Fecha, ponentes, sesiones y enlaces.",
    },
    {
      section: "content-memories",
      icon: "image",
      title: "Cuidar los recuerdos",
      copy: "Imágenes y relatos de la comunidad.",
    },
    {
      section: "resources",
      icon: "content",
      title: "Compartir un recurso",
      copy: "Contenido útil, listo en dos idiomas.",
    },
    {
      section: "people",
      icon: "people",
      title: "Conectar a las personas",
      copy: "Contactos, propuestas y seguimiento.",
    },
  ];
  return (
    <div className="overview-workbench">
      <div className="page-heading">
        <div>
          <div className="eyebrow">TU ESPACIO DE COORDINACIÓN</div>
          <h1>Hagamos comunidad.</h1>
          <p>Un encuentro, una conversación y una buena historia a la vez.</p>
        </div>
        <button
          className="quiet"
          onClick={() => void a.run(load)}
          disabled={a.busy}
        >
          <AppIcon name="refresh" size={18} /> Actualizar
        </button>
      </div>
      <ErrorPanel error={a.error} retry={() => void a.run(load)} />
      {a.notice && (
        <p className="alert success" role="status">
          {a.notice}
        </p>
      )}
      <div className="workbench-top">
        <section className="next-encounter">
          <div className="next-encounter-art">
            <AppIcon name="calendar" size={72} />
            <span>EL PRÓXIMO ENCUENTRO</span>
          </div>
          <div className="next-encounter-copy">
            <p className="field-help">{eventSource}</p>
            <span className="eyebrow">
              {!eventsLoaded
                ? "AGENDA DE LA COMUNIDAD"
                : nextEvent
                  ? "EN PREPARACIÓN"
                  : "CONSTRUYAMOS LO QUE SIGUE"}
            </span>
            <h2>
              {!eventsLoaded
                ? a.error
                  ? "No pudimos comprobar la agenda."
                  : "Consultando los próximos encuentros…"
                : nextEvent
                  ? titleOf(nextEvent)
                  : "Tu próximo encuentro empieza aquí."}
            </h2>
            <p>
              {!eventsLoaded
                ? "Actualiza para consultar los eventos guardados. No se ha confirmado que la agenda esté vacía."
                : nextEvent
                  ? `${nextEvent.payload.date} · ${nextEvent.payload.time ?? "Hora por definir"} · ${nextEvent.payload.venue ?? nextEvent.payload.location ?? "Lugar por definir"}`
                  : "Todavía no hay un evento próximo en tus registros. Reúne la idea, las personas y el lugar en un solo espacio."}
            </p>
            <button
              className="primary"
              onClick={() =>
                nextEvent ? visit(nextEvent) : onNavigate("events")
              }
            >
              <AppIcon name={nextEvent ? "arrowRight" : "plus"} size={18} />
              {nextEvent ? "Continuar preparación" : "Preparar un encuentro"}
            </button>
          </div>
        </section>
        <section className="editorial-pulse">
          <div className="section-heading">
            <span className="icon-tile">
              <AppIcon name="review" size={20} />
            </span>
            <h2>Del borrador a la comunidad</h2>
          </div>
          <div className="readiness-row">
            {[
              ["drafts", "Preparación", "content"],
              ["pendingReviews", "Revisión", "review"],
              ["approved", "Aprobación", "check"],
            ].map(([key, label, icon]) => (
              <div key={key}>
                <span>
                  <AppIcon name={icon as any} size={18} />
                  {label}
                </span>
                <strong>{summary ? (counts[key] ?? 0) : "—"}</strong>
              </div>
            ))}
          </div>
          <p>
            {summary
              ? `${counts.records ?? 0} registros guardados en este espacio.`
              : "Cargando el estado de tu comunidad…"}
          </p>
          <button
            className="text-action"
            onClick={() => onNavigate("changesets")}
          >
            Ver publicación del sitio <AppIcon name="arrowRight" size={16} />
          </button>
        </section>
      </div>
      <div className="workbench-middle">
        <section className="panel review-inbox">
          <div className="section-heading">
            <div>
              <span className="eyebrow">SIGUIENTE PASO</span>
              <h2>Listo para otra mirada</h2>
            </div>
            <span className="count-chip">{reviews.length}</span>
          </div>
          {reviews.length ? (
            <ul>
              {reviews.map((r) => (
                <li key={r.id}>
                  <span className="inbox-icon">
                    <AppIcon
                      name={r.type === "events" ? "calendar" : "content"}
                      size={20}
                    />
                  </span>
                  <div>
                    <strong>{titleOf(r)}</strong>
                    <small>
                      {r.type} · Revisión {r.revision}
                    </small>
                  </div>
                  <button
                    aria-label={`Revisar ${titleOf(r)}`}
                    onClick={() => visit(r)}
                  >
                    <AppIcon name="arrowRight" size={20} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon="check"
              title="La revisión está al día"
              description="Los borradores enviados a revisión aparecerán aquí. Cada publicación necesita una segunda mirada."
            />
          )}
        </section>
        <section className="panel workbench-shortcuts">
          <div className="section-heading">
            <h2>¿Qué quieres preparar?</h2>
          </div>
          <div className="task-shortcuts">
            {tasks.map((t) => (
              <button key={t.section} onClick={() => onNavigate(t.section)}>
                <span className={`icon-tile ${t.section}`}>
                  <AppIcon name={t.icon as any} size={22} />
                </span>
                <span>
                  <strong>{t.title}</strong>
                  <small>{t.copy}</small>
                </span>
                <AppIcon name="arrowRight" size={18} />
              </button>
            ))}
          </div>
        </section>
      </div>
      <section className="workspace-health">
        <span>
          <AppIcon name="shield" size={18} /> Tu espacio de trabajo
        </span>
        <span>
          <i className={summary?.operations?.oauthConfigured ? "ready" : ""} />
          {summary?.operations?.oauthConfigured
            ? "GitHub configurado"
            : "Acceso local"}
        </span>
        <span>
          <i
            className={
              summary?.operations?.liveIntegrationsEnabled ? "ready" : ""
            }
          />
          {summary?.operations?.liveIntegrationsEnabled
            ? "Integraciones habilitadas"
            : "Redes sociales sin activar"}
        </span>
        <button
          className="text-action"
          onClick={() => onNavigate("integrations")}
        >
          Gestionar conexiones <AppIcon name="arrowRight" size={16} />
        </button>
      </section>
      {(user.capabilities?.includes("content:write") ||
        user.capabilities?.includes("*")) && (
        <details className="panel site-import-tools">
          <summary>
            <AppIcon name="upload" size={20} /> Importar contenido del sitio
          </summary>
          <h2>Importar el contenido actual del sitio</h2>
          <p>
            Lee el checkout configurado, conserva IDs y revisa las referencias
            antes de importar. Los borradores privados existentes no se
            sobrescriben.
          </p>
          <div className="toolbar">
            <button
              disabled={a.busy}
              onClick={() =>
                void a.run(async () =>
                  setReport(
                    await request("/import/site", {
                      method: "POST",
                      headers: a.headers(),
                      body: JSON.stringify({ dryRun: true }),
                    }),
                  ),
                )
              }
            >
              Revisar importación del sitio
            </button>
            {report && (
              <button
                className="primary"
                disabled={a.busy}
                onClick={() =>
                  void a.run(async () => {
                    setReport(
                      await request("/import/site", {
                        method: "POST",
                        headers: a.headers(),
                        body: JSON.stringify({ dryRun: false }),
                      }),
                    );
                    a.setNotice(
                      "Importación terminada. Revisa los registros y las advertencias.",
                    );
                    setSummary(await request("/overview"));
                  })
                }
              >
                Importar contenido revisado
              </button>
            )}
          </div>
          {report && <ResultView value={report} />}
        </details>
      )}
    </div>
  );
}
function OperationalPage({
  section,
  user,
  onNavigate,
}: {
  section: string;
  user: Actor;
  onNavigate: (section: string) => void;
}) {
  if (section === "changesets") return <Changesets user={user} />;
  if (
    ["calendar", "linkedin", "youtube", "publication-history"].includes(section)
  )
    return <Publishing section={section} user={user} onNavigate={onNavigate} />;
  if (section === "members") return <Members user={user} />;
  if (section === "integrations")
    return <Integrations user={user} onNavigate={onNavigate} />;
  if (section === "audit") return <Audit user={user} />;
  if (section === "operations") return <Operations user={user} />;
  return (
    <JobsWorkspace section={section} user={user} onNavigate={onNavigate} />
  );
}
const actionLabels: Record<string, string> = {
  record_created: "Registro creado",
  record_updated: "Registro actualizado",
  approval_invalidated: "Aprobación invalidada",
  review_submitted: "Revisión solicitada",
  approve: "Revisión aprobada",
  request_changes: "Cambios solicitados",
  public_json_exported: "Contenido público exportado",
  record_deleted: "Registro eliminado",
  contacts_exported: "Contactos exportados",
  record_archived: "Registro archivado",
  media_uploaded: "Imagen verificada",
  login: "Inicio de sesión",
};
function formatMoment(value: unknown) {
  if (!value) return "Sin fecha";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString("es-PE", {
        timeZone: "America/Lima",
        dateStyle: "medium",
        timeStyle: "short",
      });
}
function TechnicalDetails({ value }: { value: any }) {
  return (
    <details className="technical-details">
      <summary>Detalles técnicos</summary>
      <ResultView value={value} />
    </details>
  );
}
function ActivityCards({
  items,
  empty = "Todavía no hay actividad registrada.",
}: {
  items: any[];
  empty?: string;
}) {
  if (!items.length) return <p className="field-help">{empty}</p>;
  return (
    <div className="activity-list">
      {items.map((item, index) => (
        <article key={item.id ?? index} className="activity-row">
          <div className="activity-heading">
            <strong>
              {item.name ??
                item.provider ??
                (item.action
                  ? (actionLabels[item.action] ??
                    item.action.replaceAll("_", " "))
                  : undefined) ??
                item.kind ??
                item.type ??
                "Registro"}
            </strong>
            {(item.state ?? item.health) && (
              <Badge state={item.state ?? item.health} />
            )}
          </div>
          <p>
            {item.destination ??
              item.actor ??
              item.actor_name ??
              item.actorName ??
              item.provider_subject ??
              item.role ??
              ""}
          </p>
          <small>
            {formatMoment(
              item.updated_at ??
                item.updatedAt ??
                item.created_at ??
                item.createdAt ??
                item.expires_at,
            )}
          </small>
          {item.last_error && (
            <p className="field-error">{String(item.last_error)}</p>
          )}
          <TechnicalDetails value={item} />
        </article>
      ))}
    </div>
  );
}
function useDetailHandoff(selected: any, id: string) {
  useEffect(() => {
    if (selected && window.matchMedia("(max-width: 1100px)").matches)
      requestAnimationFrame(() => document.getElementById(id)?.focus());
  }, [selected?.id]);
}
function Operations({ user }: { user: Actor }) {
  const a = useAction(user);
  const [linked, setLinked] = useState<any>(null);
  const [items, setItems] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  async function load(more = false) {
    const r = await request<any>(
      `/operations?limit=25${more && cursor ? `&cursor=${cursor}` : ""}`,
    );
    setItems((old) => (more ? [...old, ...r.items] : r.items));
    setCursor(r.nextCursor);
    const id = takeLifecycleReference("operations");
    if (id) setLinked(await request(`/operations/${encodeURIComponent(id)}`));
  }
  useEffect(() => {
    void a.run(() => load());
  }, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            <AppIcon name="activity" size={28} /> Centro de operaciones
          </h1>
          <p>
            Cola durable, intentos y resultados. Un trabajo en cola no confirma
            una publicación.
          </p>
        </div>
        <button onClick={() => void a.run(() => load())}>Actualizar</button>
      </div>
      <ErrorPanel error={a.error} />
      {linked && (
        <section className="panel" aria-label="Operación relacionada">
          <h2>Operación relacionada</h2>
          <ActivityCards items={[linked]} />
          <LifecycleRetention />
        </section>
      )}
      <section className="panel">
        <ActivityCards items={items} />
        {cursor && (
          <button onClick={() => void a.run(() => load(true))}>
            Cargar más
          </button>
        )}
      </section>
    </>
  );
}
function Audit({ user }: { user: Actor }) {
  const a = useAction(user);
  const [items, setItems] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [q, setQ] = useState("");
  async function load(more = false) {
    const r = await request<any>(
      `/audit?q=${encodeURIComponent(q)}&limit=25${more && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    setItems((old) => (more ? [...old, ...(r.items ?? r)] : (r.items ?? r)));
    setCursor(r.nextCursor ?? null);
  }
  useEffect(() => {
    void a.run(() => load());
  }, [q]);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            <AppIcon name="history" size={28} /> Registro de actividad
          </h1>
          <p>
            Acciones registradas. Los valores privados se mantienen
            restringidos.
          </p>
        </div>
      </div>
      <ErrorPanel error={a.error} />
      <label>
        Buscar en auditoría
        <input value={q} onChange={(e) => setQ(e.target.value)} type="search" />
      </label>
      <section className="panel">
        <ActivityCards items={items} />
        {cursor && (
          <button onClick={() => void a.run(() => load(true))}>
            Cargar más
          </button>
        )}
      </section>
    </>
  );
}
function Members({ user }: { user: Actor }) {
  const a = useAction(user);
  const [items, setItems] = useState<any[]>([]),
    [invitations, setInvitations] = useState<any[]>([]),
    [roles, setRoles] = useState<string[]>([]),
    [subject, setSubject] = useState(""),
    [role, setRole] = useState("viewer"),
    [result, setResult] = useState<any>(null);
  async function load() {
    const [members, invites, catalog] = await Promise.all([
      request<any>("/members"),
      request<any>("/invitations"),
      request<any>("/catalog"),
    ]);
    setItems(members.items ?? members);
    setInvitations(invites.items ?? invites);
    setRoles(
      Array.isArray(catalog.roles)
        ? catalog.roles
        : Object.keys(catalog.roles ?? {}),
    );
  }
  useEffect(() => {
    void a.run(load);
  }, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            <AppIcon name="people" size={28} /> Equipo de coordinación
          </h1>
          <p>
            Acceso por invitación. Una identidad de GitHub no concede permisos
            por sí sola.
          </p>
        </div>
      </div>
      <ErrorPanel error={a.error} />
      {a.notice && (
        <div className="alert success" role="status">
          {a.notice}
        </div>
      )}
      <div className="overview-grid">
        <section className="panel">
          <h2>Miembros</h2>
          {items.length === 0 ? (
            <p>No hay miembros visibles para tu cuenta.</p>
          ) : (
            items.map((m) => (
              <article className="panel member-card" key={m.id}>
                <span className="member-avatar">
                  <AppIcon name="user" size={24} />
                </span>
                <h3>{m.name ?? m.displayName ?? m.providerSubject}</h3>
                <p>
                  {(m.roles?.length ? m.roles : [m.role]).join(", ")} ·{" "}
                  {m.active === false ? "Desactivado" : "Activo"}
                </p>
                <label>
                  Rol asignado
                  <select
                    value={
                      (m.roles?.length ? m.roles : [m.role])[0] ?? "viewer"
                    }
                    onChange={(e) =>
                      void a.run(async () => {
                        if (
                          !confirm(
                            `¿Asignar el rol ${e.target.value} a ${m.name ?? m.id}?`,
                          )
                        )
                          return;
                        await request(`/members/${m.id}`, {
                          method: "PATCH",
                          headers: a.headers(m.version ?? m.revision ?? 1),
                          body: JSON.stringify({
                            roles: [e.target.value],
                            active: m.active !== false,
                          }),
                        });
                        await load();
                        a.setNotice(
                          "Permisos actualizados y registrados en auditoría.",
                        );
                      })
                    }
                  >
                    {roles.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={a.busy}
                  onClick={() =>
                    void a.run(async () => {
                      if (
                        !confirm(
                          "¿Revocar el acceso y las sesiones de este miembro?",
                        )
                      )
                        return;
                      await request(`/members/${m.id}`, {
                        method: "PATCH",
                        headers: a.headers(m.version ?? m.revision ?? 1),
                        body: JSON.stringify({
                          active: false,
                          roles: m.roles?.length ? m.roles : [m.role],
                        }),
                      });
                      await load();
                    })
                  }
                >
                  Revocar acceso
                </button>
              </article>
            ))
          )}
        </section>
        <section className="panel">
          <h2>Invitar a un operador</h2>
          <p>
            Usa el identificador estable del proveedor, no el nombre visible.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                setResult(
                  await request("/invitations", {
                    method: "POST",
                    headers: a.headers(),
                    body: JSON.stringify({
                      providerSubject: subject,
                      roles: [role],
                    }),
                  }),
                );
                await load();
                a.setNotice(
                  "Invitación creada. Revisa la caducidad antes de compartirla.",
                );
              });
            }}
          >
            <label>
              Identidad de GitHub
              <input
                required
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </label>
            <label>
              Rol
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                {roles.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <button className="primary" disabled={a.busy}>
              Crear invitación
            </button>
          </form>
          {result && <ResultView value={result} />}
          <h3>Invitaciones</h3>
          <ActivityCards
            items={invitations}
            empty="No hay invitaciones pendientes."
          />
        </section>
      </div>
    </>
  );
}
function Integrations({
  user,
  onNavigate,
}: {
  user: Actor;
  onNavigate: (section: string) => void;
}) {
  const a = useAction(user);
  const [status, setStatus] = useState<any>(null);
  const [provider, setProvider] = useState("linkedin"),
    [destination, setDestination] = useState("");
  const [connections, setConnections] = useState<any[]>([]);
  const [providers, setProviders] = useState<Record<string, any>>({});
  async function load() {
    setStatus(await request("/operations/status"));
    const configuration = await request<any>("/integrations");
    setConnections(configuration.items);
    setProviders(configuration.providers ?? {});
  }
  useEffect(() => {
    void a.run(load);
  }, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            <AppIcon name="network" size={28} /> Conexiones y servicios
          </h1>
          <p>Conexiones, requisitos pendientes y modos manuales.</p>
        </div>
        <button disabled={a.busy} onClick={() => void a.run(load)}>
          Comprobar estado
        </button>
      </div>
      <ErrorPanel error={a.error} />
      <EditorialConnection />
      <section className="panel">
        <h2>Estado de configuración</h2>
        {status ? (
          <>
            <div className="provider-grid">
              <article>
                <span className="icon-tile">
                  <AppIcon name="folder" size={24} />
                </span>
                <h3>Almacenamiento privado</h3>
                <p>
                  {status.storage?.backend === "local"
                    ? "Local"
                    : (status.storage?.backend ?? "Sin configurar")}
                </p>
                <p className="field-help">
                  Los archivos permanecen privados hasta su publicación
                  revisada.
                </p>
              </article>
              <article>
                <span className="icon-tile">
                  <ProviderLogo provider="github" size={24} />
                </span>
                <h3>Acceso con GitHub OAuth</h3>
                <p>
                  {status.oauth?.configured ? "Configurado" : "Sin configurar"}
                </p>
                <p className="field-help">
                  El acceso local y las conexiones de publicación se configuran
                  por separado.
                </p>
              </article>
            </div>
            <TechnicalDetails value={status} />
          </>
        ) : (
          <p role="status">Comprobando servicios…</p>
        )}
      </section>
      <section className="panel">
        <h2>Conexiones autorizadas</h2>
        <ActivityCards
          items={connections}
          empty="No hay cuentas autorizadas. Configura una conexión o utiliza el paquete manual."
        />
        {connections.map((connection) => (
          <button
            key={connection.id}
            disabled={a.busy}
            onClick={() => {
              if (
                confirm(
                  "¿Desconectar esta cuenta y detener sus envíos pendientes?",
                )
              )
                void a.run(async () => {
                  await request(`/integrations/${connection.id}/disconnect`, {
                    method: "POST",
                    headers: a.headers(),
                    body: "{}",
                  });
                  await load();
                });
            }}
          >
            Desconectar {connection.provider} · {connection.destination}
          </button>
        ))}
        <h2>Configurar una conexión</h2>
        <div
          className="calendar-view"
          role="group"
          aria-label="Proveedor de publicación"
        >
          {["linkedin", "youtube"].map((name) => (
            <button
              key={name}
              aria-pressed={provider === name}
              onClick={() => {
                setProvider(name);
                setDestination("");
              }}
            >
              <ProviderLogo provider={name} size={24} />
              {name === "youtube" ? "YouTube" : "LinkedIn"}
            </button>
          ))}
        </div>
        <p>
          El propietario configura las credenciales en el entorno seguro del
          servidor. Los secretos no se envían al navegador.
        </p>
        <div className="alert info" role="status">
          <strong>
            {providers[provider]?.ready
              ? "Servicio configurado para solicitar autorización"
              : "Todavía no se puede autorizar este servicio"}
          </strong>
          {!providers[provider] ? (
            <p>No se ha podido comprobar la configuración de este proveedor.</p>
          ) : (
            !providers[provider].ready && (
              <>
                <p>
                  El propietario debe completar estos requisitos en el servidor.
                  Ingresar con GitHub no configura esta conexión.
                </p>
                <ul>
                  {(providers[provider].reasons ?? []).map((reason: string) => (
                    <li key={reason}>
                      {(
                        {
                          LIVE_DISABLED:
                            "Los envíos externos están deshabilitados.",
                          CLIENT_ID_MISSING:
                            "Falta el identificador de la aplicación OAuth del proveedor.",
                          CLIENT_SECRET_MISSING:
                            "Falta la credencial privada de la aplicación OAuth del proveedor.",
                          REDIRECT_URI_MISSING:
                            "Falta la dirección de retorno OAuth registrada.",
                          REDIRECT_URI_INVALID:
                            "La dirección de retorno OAuth no es válida para este proveedor.",
                          CONNECTOR_KEY_MISSING:
                            "Falta la clave de cifrado para guardar la conexión de forma privada.",
                          CONNECTOR_KEY_INVALID:
                            "La clave de cifrado configurada no es válida.",
                          API_VERSION_MISSING:
                            "Falta una versión válida de la API de LinkedIn.",
                          API_VERSION_INVALID:
                            "La versión configurada de la API de LinkedIn no es válida.",
                        } as Record<string, string>
                      )[reason] ??
                        "Hay un requisito de configuración pendiente."}
                    </li>
                  ))}
                </ul>
              </>
            )
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (
              !providerCanAuthorize(providers[provider], provider, destination)
            )
              return;
            void a.run(async () => {
              const result = await request<any>(
                `/integrations/${provider}/oauth/start`,
                {
                  method: "POST",
                  headers: a.headers(),
                  body: JSON.stringify({ destination }),
                },
              );
              const url = new URL(result.url);
              if (url.protocol !== "https:")
                throw new ApiError(
                  422,
                  "INVALID_OAUTH_URL",
                  "El proveedor no devolvió una URL segura.",
                );
              location.assign(url.href);
            });
          }}
        >
          <label>
            Proveedor
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setDestination("");
              }}
            >
              <option value="linkedin">LinkedIn</option>
              <option value="youtube">YouTube</option>
            </select>
          </label>
          <label>
            {provider === "linkedin"
              ? "URN de organización de LinkedIn"
              : "ID del canal de YouTube"}
            <input
              required
              aria-invalid={Boolean(
                destination && !validDestination(provider, destination),
              )}
              aria-describedby="provider-destination-help"
              placeholder={
                provider === "linkedin"
                  ? "urn:li:organization:123456"
                  : "UC… (24 caracteres)"
              }
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />
          </label>
          <p id="provider-destination-help" className="field-help">
            {provider === "linkedin"
              ? "Publicación como organización. Una URL de perfil personal de LinkedIn no es válida en esta conexión."
              : "Usa el identificador del canal que administrarás, comenzando por UC; una URL de video o nombre @canal no es un ID de canal."}
          </p>
          <button
            className="primary"
            disabled={
              a.busy ||
              !providerCanAuthorize(
                providers[provider],
                provider,
                destination,
              ) ||
              !(
                user.capabilities?.includes("*") ||
                user.capabilities?.includes("members:manage")
              )
            }
          >
            Iniciar autorización oficial
          </button>
        </form>
        <ul>
          <li>
            Sitio web: publicación directa desde la cuenta GitHub verificada y
            el destino autorizado. Las conexiones sociales se configuran aparte.
          </li>
          <li>
            LinkedIn: organización correcta, OAuth aprobado y autorización para
            publicar.
          </li>
          <li>
            YouTube: canal autorizado, OAuth y almacenamiento de video
            configurado.
          </li>
        </ul>
        <button onClick={() => onNavigate("calendar")}>
          Ir a Publicaciones y preparar un paquete manual
        </button>
        <p>
          Sin acceso al proveedor, prepara un paquete manual desde Publicaciones
          y registra la URL cuando completes el paso en el proveedor.
        </p>
      </section>
    </>
  );
}
function ChangedFiles({ files }: { files: any[] }) {
  return (
    <section className="changed-files">
      <h3>Archivos propuestos</h3>
      <p className="field-help">
        Revisa los campos públicos de cada archivo. Se comparan con la versión
        actual de main antes de guardar el commit. Un conflicto detiene el
        envío.
      </p>
      {files.length ? (
        files.map((file, index) => {
          let value: any;
          try {
            if (file.encoding !== "base64" && file.content !== null)
              value = JSON.parse(file.content);
          } catch {}
          return (
            <details key={file.path ?? index}>
              <summary>
                {file.path} ·{" "}
                {file.content === null
                  ? "Eliminar"
                  : file.baseEntityHash === null
                    ? "Añadir"
                    : "Contenido propuesto"}
              </summary>
              {file.content === null ? (
                <p>Este archivo se retirará en el commit revisado.</p>
              ) : file.encoding === "base64" ? (
                <p>
                  Recurso binario versionado. Revisa su imagen y permisos en el
                  editor del contenido.
                </p>
              ) : value ? (
                <ResultView value={value} />
              ) : (
                <pre>{String(file.content)}</pre>
              )}
              {file.baseEntityHash && (
                <p className="field-help">
                  Hash de la versión base: {file.baseEntityHash}
                </p>
              )}
            </details>
          );
        })
      ) : (
        <p className="field-help">
          No hay archivos disponibles en este resultado.
        </p>
      )}
    </section>
  );
}
function Changesets({ user }: { user: Actor }) {
  const a = useAction(user);
  const intentStorageKey = `admin-publication:${user.id}:content`;
  const recoveredIntent = useRef(pendingPublication(intentStorageKey));
  const submissionKey = useRef<string | null>(
    recoveredIntent.current?.key ?? null,
  );
  const submittedIds = useRef<string[]>(recoveredIntent.current?.ids ?? []);
  const submittedVersions = useRef<Record<string, number>>(
    recoveredIntent.current?.versions ?? {},
  );
  const [uncertainSubmission, setUncertainSubmission] = useState(
    Boolean(recoveredIntent.current && !recoveredIntent.current.changesetId),
  );
  const [readiness, setReadiness] = useState<any>(null);
  const [readinessRefresh, setReadinessRefresh] = useState(0);
  const [items, setItems] = useState<any[]>([]),
    [records, setRecords] = useState<RecordDTO[]>([]),
    [ids, setIds] = useState<string[]>(recoveredIntent.current?.ids ?? []),
    [selected, setSelected] = useState<any>(null),
    [consent, setConsent] = useState(false);
  useDetailHandoff(selected, "changeset-detail");
  async function load() {
    const result = await request<any>("/changesets?limit=25");
    setItems(result.items ?? result);
    const linked = takeLifecycleReference("changesets");
    if (linked)
      setSelected(await request(`/changesets/${encodeURIComponent(linked)}`));
    if (recoveredIntent.current?.changesetId) {
      const previous = recoveredIntent.current;
      recoveredIntent.current = null;
      setSelected(
        await request(
          `/changesets/${encodeURIComponent(previous.changesetId!)}`,
        ),
      );
    }
    const catalog = await request<{ entities: Definition[] }>("/catalog");
    const approved = await Promise.all(
      catalog.entities
        .filter((d) => d.scope === "public")
        .map((d) => request<any>(`/records?type=${d.type}&limit=100`)),
    );
    setRecords(approved.flatMap((r) => r.items));
    setReadinessRefresh((value) => value + 1);
  }
  const readinessTypes = [
    ...new Set(records.filter((r) => ids.includes(r.id)).map((r) => r.type)),
  ]
    .sort()
    .join(",");
  useEffect(() => {
    let active = true;
    setReadiness(null);
    void request(
      `/website/publication/status${readinessTypes ? `?types=${encodeURIComponent(readinessTypes)}` : ""}`,
    )
      .then((value) => {
        if (active) setReadiness(value);
      })
      .catch((error) => {
        if (active) a.setError(error);
      });
    return () => {
      active = false;
    };
  }, [readinessTypes, readinessRefresh]);
  useEffect(() => {
    void a.run(load);
  }, []);
  useEffect(() => {
    if (
      !selected?.id ||
      [
        "deployed",
        "deploy_failed",
        "deployment_failed",
        "conflict",
        "unknown",
        "uncertain",
        "closed",
      ].includes(selected.state)
    )
      return;
    let active = true;
    let attempts = 0;
    const timer = window.setInterval(() => {
      if (document.hidden || attempts++ >= 20) return;
      void request(`/changesets/${selected.id}`)
        .then((value) => {
          if (active) setSelected(value);
        })
        .catch((error) => {
          if (active) a.setError(error);
        });
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected?.id, selected?.state]);
  async function reconcile() {
    if (!selected) return;
    await a.run(async () => {
      await request(`/changesets/${selected.id}/reconcile`, {
        method: "POST",
        headers: a.headers(),
        body: "{}",
      });
      setSelected(await request(`/changesets/${selected.id}`));
      await load();
    });
  }
  async function retryExisting() {
    if (
      !selected?.id ||
      view.state !== "uncertain" ||
      !(selected.result?.canRetryExact || selected.result?.retrySafe)
    )
      return;
    await a.run(async () => {
      await request(`/changesets/${selected.id}/retry`, {
        method: "POST",
        headers: a.headers(),
        body: "{}",
      });
      setSelected(await request(`/changesets/${selected.id}`));
      await load();
    });
  }
  async function publish() {
    await a.run(async () => {
      const displayedVersions = Object.fromEntries(
        ids.map((id) => [id, records.find((r) => r.id === id)?.revision]),
      );
      if (
        !uncertainSubmission &&
        (!submissionKey.current ||
          JSON.stringify(displayedVersions) !==
            JSON.stringify(submittedVersions.current))
      ) {
        if (
          Object.values(displayedVersions).some(
            (v) => !Number.isSafeInteger(v) || !v,
          )
        )
          throw new ApiError(
            409,
            "REVISION_CONFLICT",
            "Vuelve a cargar las revisiones que deseas publicar.",
          );
        submissionKey.current = crypto.randomUUID();
        submittedIds.current = [...ids];
        submittedVersions.current = displayedVersions as Record<string, number>;
      }
      rememberPublication(intentStorageKey, {
        key: submissionKey.current!,
        ids: submittedIds.current,
        versions: submittedVersions.current,
      });
      let operation: any;
      try {
        operation = await request("/changesets", {
          method: "POST",
          headers: {
            ...a.headers(),
            "Idempotency-Key": submissionKey.current!,
          },
          body: JSON.stringify({
            recordIds: submittedIds.current,
            expectedRevisions: submittedVersions.current,
          }),
        });
        setUncertainSubmission(false);
        rememberPublication(intentStorageKey, {
          key: submissionKey.current!,
          ids: submittedIds.current,
          versions: submittedVersions.current,
          operationId: operation.id,
          changesetId:
            operation.subject_id ??
            operation.subjectId ??
            operation.changesetId,
        });
      } catch (error) {
        if (
          error instanceof ApiError &&
          ["OFFLINE", "PUBLICATION_UNCERTAIN", "IDEMPOTENCY_CONFLICT"].includes(
            error.code,
          )
        )
          setUncertainSubmission(true);
        else {
          forgetPublication(intentStorageKey);
          submissionKey.current = null;
        }
        throw error;
      }
      const id =
        operation.subject_id ??
        operation.subjectId ??
        operation.changesetId ??
        operation.id;
      setSelected(await request(`/changesets/${id}`));
      await load();
      setConsent(false);
    });
  }
  const view = publicationView(selected);
  useEffect(() => {
    const cached = pendingPublication(intentStorageKey);
    if (
      cached?.changesetId === selected?.id &&
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
    ) {
      forgetPublication(intentStorageKey);
      setUncertainSubmission(false);
    }
  }, [selected?.id, view.state, intentStorageKey]);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PUBLICACIONES / SITIO WEB</div>
          <h1>
            <AppIcon name="approved" size={28} /> Publicación del sitio
          </h1>
          <p>
            Revisa los cambios y publícalos directamente en main. El commit y el
            despliegue se comprueban por separado.
          </p>
        </div>
        <button onClick={() => void a.run(load)}>Actualizar</button>
      </div>
      <section className="panel" aria-label="Destino de publicación">
        <h2>Destino del sitio</h2>
        {readiness ? (
          <>
            <p>
              {readiness.repository
                ? `${readiness.repository} · ${readiness.branch}`
                : "Sin configurar"}
            </p>
            <p>
              {readiness.ready
                ? "Publicación directa disponible. LinkedIn y YouTube se administran por separado."
                : "Publicación no disponible; tus revisiones siguen guardadas."}
            </p>
            {(readiness.reasons ?? []).map((code: string) => (
              <p className="field-help" key={code}>
                {code === "AUTH_IDENTITY_MISMATCH"
                  ? "Vuelve a verificar tu cuenta de GitHub."
                  : code.includes("WRITES")
                    ? "Los envíos al sitio todavía no están habilitados."
                    : "Comprueba el destino y la configuración de publicación del sitio."}
              </p>
            ))}
          </>
        ) : (
          <p role="status">Consultando disponibilidad del sitio…</p>
        )}
      </section>
      <ErrorPanel error={a.error} retry={() => void a.run(load)} />
      {uncertainSubmission && (
        <div className="alert warning" role="status">
          <p>
            El resultado del envío es incierto. Conservamos tu selección y el
            identificador original; recupera ese mismo envío antes de crear
            otro.
          </p>
          <button disabled={a.busy} onClick={() => void publish()}>
            Recuperar estado del envío
          </button>
        </div>
      )}
      <div
        className="operation-grid domain-changesets"
        data-focused={Boolean(selected)}
      >
        <section id="changeset-detail-list" tabIndex={-1} className="panel">
          <h2>Historial de publicaciones</h2>
          <div className="operation-list">
            {items.map((item) => (
              <button
                key={item.id}
                data-changeset-id={item.id}
                className={selected?.id === item.id ? "selected" : ""}
                aria-current={selected?.id === item.id ? "true" : undefined}
                onClick={() =>
                  void a.run(async () =>
                    setSelected(await request(`/changesets/${item.id}`)),
                  )
                }
              >
                <strong>{item.title ?? "Cambio del sitio"}</strong>
                <span>{publicationView(item).label}</span>
                <small>{formatMoment(item.created_at ?? item.createdAt)}</small>
              </button>
            ))}
            {!items.length && <p>Todavía no hay publicaciones registradas.</p>}
          </div>
        </section>
        <section
          id="changeset-detail"
          tabIndex={-1}
          className="panel detail-panel"
        >
          <button
            className="back-to-records"
            onClick={() => {
              setSelected(null);
              a.setError(null);
              a.setNotice("");
            }}
          >
            <AppIcon name="arrowLeft" size={18} /> Volver a las publicaciones
          </button>
          {selected ? (
            <>
              <h2>Resultado de publicación</h2>
              <PublicationStatus value={selected} />
              <div className="toolbar">
                {view.state === "uncertain" &&
                  (selected.result?.canRetryExact ||
                    selected.result?.retrySafe) && (
                    <button
                      disabled={a.busy}
                      onClick={() => void retryExisting()}
                    >
                      Reintentar el mismo envío
                    </button>
                  )}
                <button disabled={a.busy} onClick={() => void reconcile()}>
                  Comprobar publicación y despliegue
                </button>
              </div>
              <LifecycleActions
                target={{
                  module: "changesets",
                  id: selected.id,
                  version:
                    selected.revisionHash ?? selected.revision_hash ?? "",
                  name: selected.title ?? `Envío ${selected.id.slice(0, 8)}`,
                }}
                disabled={a.busy}
                onReload={async () =>
                  setSelected(
                    await request(
                      `/changesets/${encodeURIComponent(selected.id)}`,
                    ),
                  )
                }
                onComplete={async (_result, capability) => {
                  setSelected(
                    await request(
                      `/changesets/${encodeURIComponent(selected.id)}`,
                    ),
                  );
                  await load();
                  a.setNotice(lifecycleCopy[capability.effect].outcome);
                }}
              />
              <ChangedFiles files={selected.files ?? []} />
              <details>
                <summary>Detalles del envío</summary>
                <TechnicalDetails
                  value={Object.fromEntries(
                    Object.entries(selected).filter(([key]) => key !== "files"),
                  )}
                />
              </details>
              {view.state === "conflict" && (
                <p>
                  Tu selección se conserva abajo. Revisa los registros afectados
                  y prepara una versión nueva después de comparar los cambios.
                </p>
              )}
            </>
          ) : (
            <>
              <h2>Del admin al sitio</h2>
              <p>
                Selecciona un envío para consultar sus archivos, commit y
                despliegue. Las PR anteriores siguen disponibles como historial.
              </p>
            </>
          )}
        </section>
      </div>
      <section className="panel">
        <h2>Revisar y publicar</h2>
        <p>
          Selecciona las revisiones públicas que deben enviarse juntas en un
          único commit.
        </p>
        {records.length ? (
          records.map((r) => (
            <label className="check-field" key={r.id}>
              <input
                type="checkbox"
                checked={ids.includes(r.id)}
                disabled={a.busy || uncertainSubmission}
                onChange={(e) => {
                  setIds(
                    e.target.checked
                      ? [...ids, r.id]
                      : ids.filter((id) => id !== r.id),
                  );
                  setConsent(false);
                  submissionKey.current = null;
                }}
              />
              {titleOf(r)} · revisión {r.revision}
            </label>
          ))
        ) : (
          <p>No hay contenido público disponible para revisar y publicar.</p>
        )}
        <p className="public-boundary publication-boundary">
          Solo se enviarán los campos y archivos públicos revisados. Los
          contactos y otros datos privados permanecen en el admin.
        </p>
        <label className="check-field">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          He revisado el contenido y su visibilidad pública.
        </label>
        <button
          className="primary"
          disabled={
            a.busy ||
            uncertainSubmission ||
            readiness?.ready !== true ||
            !(
              user.capabilities?.includes("*") ||
              user.capabilities?.includes("content:publish")
            ) ||
            !ids.length ||
            !consent ||
            (selected && ["uncertain", "publishing"].includes(view.state))
          }
          onClick={() => void publish()}
        >
          {a.busy ? "Enviando…" : "Publicar cambios en main"}
        </button>
        <p className="field-help">
          Si GitHub cambió los mismos registros, el envío se detiene y tu
          revisión se conserva. No se sobrescriben cambios automáticamente.
        </p>
      </section>
    </>
  );
}

function VideoUpload({
  user,
  onVerified,
  onBusy,
  referencedIds = [],
}: {
  user: Actor;
  referencedIds?: string[];
  onVerified: (asset: any) => void;
  onBusy: (busy: boolean) => void;
}) {
  const a = useAction(user);
  const [percent, setPercent] = useState(0),
    [phase, setPhase] = useState(""),
    [paused, setPaused] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const checkpointKey = useRef<string | null>(null),
    selectedFile = useRef<File | null>(null);
  const [hasCheckpoint, setHasCheckpoint] = useState(false);
  const [retainedUploads, setRetainedUploads] = useState<any[]>([]),
    [uploadNotice, setUploadNotice] = useState("");
  async function refreshUploads() {
    const result: any = await request("/video/uploads");
    setRetainedUploads(result.items ?? []);
  }
  useEffect(() => {
    void refreshUploads().catch((e) => a.setError(e));
  }, [user.id]);

  useEffect(() => () => controller.current?.abort(), []);
  async function upload(file?: File) {
    if (!file) return;
    selectedFile.current = file;
    onBusy(true);
    setPaused(false);
    controller.current = new AbortController();
    const signal = controller.current.signal;
    await a.run(async () => {
      if (
        !["video/mp4", "video/webm"].includes(file.type) ||
        file.size > 5 * 1024 ** 3
      )
        throw new ApiError(
          422,
          "VIDEO_INVALID",
          "Selecciona MP4 o WebM de hasta 5 GB.",
        );
      setPhase("Calculando checksum sin cargar todo el archivo en memoria");
      const sha256 = await hashFile(file, (p) => setPercent(p));
      if (signal.aborted)
        throw new ApiError(
          0,
          "UPLOAD_PAUSED",
          "Transferencia pausada. Selecciona el mismo archivo para reanudar.",
        );
      if (!user.communityId)
        throw new ApiError(
          401,
          "SESSION_CONTEXT",
          "Actualiza la sesión antes de iniciar una transferencia privada.",
        );
      const key = `video-upload:v2:${encodeURIComponent(location.origin)}:${user.communityId}:${user.id}:${sha256}`;
      // Old checkpoints had no operator scope and must never be reused across accounts.
      localStorage.removeItem(`video-upload:${sha256}`);
      checkpointKey.current = key;
      let saved: any;
      try {
        saved = JSON.parse(localStorage.getItem(key) ?? "null");
      } catch {}
      setHasCheckpoint(Boolean(saved));
      if (!saved) {
        const begin = await request<any>("/video/uploads", {
          method: "POST",
          headers: a.headers(),
          signal,
          body: JSON.stringify({ bytes: file.size, mime: file.type, sha256 }),
        });
        saved = { ...begin, sha256, parts: [] };
        localStorage.setItem(key, JSON.stringify(saved));
        setHasCheckpoint(true);
      }
      setPhase("Transfiriendo a almacenamiento privado");
      for (let partNumber = 1; partNumber <= saved.partCount; partNumber++) {
        if (saved.parts.some((p: any) => p.partNumber === partNumber)) continue;
        const descriptor = await request<any>(
          `/video/uploads/${saved.id}/parts`,
          {
            method: "POST",
            headers: a.headers(),
            signal,
            body: JSON.stringify({ partNumber }),
          },
        );
        const local = descriptor.url.startsWith("/api/");
        const response = await fetch(descriptor.url, {
          method: "PUT",
          headers: {
            ...descriptor.headers,
            ...(local ? { "X-CSRF-Token": user.csrfToken } : {}),
          },
          body: file.slice(
            (partNumber - 1) * saved.chunkSize,
            partNumber * saved.chunkSize,
          ),
          signal,
        });
        if (!response.ok)
          throw new ApiError(
            response.status,
            "UPLOAD_FAILED",
            "No se pudo transferir una parte. Selecciona el mismo archivo para reanudar.",
          );
        const part = local
          ? await response.json()
          : {
              partNumber,
              etag: response.headers.get("ETag")?.replaceAll('"', ""),
            };
        if (!part.etag)
          throw new ApiError(
            422,
            "UPLOAD_ETAG",
            "El almacenamiento no devolvió la confirmación de la parte.",
          );
        saved.parts.push(part);
        saved.parts.sort((x: any, y: any) => x.partNumber - y.partNumber);
        localStorage.setItem(key, JSON.stringify(saved));
        setPercent(Math.round((saved.parts.length / saved.partCount) * 100));
      }
      setPhase("Verificando checksum y firma de video");
      const asset = await request<any>(`/video/uploads/${saved.id}/complete`, {
        method: "POST",
        headers: a.headers(),
        signal,
        body: JSON.stringify({ parts: saved.parts }),
      });
      localStorage.removeItem(key);
      checkpointKey.current = null;
      setHasCheckpoint(false);
      setPhase("Video verificado en almacenamiento privado");
      onVerified(asset);
      await refreshUploads();
    });
    onBusy(false);
  }
  return (
    <div>
      <label>
        Archivo de video privado
        <input
          type="file"
          accept="video/mp4,video/webm"
          disabled={a.busy}
          onChange={(e) => void upload(e.target.files?.[0])}
        />
      </label>
      <p className="field-help">
        Para reanudar una transferencia interrumpida, selecciona el mismo
        archivo. No se guardan URLs firmadas en el navegador.
      </p>
      {phase && (
        <p role="status">
          {phase} · {percent}%
        </p>
      )}
      {a.busy && (
        <button
          onClick={() => {
            controller.current?.abort();
            setPaused(true);
          }}
        >
          Pausar transferencia
        </button>
      )}
      {paused && (
        <p>
          Transferencia pausada. Puedes seleccionar el mismo archivo para
          continuar.
        </p>
      )}
      {hasCheckpoint && !a.busy && (
        <div className="toolbar">
          <button
            onClick={() => {
              if (checkpointKey.current)
                localStorage.removeItem(checkpointKey.current);
              checkpointKey.current = null;
              setHasCheckpoint(false);
              setPercent(0);
              a.setError(null);
              if (selectedFile.current) void upload(selectedFile.current);
            }}
          >
            Reiniciar transferencia
          </button>
          <NamedConfirmation
            target={{
              module: "browser-checkpoint",
              id: checkpointKey.current ?? "current-transfer",
              version: checkpointKey.current ?? "current-transfer",
              name: "Punto de reanudación de la transferencia privada",
            }}
            label="Descartar punto de reanudación…"
            title="Descartar"
            description="Se borrará únicamente la información de reanudación de este navegador. No se eliminará el archivo privado ni un video del proveedor."
            confirmLabel="Descartar punto local"
            onConfirm={async () => {
              if (checkpointKey.current)
                localStorage.removeItem(checkpointKey.current);
              checkpointKey.current = null;
              setHasCheckpoint(false);
              setPercent(0);
              setPhase(
                "Punto de reanudación descartado. El archivo almacenado y el proveedor no cambiaron.",
              );
              a.setError(null);
            }}
          />
        </div>
      )}
      <LifecycleRetention kind="upload" />
      <details className="panel">
        <summary>Cargas propias conservadas en almacenamiento privado</summary>
        <button
          type="button"
          disabled={a.busy}
          onClick={() => void refreshUploads().catch((e) => a.setError(e))}
        >
          Actualizar cargas propias
        </button>
        {uploadNotice && <p role="status">{uploadNotice}</p>}
        {!retainedUploads.length && (
          <p>No hay cargas propias disponibles en esta consulta.</p>
        )}
        {retainedUploads.map((asset) => (
          <section key={asset.id} className="lifecycle-action">
            <h4>Video privado · {asset.id}</h4>
            <p>
              {asset.mime} · {asset.bytes} bytes · {asset.state}
            </p>
            <LifecycleActions
              target={{
                module: "video-assets",
                id: asset.id,
                version: asset.version ?? "",
                name: `Video privado ${asset.id}`,
              }}
              disabled={a.busy || referencedIds.includes(asset.id)}
              onReload={refreshUploads}
              onComplete={async (result) => {
                await refreshUploads();
                setUploadNotice(
                  result?.cleanupPending
                    ? "La limpieza sigue pendiente. Se conserva la carga; comprueba el estado y vuelve a confirmar su revisión actual si deseas reintentar."
                    : "Archivo privado retirado del almacenamiento. El historial se conserva; no se eliminó un video del proveedor.",
                );
              }}
            />
          </section>
        ))}
      </details>
      <p className="field-help">
        Si la carga venció, fue rechazada o ya no existe, reiníciala para crear
        una transferencia nueva.
      </p>
      <ErrorPanel error={a.error} />
    </div>
  );
}
function cleanPublicationPayload(payload: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(payload).filter(
      ([, v]) => v !== "" && v !== null && v !== undefined,
    ),
  );
}
function preparePublicationPayload(
  payload: Record<string, any>,
  inventory: any[],
) {
  const ids = [
    ...(payload.media ?? []),
    ...(payload.thumbnailAssetId ? [payload.thumbnailAssetId] : []),
  ];
  return cleanPublicationPayload({
    ...payload,
    mediaHashes: Object.fromEntries(
      ids
        .map((id: string) => [
          id,
          inventory.find((asset) => asset.id === id)?.sha256,
        ])
        .filter(([, hash]) => hash),
    ),
  });
}
function Publishing({
  section,
  user,
  onNavigate,
}: {
  section: string;
  user: Actor;
  onNavigate: (section: string) => void;
}) {
  const a = useAction(user);
  const [composing, setComposing] = useState(false);
  const [handoffDirty, setHandoffDirty] = useState(false);
  const [calendarEvents, setCalendarEvents] = useState<CalendarPublication[]>(
    [],
  );
  const [publicationSource, setPublicationSource] = useState<
    "loading" | "local" | "github"
  >("loading");
  const [calendarSource, setCalendarSource] = useState("");
  const [calendarDrafts, setCalendarDrafts] = useState<CalendarPublication[]>(
    [],
  );
  const [uploading, setUploading] = useState(false);
  const [publicationMedia, setPublicationMedia] = useState<any[]>([]);
  useMediaInventoryUpdates(setPublicationMedia);
  const [items, setItems] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(null),
    [form, setForm] = useState<any>({
      channel:
        section === "youtube"
          ? "youtube"
          : section === "publication-history"
            ? "manual"
            : "linkedin",
      destination: "",
      payload: {
        text: "",
        title: "",
        description: "",
        link: "",
        language: "es",
        media: [],
        desiredVisibility: "private",
        recordingConsent: false,
      },
    }),
    [reason, setReason] = useState(""),
    [schedule, setSchedule] = useState(""),
    [zone, setZone] = useState("America/Lima"),
    [dependency, setDependency] = useState(""),
    [manualUrl, setManualUrl] = useState(""),
    [result, setResult] = useState<any>(null);
  useDetailHandoff(selected, "publication-detail");
  const heading =
    section === "calendar"
      ? "Calendario"
      : section === "youtube"
        ? "YouTube"
        : section === "publication-history"
          ? "Historial de publicaciones"
          : "LinkedIn";
  const dirty = selected
    ? JSON.stringify({
        channel: selected.channel,
        destination: selected.destination,
        payload: selected.payload,
      }) !== JSON.stringify(form) ||
      schedule !== (selected.local_time ?? "") ||
      zone !== (selected.timezone ?? "America/Lima") ||
      dependency !== (selected.dependency_id ?? "")
    : Boolean(
        form.destination ||
        form.payload.text ||
        form.payload.title ||
        form.payload.description ||
        form.payload.link ||
        form.payload.media?.length,
      );
  useDirtyGuard(Boolean(dirty) || uploading || handoffDirty);
  async function load() {
    const publicationRows = await loadEventPages<any>((cursor) =>
      request(
        `/publications?limit=100${["youtube", "linkedin"].includes(section) ? `&channel=${section}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    );
    setItems(publicationRows);
    const linked = takeLifecycleReference("publications");
    if (linked)
      choose(await request(`/publications/${encodeURIComponent(linked)}`));
    setPublicationMedia(await request("/media"));
    const editorial = await request<EditorialStatus>("/editorial/status");
    setPublicationSource(editorial.mode);
    if (section === "calendar") {
      const status = editorial;
      if (status.mode === "github") {
        setCalendarSource(
          status.configured
            ? "Eventos: versión de GitHub consultada. Los borradores locales se muestran por separado en Eventos."
            : "Eventos: GitHub no configurado. No se sustituyen por registros locales.",
        );
        if (status.configured) {
          const local = await request<{ items: EditorialDraft[] }>(
            "/editorial/drafts",
          );
          setCalendarDrafts(
            local.items.map((d) => ({
              id: d.id,
              recordId: d.recordId,
              kind: "event",
              channel: "event",
              state: d.state,
              source: editorialStateLabel(d.state),
              payload: {
                title:
                  d.payload.title?.["es-pe"] ||
                  d.payload.slug ||
                  "Evento sin título",
              },
              schedule_at: safeEventInstant(d.payload),
            })),
          );
          try {
            const snapshot =
              await request<EditorialSnapshot>("/editorial/events");
            setCalendarEvents(
              snapshot.records
                .filter((r) => r.status !== "archived")
                .map((r) => ({
                  id: r.id,
                  kind: "event",
                  source: snapshot.stale
                    ? "GitHub · versión sin conexión"
                    : "Versión de GitHub",
                  channel: "event",
                  state: r.status,
                  payload: {
                    title: r.title?.["es-pe"] || r.title?.en || r.slug,
                  },
                  schedule_at: r.startsAt,
                })),
            );
          } catch (error) {
            if (error instanceof ApiError && error.code === "CACHE_EMPTY") {
              setCalendarEvents([]);
              setCalendarSource(
                "Eventos: aún no se ha consultado GitHub. Abre Eventos para consultar la fuente compartida.",
              );
            } else throw error;
          }
        }
      } else {
        const events = await loadEventPages<RecordDTO>(async (cursor) =>
          request(
            `/records?type=events&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          ),
        );
        setCalendarSource(
          "Eventos: fuente local de este equipo. Publicaciones: registros editoriales guardados.",
        );
        setCalendarEvents(
          events
            .filter((r) => r.state !== "archived")
            .map((r) => ({
              id: r.id,
              kind: "event",
              source: "Evento local",
              channel: "event",
              state: r.state,
              payload: {
                title:
                  r.payload?.title?.["es-pe"] || r.payload?.title?.en || r.id,
              },
              schedule_at: safeEventInstant(r.payload),
            })),
        );
      }
    }
  }
  useEffect(() => {
    void a.run(load);
  }, [section]);
  function safeEventInstant(payload: Record<string, any>) {
    try {
      return payload.date && payload.time
        ? localTimeToInstant(
            `${payload.date}T${payload.time}`,
            payload.timeZone ?? "America/Lima",
          )
        : null;
    } catch {
      return null;
    }
  }
  function choose(r: any) {
    if (
      (dirty || handoffDirty) &&
      !confirm("Hay cambios sin guardar. ¿Descartarlos?")
    )
      return;
    setSelected(r);
    setComposing(true);
    setForm({
      channel: r.channel,
      destination: r.destination,
      payload: structuredClone(r.payload),
    });
    setResult(null);
    setManualUrl(r.remote_url ?? r.remoteUrl ?? "");
    setSchedule(r.local_time ?? "");
    setZone(r.timezone ?? "America/Lima");
    setDependency(r.dependency_id ?? "");
  }
  function update(key: string, value: any) {
    setForm({ ...form, payload: { ...form.payload, [key]: value } });
  }
  async function save() {
    await a.run(async () => {
      const record = await request<any>(
        selected ? `/publications/${selected.id}` : "/publications",
        {
          method: selected ? "PATCH" : "POST",
          headers: a.headers(selected?.revision ?? selected?.version),
          body: JSON.stringify(
            selected
              ? {
                  version: selected.version,
                  payload: preparePublicationPayload(
                    form.payload,
                    publicationMedia,
                  ),
                  destination: form.destination,
                  scheduledAt: schedule
                    ? localTimeToInstant(schedule, zone)
                    : null,
                  timezone: zone,
                  localTime: schedule,
                  dependencyId: dependency || null,
                }
              : {
                  ...form,
                  payload: preparePublicationPayload(
                    form.payload,
                    publicationMedia,
                  ),
                },
          ),
        },
      );
      setSelected(record);
      setForm({
        channel: record.channel,
        destination: record.destination,
        payload: structuredClone(record.payload),
      });
      setSchedule(record.local_time ?? "");
      setZone(record.timezone ?? "America/Lima");
      setDependency(record.dependency_id ?? "");
      await load();
      a.setNotice(
        "Borrador guardado. Cualquier aprobación anterior queda invalidada.",
      );
    });
  }
  async function act(action: string, body: any = {}) {
    if (!selected) return;
    await a.run(async () => {
      const r = await request<any>(`/publications/${selected.id}/${action}`, {
        method: "POST",
        headers: a.headers(selected.revision ?? selected.version),
        body: JSON.stringify(body),
      });
      setResult(r);
      const current = await request<any>(`/publications/${selected.id}`);
      choose(current);
      setResult(r);
      await load();
      a.setNotice(
        "Acción registrada. Revisa el resultado y el estado confirmado.",
      );
    });
  }
  const payload = form.payload;
  const capability = (cap: string) =>
    user.capabilities?.includes(cap) || user.capabilities?.includes("*");
  const mayDraft =
    capability("content:write") || capability("publishing:write");
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PUBLICACIONES / EDITORIAL</div>
          <h1>
            <AppIcon
              name={
                section === "calendar"
                  ? "calendar"
                  : section === "youtube"
                    ? "youtube"
                    : section === "linkedin"
                      ? "linkedin"
                      : "publish"
              }
              size={28}
            />
            {heading}
          </h1>
          <p>
            Prepara, revisa y programa. Los resultados se confirman con el
            proveedor.
          </p>
        </div>
        <button
          className="primary"
          onClick={() => {
            if (
              (dirty || handoffDirty) &&
              !confirm("¿Descartar cambios locales?")
            )
              return;
            setSelected(null);
            setComposing(true);
            setForm({
              channel:
                section === "youtube"
                  ? "youtube"
                  : section === "publication-history"
                    ? "manual"
                    : "linkedin",
              destination: "",
              payload: {
                text: "",
                title: "",
                description: "",
                link: "",
                language: "es",
                media: [],
                desiredVisibility: "private",
                recordingConsent: false,
              },
            });
          }}
        >
          <AppIcon name="plus" size={18} /> Nueva publicación
        </button>
      </div>
      <ErrorPanel error={a.error} />
      {a.notice && (
        <div className="alert success" role="status">
          {a.notice}
        </div>
      )}
      <div className="alert info" hidden={composing || section === "calendar"}>
        Sin credenciales y permisos aprobados, usa el paquete manual. Exportar
        un paquete no publica contenido. La vista del post es aproximada.
      </div>
      {section === "calendar" && !composing && (
        <>
          <p className="field-help">{calendarSource}</p>
          <PublicationCalendar
            items={[...items, ...calendarEvents]}
            localDrafts={calendarDrafts}
            loading={a.busy}
            onChoose={(record) => {
              if (record.kind === "event") {
                sessionStorage.setItem(
                  "admin-open-record",
                  JSON.stringify({
                    type: "events",
                    id: record.recordId ?? record.id,
                  }),
                );
                onNavigate("events");
              } else choose(record);
            }}
          />
        </>
      )}
      {(section !== "calendar" || composing) && (
        <div
          className="operation-grid publishing-workspace"
          hidden={section === "calendar" && !composing}
          data-composing={composing}
        >
          <aside id="publication-list" tabIndex={-1} className="panel">
            <h2>Borradores y resultados</h2>
            <div className="operation-list">
              {items.map((r) => (
                <button
                  key={r.id}
                  className={selected?.id === r.id ? "selected" : ""}
                  aria-current={selected?.id === r.id ? "true" : undefined}
                  onClick={() => choose(r)}
                >
                  <span className="publication-channel">
                    <ProviderLogo provider={r.channel} size={22} />
                    {r.channel}
                  </span>
                  <strong>
                    {r.payload?.title ||
                      r.payload?.text?.slice(0, 90) ||
                      "Publicación sin título"}
                  </strong>
                  <Badge state={r.state} />
                  <small>
                    {r.channel} · {r.destination}
                  </small>
                </button>
              ))}
            </div>
            {!items.length && <p>No hay publicaciones en este canal.</p>}
          </aside>
          {composing && (
            <section
              id="publication-detail"
              tabIndex={-1}
              className="panel detail-panel"
            >
              <button
                className="back-to-records"
                onClick={() => setComposing(false)}
              >
                <AppIcon name="arrowLeft" size={18} /> Volver al gestor
                editorial
              </button>
              <h2>
                {selected ? "Editar publicación" : "Preparar una publicación"}
              </h2>
              {selected && (
                <>
                  <Badge state={selected.state} />
                  <p className="field-help">
                    Revisión {selected.revision ?? selected.version} ·{" "}
                    {dirty ? "Cambios sin guardar" : "Guardado"}
                  </p>
                </>
              )}
              <div className="composer-grid">
                <div className="composer-fields">
                  {" "}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void save();
                    }}
                  >
                    <fieldset disabled={a.busy || !mayDraft}>
                      {form.channel === "youtube" ? (
                        <>
                          <label>
                            Título del video
                            <input
                              value={payload.title ?? ""}
                              onChange={(e) => update("title", e.target.value)}
                            />
                          </label>
                          <label>
                            Descripción de YouTube
                            <textarea
                              rows={6}
                              value={payload.description ?? ""}
                              onChange={(e) =>
                                update("description", e.target.value)
                              }
                            />
                          </label>
                          <ReferenceField
                            field={{
                              key: "thumbnailAssetId",
                              label: "Miniatura preparada",
                              kind: "reference",
                              target: "media",
                            }}
                            value={payload.thumbnailAssetId}
                            onChange={(value) =>
                              update("thumbnailAssetId", value ?? undefined)
                            }
                            media={publicationMedia}
                          />
                          <label>
                            Playlist de YouTube
                            <input
                              value={payload.playlistId ?? ""}
                              onChange={(e) =>
                                update("playlistId", e.target.value)
                              }
                              placeholder="Identificador de playlist"
                            />
                          </label>
                          <label>
                            Visibilidad solicitada
                            <select
                              value={payload.desiredVisibility ?? "private"}
                              onChange={(e) =>
                                update("desiredVisibility", e.target.value)
                              }
                            >
                              <option value="private">Privado</option>
                              <option value="unlisted">No listado</option>
                              <option value="public">Público</option>
                            </select>
                          </label>
                          <label className="check-field">
                            <input
                              type="checkbox"
                              checked={payload.recordingConsent ?? false}
                              onChange={(e) =>
                                update("recordingConsent", e.target.checked)
                              }
                            />
                            Permiso de grabación registrado
                          </label>
                          <label>
                            Video existente (URL)
                            <input
                              type="url"
                              value={payload.existingVideoUrl ?? ""}
                              onChange={(e) =>
                                update("existingVideoUrl", e.target.value)
                              }
                            />
                          </label>
                        </>
                      ) : (
                        <>
                          <label>
                            Texto de la publicación
                            <textarea
                              rows={8}
                              value={payload.text ?? ""}
                              onChange={(e) => update("text", e.target.value)}
                            />
                          </label>
                          <label>
                            Enlace
                            <input
                              type="url"
                              value={payload.link ?? ""}
                              onChange={(e) => update("link", e.target.value)}
                            />
                          </label>
                          <details className="picker-browser">
                            <summary>
                              <AppIcon name="image" size={18} /> Seleccionar
                              imágenes visualmente
                            </summary>
                            <MediaLibrary
                              media={publicationMedia}
                              referencedIds={payload.media ?? []}
                              label="Imágenes de la publicación"
                              onSelect={(id) =>
                                update(
                                  "media",
                                  payload.media?.includes(id)
                                    ? payload.media.filter(
                                        (x: string) => x !== id,
                                      )
                                    : [...(payload.media ?? []), id],
                                )
                              }
                            />
                          </details>
                          <label>
                            Imágenes preparadas
                            <select
                              multiple
                              value={payload.media ?? []}
                              onChange={(e) =>
                                update(
                                  "media",
                                  Array.from(
                                    e.target.selectedOptions,
                                    (o) => o.value,
                                  ),
                                )
                              }
                            >
                              {publicationMedia.map((image) => (
                                <option key={image.id} value={image.id}>
                                  {image.label} · {image.width} × {image.height}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="publication-images">
                            {(payload.media ?? []).map((id: string) => (
                              <img
                                key={id}
                                className="media-thumb"
                                src={`/api/media/${id}`}
                                alt={
                                  payload.altText ??
                                  "Imagen preparada para publicación"
                                }
                              />
                            ))}
                          </div>
                          <label>
                            Texto alternativo de imagen
                            <input
                              value={payload.altText ?? ""}
                              onChange={(e) =>
                                update("altText", e.target.value)
                              }
                            />
                          </label>
                        </>
                      )}
                      <section className="publication-metadata">
                        <h3>Destino y contexto</h3>
                        <div className="form-grid">
                          <label>
                            Canal
                            <select
                              disabled={Boolean(selected)}
                              value={form.channel}
                              onChange={(e) =>
                                setForm({ ...form, channel: e.target.value })
                              }
                            >
                              <option value="linkedin">LinkedIn</option>
                              <option value="youtube">YouTube</option>
                              <option value="manual">Paquete manual</option>
                            </select>
                          </label>
                          <label>
                            Cuenta de destino
                            <input
                              required
                              value={form.destination}
                              onChange={(e) =>
                                setForm({
                                  ...form,
                                  destination: e.target.value,
                                })
                              }
                              placeholder="Identidad de organización o canal"
                            />
                          </label>
                          <label>
                            Idioma
                            <select
                              value={payload.language ?? "es"}
                              onChange={(e) =>
                                update("language", e.target.value)
                              }
                            >
                              <option value="es">Español</option>
                              <option value="en">English</option>
                            </select>
                          </label>
                        </div>
                        {publicationSource === "local" ? (
                          <ReferenceField
                            field={{
                              key: "eventId",
                              label: "Evento relacionado",
                              kind: "reference",
                              target: "events",
                            }}
                            value={payload.eventId}
                            onChange={(value) =>
                              update("eventId", value ?? undefined)
                            }
                            media={publicationMedia}
                          />
                        ) : (
                          <p className="field-help">
                            {publicationSource === "loading"
                              ? "Consultando la fuente de eventos…"
                              : "La vinculación automática a eventos compartidos no está habilitada. Puedes incluir el enlace público del evento en la publicación."}
                          </p>
                        )}
                        {(capability("contacts:read") || payload.sessionId) && (
                          <ReferenceField
                            field={{
                              key: "sessionId",
                              label: "Sesión relacionada",
                              kind: "reference",
                              target: "sessions",
                            }}
                            value={payload.sessionId}
                            onChange={(value) =>
                              update("sessionId", value ?? undefined)
                            }
                            media={publicationMedia}
                          />
                        )}
                      </section>
                      <button className="primary" disabled={a.busy}>
                        Guardar borrador
                      </button>
                    </fieldset>
                  </form>
                </div>{" "}
                <section className="panel live-post-preview">
                  <h3>Vista previa editorial</h3>
                  <p className="field-help">
                    Aproximación del contenido. El proveedor decide la
                    presentación final.
                  </p>
                  <strong>{payload.title}</strong>
                  <p className="publication-copy">
                    {payload.text ||
                      payload.description ||
                      "El texto aparecerá aquí."}
                  </p>
                  {payload.link && (
                    <a href={payload.link} target="_blank" rel="noreferrer">
                      {payload.link}
                    </a>
                  )}
                </section>
              </div>
              {selected && (
                <>
                  <section className="review-box">
                    <h3>Aprobación de la revisión</h3>
                    <p>
                      La aprobación vincula el contenido, los medios, el canal y
                      la cuenta de destino. Cambiarlos exige otra revisión.
                    </p>
                    <label>
                      Comentario de revisión
                      <textarea
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </label>
                    <div className="toolbar">
                      {capability("content:review") && (
                        <button
                          disabled={dirty || a.busy}
                          onClick={() =>
                            void act("approve", {
                              revisionHash:
                                selected.revisionHash ?? selected.revision_hash,
                              comment: reason,
                            })
                          }
                        >
                          Aprobar publicación
                        </button>
                      )}
                    </div>
                  </section>
                  <section className="panel">
                    <h3>Programación</h3>
                    <label>
                      Fecha y hora local
                      <input
                        type="datetime-local"
                        value={schedule}
                        onChange={(e) => setSchedule(e.target.value)}
                      />
                    </label>
                    <label>
                      Zona IANA
                      <input
                        value={zone}
                        onChange={(e) => setZone(e.target.value)}
                      />
                    </label>
                    <label>
                      Changeset del sitio requerido (opcional)
                      <input
                        value={dependency}
                        onChange={(e) => setDependency(e.target.value)}
                      />
                    </label>
                    <p className="field-help">
                      Guarda la fecha, zona y dependencia antes de solicitar
                      aprobación. Cambiarlas exige otra revisión. El servidor
                      verifica permisos y despliegue antes del envío.
                    </p>
                    <div className="toolbar">
                      <button
                        disabled={dirty || a.busy || !schedule}
                        onClick={() => {
                          try {
                            void act("schedule", {
                              revisionHash:
                                selected.revisionHash ?? selected.revision_hash,
                              scheduledAt: localTimeToInstant(schedule, zone),
                              timezone: zone,
                              localTime: schedule,
                              dependencyId: dependency || undefined,
                            });
                          } catch (error) {
                            a.setError(error);
                          }
                        }}
                      >
                        Programar publicación aprobada
                      </button>
                      <LifecycleActions
                        target={{
                          module: "publications",
                          id: selected.id,
                          version: selected.version ?? "",
                          revisionHash:
                            selected.revisionHash ?? selected.revision_hash,
                          name:
                            selected.payload?.title ||
                            selected.payload?.text?.slice(0, 80) ||
                            `Publicación ${selected.id.slice(0, 8)}`,
                        }}
                        disabled={dirty || a.busy || uploading}
                        onReload={async () =>
                          choose(
                            await request(
                              `/publications/${encodeURIComponent(selected.id)}`,
                            ),
                          )
                        }
                        onComplete={async (_result, capability) => {
                          const fresh = await request(
                            `/publications/${encodeURIComponent(selected.id)}`,
                          );
                          setSelected(fresh);
                          await load();
                          a.setNotice(lifecycleCopy[capability.effect].outcome);
                        }}
                      />
                    </div>
                  </section>
                  {form.channel === "youtube" && (
                    <section className="panel">
                      <h3>Video y transferencia</h3>
                      <p>
                        La carga al proveedor comienza en privado. Un archivo
                        subido no confirma que el video sea público.
                      </p>
                      <VideoUpload
                        referencedIds={
                          payload.videoAssetId ? [payload.videoAssetId] : []
                        }
                        user={user}
                        onBusy={setUploading}
                        onVerified={(asset) => {
                          setForm({
                            ...form,
                            payload: {
                              ...form.payload,
                              assetId: asset.id,
                              bytes: asset.bytes,
                              mime: asset.mime,
                              sha256: asset.sha256,
                            },
                          });
                          a.setNotice(
                            "Video verificado en almacenamiento privado. Guarda la nueva revisión antes de solicitar aprobación.",
                          );
                        }}
                      />
                      <button
                        disabled={a.busy || uploading}
                        onClick={() => void act("reconcile")}
                      >
                        Reconciliar transferencia al proveedor
                      </button>
                      <button
                        disabled={a.busy || dirty || uploading}
                        onClick={() => void act("resume")}
                      >
                        Reanudar envío al proveedor
                      </button>
                      <button
                        disabled={a.busy || dirty || !selected.remote_id}
                        onClick={() =>
                          void act("visibility", {
                            revisionHash: selected.revision_hash,
                            visibility: payload.desiredVisibility ?? "private",
                          })
                        }
                      >
                        Aplicar visibilidad aprobada
                      </button>
                    </section>
                  )}
                  {publicationSource === "local" &&
                    form.channel === "youtube" &&
                    ["published", "manual-published"].includes(
                      selected.state,
                    ) &&
                    payload.eventId &&
                    capability("content:write") && (
                      <section className="panel">
                        <h3>Enlazar grabación en el sitio</h3>
                        <p>
                          La URL confirmada se agrega como un nuevo borrador del
                          evento. Necesita revisión antes de publicarse.
                        </p>
                        <button
                          disabled={a.busy || dirty}
                          onClick={() =>
                            void a.run(async () => {
                              setResult(
                                await request(
                                  `/publications/${selected.id}/recording-link`,
                                  {
                                    method: "POST",
                                    headers: a.headers(),
                                    body: "{}",
                                  },
                                ),
                              );
                              a.setNotice(
                                "Enlace de grabación preparado como borrador del evento. Revísalo y envíalo a aprobación desde Eventos.",
                              );
                            })
                          }
                        >
                          Preparar enlace de grabación para revisión
                        </button>
                      </section>
                    )}
                  <section className="export-box">
                    <h3>Paquete para publicación manual</h3>
                    <p>
                      Descarga el texto, metadata y enlaces. Publica desde la
                      herramienta oficial y registra la URL final.
                    </p>
                    <button
                      disabled={dirty || a.busy}
                      onClick={() =>
                        void a.run(async () =>
                          downloadFile(
                            await request(
                              `/publications/${selected.id}/manual-export`,
                            ),
                            `publication-${selected.id}.json`,
                          ),
                        )
                      }
                    >
                      Descargar paquete manual
                    </button>
                    {(payload.media ?? []).map((id: string, i: number) => (
                      <p key={id}>
                        <a href={`/api/media/${id}?download=1`} download>
                          Descargar imagen preparada {i + 1} ↗
                        </a>
                      </p>
                    ))}
                    <SocialHandoff
                      key={selected.id + ":" + selected.version}
                      publication={selected}
                      actorKey={user.communityId + ":" + user.id}
                      csrfToken={user.csrfToken}
                      disabled={
                        dirty ||
                        a.busy ||
                        uploading ||
                        !(
                          user.capabilities?.includes("*") ||
                          ["publishing:write", "content:write"].every((cap) =>
                            user.capabilities?.includes(cap),
                          )
                        )
                      }
                      onDirty={setHandoffDirty}
                      onIndexed={async (r) => {
                        const current = await request(
                          `/publications/${r.publication.id}`,
                        );
                        setSelected(current);
                        setForm({
                          channel: r.publication.channel,
                          destination: r.publication.destination,
                          payload: structuredClone(r.publication.payload),
                        });
                        setResult(r);
                        setHandoffDirty(false);
                        void load();
                        a.setNotice(
                          "Confirmación social registrada. Consulta el estado actual del contenido desde Blog.",
                        );
                      }}
                    />
                  </section>
                  <section className="panel">
                    <h3>Resultado y recuperación</h3>
                    <div className="publication-outcome">
                      <Badge state={selected.state} />
                      {selected.remote_url ? (
                        <a
                          href={selected.remote_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Ver publicación confirmada{" "}
                          <AppIcon name="external" size={16} />
                        </a>
                      ) : (
                        <p>No hay una URL de publicación confirmada.</p>
                      )}
                    </div>
                    <TechnicalDetails value={selected} />
                    <button
                      disabled={a.busy}
                      onClick={() => void act("reconcile")}
                    >
                      Reconciliar resultado con el proveedor
                    </button>
                    {result && <ResultView value={result} />}
                  </section>
                </>
              )}
            </section>
          )}
        </div>
      )}
    </>
  );
}
