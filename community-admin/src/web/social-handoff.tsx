import React, { useEffect, useState } from "react";
import { request } from "./client";
import { socialNetworks } from "../shared/social-source";
type Store = Pick<Storage, "getItem" | "setItem">;
export function socialConfirmationKey(
  store: Store,
  scope: string,
  input: unknown,
) {
  const name = "social-confirm:v1:" + scope,
    hash = JSON.stringify(input);
  try {
    const old = JSON.parse(store.getItem(name) ?? "null");
    if (old?.input === hash && typeof old.key === "string") return old.key;
  } catch {
    /* An unreadable local draft never changes the captured server version. */
  }
  const key = crypto.randomUUID();
  store.setItem(name, JSON.stringify({ input: hash, key }));
  return key;
}
const emptyLocal = () => ({ "es-pe": "", en: "" });
export function SocialHandoff({
  publication,
  actorKey,
  csrfToken,
  disabled,
  onIndexed,
  onDirty,
}: {
  publication: any;
  actorKey: string;
  csrfToken: string;
  disabled: boolean;
  onIndexed: (result: any) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const hash = publication.revision_hash ?? publication.revisionHash,
    scope =
      actorKey + ":" + publication.id + ":" + publication.version + ":" + hash;
  const storageName = "social-blog-draft:v1:" + scope;
  const initial = () => {
    const value = {
      sourceNetwork:
        publication.channel === "manual" ? "other" : publication.channel,
      sourceNetworkLabel: "",
      sourceUrl: publication.remote_url ?? "",
      sourcePublishedAt: "",
      sourceLanguage: "und",
      blog: {
        title: emptyLocal(),
        description: emptyLocal(),
        body: emptyLocal(),
        tags: [] as string[],
      },
      attested: false,
    };
    try {
      return typeof window !== "undefined"
        ? (JSON.parse(localStorage.getItem(storageName) ?? "null") ?? value)
        : value;
    } catch {
      return value;
    }
  };
  const [form, setForm] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const approved = publication.approved_hash === hash && !!hash,
    eligible =
      approved &&
      ["approved", "manual-export", "manual-published"].includes(
        publication.state,
      ) &&
      !publication.socialIndex;
  useEffect(() => {
    const dirty = !!(
      (form.sourceUrl && form.sourceUrl !== publication.remote_url) ||
      form.sourcePublishedAt ||
      Object.values(form.blog.title).some(Boolean) ||
      Object.values(form.blog.description).some(Boolean) ||
      Object.values(form.blog.body).some(Boolean)
    );
    onDirty(dirty && !publication.socialIndex);
    try {
      localStorage.setItem(storageName, JSON.stringify(form));
    } catch {
      /* Server validation remains authoritative when local storage is unavailable. */
    }
  }, [form, storageName, publication.socialIndex]);
  useEffect(() => () => onDirty(false), []);
  const update = (key: string, value: any) =>
    setForm({ ...form, [key]: value });
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const input = {
        ...form,
        version: publication.version,
        revisionHash: hash,
      };
      const key = socialConfirmationKey(
        localStorage,
        actorKey + ":" + publication.id,
        input,
      );
      const result = await request<any>(
        `/publications/${publication.id}/manual-confirm`,
        {
          method: "POST",
          headers: { "Idempotency-Key": key, "X-CSRF-Token": csrfToken },
          body: JSON.stringify(input),
        },
      );
      localStorage.removeItem(storageName);
      onDirty(false);
      await onIndexed(result);
    } catch (e: any) {
      setError(
        e?.message ??
          "No se pudo confirmar. Conserva el texto y reintenta la misma solicitud.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (publication.socialIndex)
    return (
      <section className="panel">
        <h3>Publicación social confirmada</h3>
        <p>Confirmación del operador. No es una verificación remota.</p>
        <p>
          Blog indexado en este equipo. Su publicación en el sitio se consulta
          por separado en Blog.
        </p>
        <a href="?section=blog">Abrir el gestor del blog</a>
      </section>
    );
  return (
    <section
      className="panel"
      aria-label="Publicación social e índice del blog"
    >
      <h3>Publicar y registrar en el blog</h3>
      <p>
        Copiar o abrir LinkedIn no confirma que la publicación exista. Publica
        con tu cuenta y vuelve para registrar su enlace real.
      </p>
      <div className="toolbar">
        <button
          disabled={disabled || busy || !eligible}
          onClick={() =>
            void navigator.clipboard
              .writeText(
                publication.payload.text ??
                  publication.payload.description ??
                  publication.payload.title ??
                  "",
              )
              .then(
                () =>
                  setNotice(
                    "Texto aprobado copiado. Publica desde la herramienta oficial.",
                  ),
                () => setError("No se pudo copiar; usa el paquete manual."),
              )
          }
        >
          Copiar texto aprobado
        </button>
        {publication.channel === "linkedin" && (
          <a
            href="https://www.linkedin.com/feed/"
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!eligible || disabled}
            onClick={(e) => {
              if (!eligible || disabled) e.preventDefault();
            }}
          >
            Abrir LinkedIn ↗
          </a>
        )}
      </div>
      {!approved && (
        <p>
          Guarda y solicita la aprobación de esta revisión antes de confirmar.
        </p>
      )}
      <fieldset disabled={disabled || busy || !eligible}>
        <label>
          Red de origen
          <select
            aria-label="Red de origen"
            value={form.sourceNetwork}
            onChange={(e) => update("sourceNetwork", e.target.value)}
          >
            {socialNetworks
              .filter(
                (n) =>
                  publication.channel === "manual" || n === publication.channel,
              )
              .map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
          </select>
        </label>
        {form.sourceNetwork === "other" && (
          <label>
            Nombre de otra red
            <input
              value={form.sourceNetworkLabel}
              maxLength={120}
              onChange={(e) => update("sourceNetworkLabel", e.target.value)}
            />
          </label>
        )}
        <label>
          URL publicada
          <input
            type="url"
            value={form.sourceUrl}
            onChange={(e) => update("sourceUrl", e.target.value)}
          />
        </label>
        <label>
          Fecha original con zona
          <input
            placeholder="2026-11-18T10:00:00-05:00"
            value={form.sourcePublishedAt}
            onChange={(e) => update("sourcePublishedAt", e.target.value)}
          />
        </label>
        <label>
          Idioma original
          <select
            aria-label="Idioma original"
            value={form.sourceLanguage}
            onChange={(e) => update("sourceLanguage", e.target.value)}
          >
            <option value="und">Sin confirmar</option>
            <option value="es-pe">Español</option>
            <option value="en">English</option>
          </select>
        </label>
        {(
          [
            ["title", "Título del blog", 120],
            ["description", "Resumen del blog", 4000],
            ["body", "Contenido del blog", 20000],
          ] as const
        ).map(([key, label, max]) => (
          <div className="localized-pair" key={key}>
            {(["es-pe", "en"] as const).map((lang) => (
              <label key={lang}>
                {label} ({lang === "es-pe" ? "español" : "inglés"})
                <textarea
                  aria-label={`${label} (${lang === "es-pe" ? "español" : "inglés"})`}
                  value={form.blog[key][lang]}
                  maxLength={max}
                  onChange={(e) =>
                    update("blog", {
                      ...form.blog,
                      [key]: { ...form.blog[key], [lang]: e.target.value },
                    })
                  }
                />
              </label>
            ))}
          </div>
        ))}
        <label>
          Etiquetas del blog
          <input
            defaultValue={form.blog.tags.join(", ")}
            onChange={(e) =>
              update("blog", {
                ...form.blog,
                tags: [
                  ...new Set(
                    e.target.value
                      .split(",")
                      .map((t) => t.trim())
                      .filter(Boolean),
                  ),
                ],
              })
            }
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.attested}
            onChange={(e) => update("attested", e.target.checked)}
          />
          Confirmo que publiqué este contenido y comprobé el enlace y la fecha
          originales.
        </label>
        <button
          className="primary"
          disabled={!form.attested}
          onClick={() => void confirm()}
        >
          Confirmar e indexar borrador de blog
        </button>
      </fieldset>
      <p>
        Los textos de ambos idiomas deben ser revisados. La confirmación crea un
        borrador local; publicar el sitio es un paso separado.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
