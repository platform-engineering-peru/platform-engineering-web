// Paired pure engine: keep behavior aligned with community-admin/src/server/jobs/engine.ts.
import { collectSmartRecruiters } from "./smartrecruiters.mjs";
import {
  sourceGeography,
  applicantRestrictions,
  jobGeography,
  isClosedGeographicWithdrawal,
} from "./geography.mjs";
import { IntegrationError } from "./security.mjs";
import { isIP } from "node:net";
import { isPublicAddress, secureRequest, jsonBody } from "./http.mjs";
const clean = (s) =>
  String(s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
export function classifyRole(title) {
  const localized = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (
    /\b(?:civil|construccion|instalaciones|ventas|comercial|reclutador|reclutamiento|soporte|technical support|sales|recruit(?:er|ing|ment)?|marketing|account executive|business development|construction|facilities|mechanical)\b/.test(
      localized,
    )
  )
    return null;
  if (/\bingenier[oa]\b/.test(localized)) {
    if (/\binfraestructura\b/.test(localized)) return "infrastructure";
    if (/\bplataformas?\b/.test(localized)) return "platform";
    if (
      /\b(?:confiabilidad|fiabilidad) de (?:sitios|sistemas)\b/.test(localized)
    )
      return "sre";
    if (/\bdespliegue avanzado\b/.test(localized)) return "fde";
  }
  if (/\bdevsecops\b/i.test(title))
    return /\b(?:engineer|engineering|ingenier[oa]|(?:technical )?specialist|especialista)\b/i.test(
      title,
    ) && !/\b(?:sales|recruiter|account executive|support)\b/i.test(title)
      ? "devops"
      : null;

  if (
    /\b(sales|recruit(?:er|ing|ment)?|marketing|account executive|business development|civil|construction|facilities|mechanical)\b/i.test(
      title,
    )
  )
    return null;
  if (/\bdev[ -]?ops\b/i.test(title)) return "devops";
  if (/\b(site reliability|sre)\b/i.test(title)) return "sre";
  if (/\b(forward[ -]deployed(?: software)? engineer|fde)\b/i.test(title))
    return "fde";
  if (
    /\b(?:cloud |it |software )?(?:infrastructure|infra)[ -](?:engineer|engineering)\b/i.test(
      title,
    )
  )
    return "infrastructure";
  if (
    /\bplatform[ -](?:engineer|engineering)/i.test(title) ||
    (/\bdeveloper (?:experience|platform)\b/i.test(title) &&
      /\b(?:engineer|engineering)\b/i.test(title) &&
      !/\b(?:assistant|support|solutions? (?:architect|engineer)|practice leader|positioning)\b/i.test(
        title,
      ))
  )
    return "platform";
  return null;
}
function timestamp(value) {
  if (typeof value === "number")
    return Number.isSafeInteger(value) &&
      value > 0 &&
      value < 8_640_000_000_000_000
      ? new Date(value).toISOString()
      : null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value))
    return null;
  const calendarDate = new Date(value.slice(0, 10) + "T00:00:00Z");
  if (
    !Number.isFinite(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== value.slice(0, 10)
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
// Provider descriptions may contain entity-encoded HTML. Decode only inert text;
// never execute markup or infer work arrangement from generic technology prose.
function providerText(value) {
  return String(value ?? "")
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|[0-9]+);/gi,
      (entity) => {
        const named = {
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
          "&nbsp;": " ",
        };
        if (entity.toLowerCase() in named) return named[entity.toLowerCase()];
        const code =
          entity.startsWith("&#x") || entity.startsWith("&#X")
            ? parseInt(entity.slice(3), 16)
            : parseInt(entity.slice(2), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
      },
    )
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function workplaceFacts(raw, location) {
  const mode = (value) => {
    const modes = [
      /\b(?:hybrid|h[ií]brid[oa])\b/i.test(value) ? "hybrid" : null,
      /\b(?:remote|remot[oa]|remotely)\b/i.test(value) ? "remote" : null,
      /\b(?:on[ -]?site|presencial)\b/i.test(value) ? "onsite" : null,
    ].filter(Boolean);
    return modes.length === 1 ? modes[0] : "unknown";
  };
  const explicit = providerText(raw.workplaceType);
  const commitment = providerText(raw.categories?.commitment);
  if (explicit || /\b(?:remote|hybrid|onsite|on-site)\b/i.test(commitment))
    return {
      workplace: mode(explicit || commitment),
      workplaceEvidence: {
        source: explicit ? "workplaceType" : "commitment",
        text: (explicit || commitment).slice(0, 300),
      },
    };
  for (const field of Array.isArray(raw.metadata) ? raw.metadata : []) {
    if (
      !/^(?:workplace(?: type)?|work (?:mode|model|arrangement)|modalidad(?: de trabajo)?|remote (?:status|type))$/i.test(
        providerText(field?.name),
      )
    )
      continue;
    const evidence = providerText(
      Array.isArray(field.value) ? field.value.join(" / ") : field.value,
    ).slice(0, 300);
    return {
      workplace: mode(evidence),
      workplaceEvidence: { source: "metadata", text: evidence },
    };
  }
  const locationMode = mode(location);
  if (locationMode !== "unknown")
    return {
      workplace: locationMode,
      workplaceEvidence: { source: "location", text: location.slice(0, 300) },
    };
  const description = providerText(
    raw.content ||
      raw.descriptionPlain ||
      raw.description ||
      raw.salaryDescriptionPlain,
  );
  const label = description.match(
    /\b(?:work(?:place)? (?:mode|model|type|arrangement)|modalidad(?: de trabajo)?|location)\s*[:：-]\s*((?:fully |100% )?(?:remote|remoto|remota|hybrid|h[ií]brido|h[ií]brida|on[ -]?site|presencial))\b/i,
  );
  return {
    workplace: label ? mode(label[1]) : "unknown",
    workplaceEvidence: label
      ? { source: "description", text: label[0].slice(0, 300) }
      : null,
  };
}
export function normalizeJob(raw, source, now) {
  const externalId = String(raw.id ?? "");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(externalId))
    throw new IntegrationError("PARSE");
  const locations = [
    ...new Set(
      [
        clean(raw.location?.name ?? raw.categories?.location),
        ...(Array.isArray(raw.categories?.allLocations)
          ? raw.categories.allLocations
              .filter((v) => typeof v === "string")
              .map(clean)
          : []),
      ].filter(Boolean),
    ),
  ].slice(0, 100);
  const title = clean(raw.title ?? raw.text),
    location = locations.join("; "),
    description = clean(
      providerText(
        raw.content ||
          raw.descriptionPlain ||
          raw.description ||
          raw.salaryDescriptionPlain,
      ),
    );
  const workplace = workplaceFacts(raw, location);
  const url = new URL(raw.absolute_url ?? raw.hostedUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/.test(url.hostname) ||
    (!url.hostname.includes(".") && !url.hostname.includes(":")) ||
    (isIP(url.hostname.replace(/[\[\]]/g, "")) &&
      !isPublicAddress(url.hostname.replace(/[\[\]]/g, "")))
  )
    throw new IntegrationError("BLOCKED");
  for (const key of [...url.searchParams.keys()])
    if (/^utm_/.test(key)) url.searchParams.delete(key);
  const apply = new URL(raw.applyUrl || url.href);
  if (
    apply.origin !== url.origin ||
    apply.username ||
    apply.password ||
    apply.hash
  )
    throw new IntegrationError("BLOCKED");
  for (const key of [...apply.searchParams.keys()])
    if (/^utm_/.test(key)) apply.searchParams.delete(key);
  const eligibility = sourceGeography(
    locations,
    workplace.workplace ?? "unknown",
    "",
    applicantRestrictions(description),
  );
  const score =
    (classifyRole(title) ? 4 : 0) +
    (/platform|devops|infrastructure|cloud/i.test(description) ? 2 : 0) +
    Math.min(
      3,
      ["kubernetes", "terraform", "backstage", "gitops"].filter((s) =>
        description.toLowerCase().includes(s),
      ).length,
    );
  if (!title || !source.company) throw new IntegrationError("PARSE");
  const time = now.toISOString();
  return {
    schemaVersion: 1,
    id: `${source.adapter}:${source.id}:${externalId}`,
    slug: `${source.id}-${externalId}`
      .replace(/[^a-zA-Z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase(),
    sourceId: source.id,
    externalId,
    title,
    company: source.company,
    sourceUrl: url.href,
    applyUrl: apply.href,
    contentLanguage: raw.language ?? "en",
    locations,
    ...workplace,
    locationEvidence: { source: "provider", locations },
    geographyEvidence: {
      applicantRestrictions: applicantRestrictions(description),
    },
    eligibility,
    seniority: null,
    salary: null,
    summary: {
      "es-pe": "Resumen editorial pendiente.",
      en: "Editorial summary pending.",
    },
    tags: [],
    status: "candidate",
    approved: false,
    relevanceScore: score,
    roleFamily: classifyRole(title),
    sourceExcerpt: description.slice(0, 300),
    sourceClosed: ["closed", "expired", "archived"].includes(
      String(raw.status ?? "").toLowerCase(),
    ),
    ...((raw.requisition_id ?? raw.requisitionId)
      ? {
          requisitionId: String(raw.requisition_id ?? raw.requisitionId).slice(
            0,
            200,
          ),
          requisitionVerified: true,
        }
      : {}),
    sourcePublishedAt: timestamp(
      raw.datePosted ??
        raw.first_published_at ??
        raw.first_published ??
        raw.created_at ??
        raw.createdAt,
    ),
    firstSeenAt: time,
    lastSeenAt: time,
    lastVerifiedAt: time,
    expiresAt: timestamp(raw.validThrough ?? raw.expiresAt ?? raw.expires_at),
    closureReason: null,
    evidenceRunId: null,
  };
}
export async function collectSource(
  source,
  transport = secureRequest,
  now = new Date(),
) {
  const result = {
    sourceId: source.id,
    adapterVersion: "1",
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    status: "failed",
    pagesFetched: 0,
    recordsFetched: 0,
    records: [],
    observedIds: [],
  };
  if (
    !source.enabled ||
    !source.reviewedAt ||
    !source.reviewReference ||
    !source.permissionBasis ||
    !source.termsUrl
  )
    return { ...result, errorCode: "BLOCKED" };
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(source.boardIdentifier))
    return { ...result, errorCode: "BLOCKED" };
  if (source.adapter === "smartrecruiters") {
    const run = await collectSmartRecruiters(
      { ...source, allowedHosts: source.allowedHosts ?? [] },
      transport,
      { isRelevantTitle: (title) => Boolean(classifyRole(title)) },
    );
    const records = run.records.map((raw) => normalizeJob(raw, source, now));
    const status =
      run.status === "complete" &&
      run.observed.length < (source.expectedMinRecords ?? 0)
        ? "quarantined"
        : run.status;
    return {
      ...result,
      status,
      finishedAt: new Date().toISOString(),
      scope: "board",
      completeSourceSnapshot: status === "complete",
      records,
      observedIds: run.observed
        .map((r) => `${source.adapter}:${source.id}:${r.id}`)
        .sort(),
      observedTitles: run.observed.map((r) => ({
        id: `${source.adapter}:${source.id}:${r.id}`,
        title: r.title,
      })),
      recordsFetched: run.observed.length,
      relevantRecords: records.length,
      pagesFetched: run.requestCount,
      errorCode: status === "quarantined" ? "ANOMALY" : (run.errors[0] ?? null),
    };
  }
  if (!["greenhouse", "lever"].includes(source.adapter))
    return { ...result, errorCode: "UNSUPPORTED_ADAPTER" };
  const host =
    source.adapter === "greenhouse"
      ? "boards-api.greenhouse.io"
      : "api.lever.co";
  if (!source.allowedHosts?.includes(host))
    return { ...result, errorCode: "BLOCKED" };
  const maxPages = Math.min(100, source.pageLimit ?? 100),
    maxRecords = Math.min(2000, source.requestLimit ?? 2000);
  const records = new Map();
  try {
    for (let page = 0; page < maxPages; page++) {
      const url =
        source.adapter === "greenhouse"
          ? `https://${host}/v1/boards/${source.boardIdentifier}/jobs?content=true`
          : `https://${host}/v0/postings/${source.boardIdentifier}?mode=json&limit=100&skip=${page * 100}`;
      let response;
      for (let attempt = 0; ; attempt++) {
        response = await transport(url, {
          hosts: [host],
          timeoutMs: Math.min(15000, (source.timeoutSeconds ?? 15) * 1000),
          maxBytes: 4_000_000,
        });
        if (
          (response.status === 429 || response.status >= 500) &&
          attempt < 3
        ) {
          const retryHeader = response.headers["retry-after"],
            delay = retryHeader
              ? Number.isFinite(Number(retryHeader))
                ? Number(retryHeader) * 1000
                : Date.parse(retryHeader) - Date.now()
              : 250 * 2 ** attempt;
          if (delay > 15000)
            throw new IntegrationError(
              "RATE_LIMIT",
              503,
              false,
              Math.ceil(delay / 1000),
            );
          await new Promise((r) =>
            setTimeout(r, Math.max(0, delay) + Math.random() * 50),
          );
          continue;
        }
        break;
      }
      if (response.status !== 200)
        throw new IntegrationError(
          response.status === 429
            ? "RATE_LIMIT"
            : response.status === 403
              ? "BLOCKED"
              : "FETCH",
        );
      const data = jsonBody(response),
        rows = source.adapter === "greenhouse" ? data.jobs : data;
      if (!Array.isArray(rows)) throw new IntegrationError("PARSE");
      result.pagesFetched++;
      for (const raw of rows) {
        const job = normalizeJob(raw, source, now);
        if (!records.has(job.id) && records.size >= maxRecords)
          throw new IntegrationError("LIMIT");
        records.set(job.id, job);
        if (records.size > maxRecords) throw new IntegrationError("LIMIT");
      }
      if (source.adapter === "greenhouse" || rows.length < 100) {
        result.status = "complete";
        break;
      }
      if (page === maxPages - 1) throw new IntegrationError("LIMIT");
    }
  } catch (e) {
    result.errorCode = e instanceof IntegrationError ? e.code : "PARSE";
    result.status = records.size ? "incomplete" : "failed";
  }
  result.observedIds = [...records.keys()].sort();
  result.observedTitles = [...records.values()].map((j) => ({
    id: j.id,
    title: j.title,
  }));
  result.records = [...records.values()]
    .filter((j) => j.roleFamily)
    .sort((a, b) => a.id.localeCompare(b.id));
  result.recordsFetched = records.size;
  result.relevantRecords = result.records.length;
  result.finishedAt = new Date().toISOString();
  if (
    result.status === "complete" &&
    records.size < (source.expectedMinRecords ?? 0)
  ) {
    result.status = "quarantined";
    result.errorCode = "ANOMALY";
  }
  return result;
}
export function reconcileJobs(previous, result, now = new Date()) {
  const jobs = previous.map((j) => ({ ...j })),
    time = now.toISOString();
  let status = result.status;
  const active = jobs.filter(
      (j) =>
        j.sourceId === result.sourceId &&
        ["active", "stale"].includes(j.status),
    ),
    ids = new Set(result.observedIds ?? result.records.map((j) => j.id));
  if (
    status === "complete" &&
    result.completeSourceSnapshot !== false &&
    active.length &&
    (ids.size === 0 ||
      active.filter((j) => !ids.has(j.id)).length / active.length > 0.3)
  )
    status = "quarantined";
  if (status === "complete") {
    for (const record of result.records) {
      let old = jobs.find((j) => j.id === record.id);
      if (!old) {
        jobs.push({ ...record, evidenceRunId: result.runId ?? null });
        continue;
      }
      if (old.status === "excluded") continue;
      const overrideStillValid =
        !old.editorialEligibility ||
        jobGeography({
          ...record,
          editorialEligibility: old.editorialEligibility,
        }).qualified;
      const editorialEligibility = overrideStillValid
        ? old.editorialEligibility
        : undefined;
      const material =
        !overrideStillValid ||
        [
          "title",
          "company",
          "sourceUrl",
          "applyUrl",
          "workplace",
          "requisitionId",
        ].some((k) => old[k] !== undefined && old[k] !== record[k]) ||
        (!editorialEligibility &&
          old.eligibility !== undefined &&
          old.eligibility !== record.eligibility) ||
        (old.requisitionId ?? null) !== (record.requisitionId ?? null) ||
        (old.approved &&
          !["remote", "hybrid", "onsite", "unknown"].includes(
            record.workplace,
          ));
      const reopened =
        old.status === "closed" &&
        !old.editorialClosure &&
        !record.sourceClosed;
      const state =
        reopened || material
          ? "needs-review"
          : old.approved &&
              ["remote", "hybrid", "onsite", "unknown"].includes(
                record.workplace,
              ) &&
              (editorialEligibility ?? record.eligibility) !== "unknown" &&
              (editorialEligibility ?? record.eligibility) !== "restricted" &&
              record.relevanceScore >= 4
            ? "active"
            : "candidate";
      Object.assign(old, record, {
        firstSeenAt: old.firstSeenAt,
        expiresAt: Object.hasOwn(old, "editorialExpiresAt")
          ? old.editorialExpiresAt
          : (record.expiresAt ?? old.expiresAt ?? null),
        summary: old.summary,
        tags: old.tags,
        approved: reopened || material ? false : old.approved,
        eligibility: editorialEligibility ?? record.eligibility,
        editorialEligibility,
        status: state,
        missingSince: null,
        missingRunId: null,
        evidenceRunId: result.runId ?? null,
      });
    }
    const relevantIds = new Set(result.records.map((r) => r.id));
    if (result.observedIds)
      for (const job of jobs)
        if (
          job.sourceId === result.sourceId &&
          ids.has(job.id) &&
          !relevantIds.has(job.id) &&
          !["excluded", "closed"].includes(job.status)
        ) {
          job.status = "needs-review";
          job.approved = false;
          job.title =
            result.observedTitles?.find((r) => r.id === job.id)?.title ??
            job.title;
          job.roleFamily = null;
          job.relevanceScore = 0;
          job.reviewReason = "source-role-no-longer-matches";
          job.evidenceRunId = result.runId ?? null;
        }
    for (const job of result.completeSourceSnapshot === false ? [] : active)
      if (!ids.has(job.id)) {
        if (
          job.missingSince &&
          job.missingRunId !== (result.runId ?? result.finishedAt ?? time) &&
          now.getTime() - Date.parse(job.missingSince) >= 12 * 3600000
        ) {
          job.status = "closed";
          job.closureReason = "missing-two-complete-snapshots";
        } else {
          job.missingSince ??= time;
          job.missingRunId ??= result.runId ?? result.finishedAt ?? time;
        }
      }
  }
  for (const job of jobs) {
    if (job.editorialClosure && job.status !== "excluded") {
      job.status = "closed";
      job.closureReason = job.editorialWithdrawal
        ? "curator-withdrawn"
        : "curator-confirmed-closed";
    } else if (job.sourceClosed && job.status !== "excluded") {
      job.status = "closed";
      job.closureReason = "source-explicit-closed";
    } else if (
      !["closed", "excluded"].includes(job.status) &&
      job.expiresAt &&
      Date.parse(job.expiresAt) <= now.getTime()
    ) {
      job.status = "closed";
      job.closureReason = "expired";
    } else if (
      job.status === "active" &&
      job.lastVerifiedAt &&
      now.getTime() - Date.parse(job.lastVerifiedAt) >= 72 * 3600000
    )
      job.status = "stale";
  }
  return { status, jobs };
}
export function publicJobs(jobs) {
  const keys = [
    "schemaVersion",
    "id",
    "slug",
    "status",
    "title",
    "company",
    "sourceId",
    "externalId",
    "sourceUrl",
    "applyUrl",
    "contentLanguage",
    "workplace",
    "eligibility",
    "locations",
    "seniority",
    "salary",
    "summary",
    "tags",
    "sourcePublishedAt",
    "firstSeenAt",
    "lastSeenAt",
    "lastVerifiedAt",
    "expiresAt",
    "closureReason",
    "evidenceRunId",
  ];
  return jobs
    .filter(
      (j) =>
        j.approved &&
        ["remote", "hybrid", "onsite", "unknown"].includes(j.workplace) &&
        (jobGeography(j).qualified || isClosedGeographicWithdrawal(j)) &&
        ["active", "stale", "closed"].includes(j.status),
    )
    .map((j) => {
      const withdrawal =
        j.status === "closed" && j.editorialWithdrawal?.publicRecord;
      const record = withdrawal
        ? {
            ...withdrawal,
            status: "closed",
            closureReason: "curator-withdrawn",
            lastVerifiedAt: j.lastVerifiedAt,
          }
        : j;
      return Object.fromEntries(keys.map((k) => [k, record[k] ?? null]));
    });
}
export function duplicateSuggestions(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const key = [job.company, job.title, (job.locations ?? []).join(",")]
      .map((s) => String(s).normalize("NFKC").trim().toLowerCase())
      .join("|");
    const list = groups.get(key) ?? [];
    list.push(job.id);
    groups.set(key, list);
  }
  return [...groups.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => ({ ids, action: "review-only" }));
}
