import React, { useEffect, useState } from "react";
import { request } from "./client";
import type { User } from "../shared/types";
import {
  publicHref,
  jobFailureMessage,
  limaDateTimeInput,
  jobMoment,
  intakeExpiryInstant,
} from "./jobs-ui";
import { AppIcon } from "./icons";
export function JobsIntake({
  user,
  initialCompany = "",
  initialRecord,
  onDirty,
  onCreated,
  onClose,
}: {
  user: User;
  initialCompany?: string;
  initialRecord?: any;
  onDirty: (dirty: boolean) => void;
  onCreated: (result: any) => void;
  onClose: () => void;
}) {
  const initial = initialRecord?.payload ?? {};
  const [url, setUrl] = useState(initial.sourceUrl ?? ""),
    [company, setCompany] = useState(initial.company ?? initialCompany),
    [preview, setPreview] = useState<any>(null),
    [manual, setManual] = useState(Boolean(initialRecord)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [title, setTitle] = useState(initial.title ?? ""),
    [locations, setLocations] = useState((initial.locations ?? []).join(", ")),
    [workplace, setWorkplace] = useState(initial.workplace ?? "unknown"),
    [eligibility, setEligibility] = useState(initial.eligibility ?? "unknown"),
    [eligibilityEvidence, setEligibilityEvidence] = useState(
      initial.intake?.curator?.eligibilityEvidence ?? "",
    ),
    [activeEvidence, setActiveEvidence] = useState(
      initial.intake?.curator?.activeEvidence ?? "",
    ),
    [requisitionId, setRequisitionId] = useState(initial.requisitionId ?? ""),
    [expiresAt, setExpiresAt] = useState(limaDateTimeInput(initial.expiresAt)),
    [summary, setSummary] = useState(
      initial.summary ?? { "es-pe": "", en: "" },
    ),
    [attested, setAttested] = useState(false);
  const [contentLanguage, setContentLanguage] = useState(
    initial.contentLanguage ?? "und",
  );
  const [originalApplyUrl, setOriginalApplyUrl] = useState(
      initial.originalApplyUrl ?? "",
    ),
    [roleFamily, setRoleFamily] = useState(initial.roleFamily ?? "");
  const dirty = Boolean(
    url ||
    title ||
    locations ||
    activeEvidence ||
    summary["es-pe"] ||
    summary.en,
  );
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty]);
  const headers = () => ({
    "X-CSRF-Token": user.csrfToken,
    "Idempotency-Key": crypto.randomUUID(),
  });
  async function check() {
    setBusy(true);
    setError("");
    try {
      const r: any = await request("/jobs/intake/preview", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ url, company: company || undefined }),
      });
      setPreview(r);
      setManual(r.support !== "extracted");
      const d = r.draft ?? {};
      if (!title) setTitle(d.title ?? "");
      if (!company) setCompany(d.company ?? "");
      if (!locations) setLocations((d.locations ?? []).join(", "));
      if (workplace === "unknown") setWorkplace(d.workplace ?? "unknown");
      if (eligibility === "unknown") setEligibility(d.eligibility ?? "unknown");
      if (!eligibilityEvidence)
        setEligibilityEvidence(r.evidence?.eligibilityText ?? "");
      if (!requisitionId) setRequisitionId(d.requisitionId ?? "");
      if (!originalApplyUrl) setOriginalApplyUrl(d.applyUrl ?? "");
      if (
        contentLanguage === "und" &&
        ["en", "es-pe", "und"].includes(d.contentLanguage)
      )
        setContentLanguage(d.contentLanguage);
      if (!expiresAt) setExpiresAt(limaDateTimeInput(d.expiresAt));
      setAttested(false);
    } catch (e: any) {
      setError(e.message);
      setManual(true);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await request(
        initialRecord
          ? `/jobs/intake/${encodeURIComponent(initialRecord.id)}`
          : "/jobs/intake",
        {
          method: initialRecord ? "PUT" : "POST",
          headers: headers(),
          body: JSON.stringify({
            url,
            title,
            company,
            locations: locations
              .split(",")
              .map((s: string) => s.trim())
              .filter(Boolean),
            workplace,
            eligibility,
            eligibilityEvidence,
            activeEvidence,
            summary,
            requisitionId: requisitionId || undefined,
            expiresAt: intakeExpiryInstant(
              expiresAt,
              initial.expiresAt ?? preview?.draft?.expiresAt,
            ),
            previewHash: preview?.previewHash,
            version: initialRecord?.version,
            originalApplyUrl: originalApplyUrl || undefined,
            roleFamily: roleFamily || undefined,
            contentLanguage,
          }),
        },
      );
      onCreated(r);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const ready = preview || manual;
  const closed = preview?.evidence?.active === "closed";
  return (
    <section className="panel jobs-intake" aria-labelledby="intake-heading">
      <div className="section-heading">
        <div>
          <div className="eyebrow">ENLACE ORIGINAL / REVISIÓN EDITORIAL</div>
          <h2 id="intake-heading">Añadir una vacante</h2>
        </div>
        <button type="button" disabled={busy} onClick={onClose}>
          Cancelar
        </button>
      </div>
      <p>
        Comparte la publicación original de la empresa. Se guardará para
        revisión; esta acción no publica en el sitio.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
      >
        <fieldset className="jobs-intake-fields" disabled={busy}>
          <div className="form-grid">
            <label>
              Enlace original de la vacante
              <input
                type="url"
                required
                value={url}
                placeholder="https://empresa.com/empleos/vacante"
                onChange={(e) => {
                  setUrl(e.target.value);
                  setPreview(null);
                  setManual(false);
                  setAttested(false);
                }}
              />
            </label>
            <label>
              Empresa
              <input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              />
            </label>
          </div>
          <button className="primary" disabled={busy || !publicHref(url)}>
            <AppIcon name="scan" size={17} />
            {busy ? "Comprobando…" : "Comprobar vacante"}
          </button>
        </fieldset>
      </form>
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
      {preview && (
        <div className="evidence-summary">
          <strong>
            {preview.support === "extracted"
              ? "Datos encontrados en la publicación"
              : "Completa los datos manualmente"}
          </strong>
          <p>
            {preview.reason
              ? jobFailureMessage(preview.reason)
              : "Contrasta los datos con el enlace original antes de guardar."}
          </p>
          <p>
            Comprobación:{" "}
            {preview.evidence?.checkedAt
              ? jobMoment(preview.evidence.checkedAt)
              : "Sin fecha confirmada"}
            . Estado:{" "}
            {preview.evidence?.active === "observed-open"
              ? "Publicación observada abierta"
              : closed
                ? "Publicación cerrada"
                : "Vigencia sin confirmar"}
            .
          </p>
          {preview.support === "extracted" && (
            <dl className="intake-source-facts">
              <div>
                <dt>Título en la fuente</dt>
                <dd>{preview.draft?.title ?? "Sin confirmar"}</dd>
              </div>
              <div>
                <dt>Empresa en la fuente</dt>
                <dd>{preview.draft?.company ?? "Sin confirmar"}</dd>
              </div>
              <div>
                <dt>Ubicación o países indicados</dt>
                <dd>
                  {preview.evidence?.eligibilityText ||
                    preview.draft?.locations?.join(" · ") ||
                    "Sin confirmar"}
                </dd>
              </div>
            </dl>
          )}
          {publicHref(
            preview.evidence?.resolvedUrl ?? preview.draft?.sourceUrl,
          ) && (
            <p>
              <a
                href={publicHref(
                  preview.evidence?.resolvedUrl ?? preview.draft?.sourceUrl,
                )}
                target="_blank"
                rel="noreferrer"
              >
                Abrir publicación consultada ↗
              </a>
            </p>
          )}
          {(preview.duplicateSuggestions ?? []).length > 0 && (
            <p role="status">
              Hay publicaciones posiblemente duplicadas. Revisa sus referencias
              antes de aprobar; no se reemplazará ninguna.
            </p>
          )}
        </div>
      )}
      {manual && (
        <p className="alert info">
          Esta página no permitió una extracción automática fiable. Conservamos
          el enlace; documenta solo datos que puedas verificar. Una lectura
          bloqueada no confirma una vacante abierta.
        </p>
      )}
      {!ready && publicHref(url) && (
        <button type="button" className="quiet" onClick={() => setManual(true)}>
          Introducir datos verificados manualmente
        </button>
      )}
      {ready && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset className="jobs-intake-fields" disabled={busy}>
            <div className="form-grid">
              <label>
                Título original
                <input
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label>
                Ubicaciones publicadas
                <input
                  value={locations}
                  placeholder="Lima, Perú"
                  onChange={(e) => setLocations(e.target.value)}
                />
                <small>
                  Separa ubicaciones con comas. No supongas acceso desde Perú
                  por decir «remoto».
                </small>
              </label>
              <label>
                Modalidad
                <select
                  aria-label="Modalidad"
                  value={workplace}
                  onChange={(e) => setWorkplace(e.target.value)}
                >
                  <option value="unknown">Sin confirmar</option>
                  <option value="remote">Remota</option>
                  <option value="hybrid">Híbrida</option>
                  <option value="onsite">Presencial</option>
                </select>
              </label>
              <label>
                Disponibilidad para nuestra comunidad
                <select
                  aria-label="Disponibilidad para nuestra comunidad"
                  value={eligibility}
                  onChange={(e) => setEligibility(e.target.value)}
                >
                  <option value="unknown">Sin confirmar</option>
                  <option value="peru">Perú explícito</option>
                  <option value="remote-peru">
                    Remoto desde Perú explícito
                  </option>
                  <option value="remote-latam-confirmed">
                    LATAM confirmado incluyendo Perú
                  </option>
                  <option value="restricted">
                    Restringida / no disponible para Perú
                  </option>
                </select>
              </label>
              <label>
                Enlace de postulación original (opcional)
                <input
                  type="url"
                  value={originalApplyUrl}
                  onChange={(e) => setOriginalApplyUrl(e.target.value)}
                />
              </label>
              <label>
                Tema de la vacante (si está explícito)
                <select
                  aria-label="Tema de la vacante"
                  value={roleFamily}
                  onChange={(e) => setRoleFamily(e.target.value)}
                >
                  <option value="">Detectar por título / sin confirmar</option>
                  <option value="devops">DevOps</option>
                  <option value="platform">Platform Engineering</option>
                  <option value="sre">SRE</option>
                  <option value="fde">Forward Deployed Engineering</option>
                  <option value="infrastructure">
                    Infrastructure Engineering
                  </option>
                </select>
              </label>
              <label>
                Idioma original de la oferta
                <select
                  aria-label="Idioma original de la oferta"
                  value={contentLanguage}
                  onChange={(e) => setContentLanguage(e.target.value)}
                >
                  <option value="und">Sin confirmar</option>
                  <option value="en">Inglés</option>
                  <option value="es-pe">Español</option>
                </select>
                <small>
                  Indica el idioma de la publicación original; no se deduce del
                  título.
                </small>
              </label>
              <label className="wide">
                Evidencia de ubicación y acceso
                <textarea
                  aria-label="Evidencia de ubicación y acceso"
                  value={eligibilityEvidence}
                  minLength={eligibility !== "unknown" ? 10 : undefined}
                  required={eligibility !== "unknown"}
                  onChange={(e) => setEligibilityEvidence(e.target.value)}
                  rows={2}
                  placeholder="Texto de la publicación que confirma el país o los países permitidos"
                />
              </label>
              <label className="wide">
                Evidencia de vigencia
                <textarea
                  required
                  minLength={10}
                  aria-label="Evidencia de vigencia"
                  value={activeEvidence}
                  onChange={(e) => setActiveEvidence(e.target.value)}
                  rows={2}
                  placeholder="Qué verificaste en el enlace original y cuándo. Si es desconocida, indícalo."
                />
              </label>
              <label>
                Referencia / requisición (opcional)
                <input
                  value={requisitionId}
                  onChange={(e) => setRequisitionId(e.target.value)}
                />
              </label>
              <label>
                Cierre indicado (opcional, hora de Lima)
                <input
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </label>
              <label>
                Resumen para compartir · Español
                <textarea
                  required
                  aria-label="Resumen para compartir · Español"
                  value={summary["es-pe"]}
                  onChange={(e) =>
                    setSummary({ ...summary, "es-pe": e.target.value })
                  }
                  rows={3}
                />
              </label>
              <label>
                Resumen para compartir · English
                <textarea
                  required
                  aria-label="Resumen para compartir · English"
                  value={summary.en}
                  onChange={(e) =>
                    setSummary({ ...summary, en: e.target.value })
                  }
                  rows={3}
                />
              </label>
            </div>
            {closed && (
              <p role="alert" className="alert error">
                La fuente indica que la vacante está cerrada. No se añadirá como
                disponible.
              </p>
            )}
            <label className="check-field">
              <input
                type="checkbox"
                checked={attested}
                onChange={(e) => setAttested(e.target.checked)}
              />
              Verifiqué estos datos en la publicación original. Entiendo que
              todavía requieren revisión.
            </label>
            <button
              className="primary"
              disabled={
                busy ||
                closed ||
                !attested ||
                !publicHref(url) ||
                !title.trim() ||
                !company.trim() ||
                activeEvidence.trim().length < 10 ||
                (!["unknown", "restricted"].includes(eligibility) &&
                  eligibilityEvidence.trim().length < 10) ||
                !summary["es-pe"].trim() ||
                !summary.en.trim()
              }
            >
              {busy ? "Guardando…" : "Guardar vacante para revisión"}
            </button>
          </fieldset>
        </form>
      )}
    </section>
  );
}
