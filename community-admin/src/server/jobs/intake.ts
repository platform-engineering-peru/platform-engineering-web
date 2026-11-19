import { createHash } from "node:crypto";
import { validateCareersUrl, robotsDenied } from "./discovery";
import { secureRequest, type Transport } from "../integrations/http";
import { sourceGeography, applicantRestrictions } from "./geography";
const text = (value: unknown, max = 500) =>
  String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|amp);/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function canonicalVacancyUrl(input: string) {
  const url = validateCareersUrl(input);
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (
      /^utm_/i.test(key) ||
      key === "gh_src" ||
      (key === "source" && url.searchParams.get(key) === "google_jobs_apply") ||
      (key === "gh_jid" &&
        url.pathname.endsWith("/jobs/" + url.searchParams.get(key)))
    )
      url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}
function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value))
    return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) &&
    d.toISOString().slice(0, 10) === value.slice(0, 10)
    ? d.toISOString()
    : null;
}
function objects(value: any, out: any[], depth = 0) {
  if (depth > 10 || out.length > 1000) return;
  if (Array.isArray(value)) {
    for (const item of value) objects(item, out, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  if ([value["@type"]].flat().includes("JobPosting")) out.push(value);
  if (value["@graph"]) objects(value["@graph"], out, depth + 1);
}
const list = (value: any) =>
  value == null ? [] : Array.isArray(value) ? value : [value];
const country = (value: any) =>
  text(typeof value === "object" ? (value.name ?? value.value) : value, 100);
const isPeru = (value: string) => /^(?:PE|PER|Per[uú])$/i.test(value.trim());
/** Single-detail evidence only: this result never represents a complete source snapshot. */
export function parseVacancyDetail(
  html: string,
  input: string,
  now = new Date(),
): any {
  const url = canonicalVacancyUrl(input),
    found: any[] = [];
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']([^"']+)["'][^>]*>([^]*?)<\/script\s*>/gi,
  )) {
    const type = match[1].replace(/&#(?:x2b|43);/gi, "+");
    if (
      type.toLowerCase() !== "application/ld+json" ||
      match[2].length > 500000
    )
      continue;
    try {
      objects(JSON.parse(match[2]), found);
    } catch {
      /* Malformed structured data cannot establish facts. */
    }
  }
  const base = {
    support: "manual-required",
    reason: found.length > 1 ? "AMBIGUOUS_JOB_DETAIL" : "NO_VERIFIED_JOB_DATA",
    draft: {
      sourceUrl: url,
      applyUrl: url,
      locations: [],
      eligibility: "unknown",
    },
    evidence: {
      checkedAt: now.toISOString(),
      method: "json-ld",
      sha256: hash(html),
      active: "unknown",
      eligibilityText: null,
    },
  };
  if (found.length !== 1) {
    const parsedUrl = new URL(url);
    // EVIDENCED Globant detail layout only. Never parse arbitrary related pages or JS payloads.
    if (
      found.length === 0 &&
      parsedUrl.hostname === "career.globant.com" &&
      /^\/job\/[a-z0-9-]+\/\d+\/?$/i.test(parsedUrl.pathname)
    ) {
      const beforeFaq = html.split(/Find answers to all your questions/i)[0],
        title = text(/<h3\b[^>]*>([^]*?)<\/h3>/i.exec(beforeFaq)?.[1], 400);
      const cleanHtml = beforeFaq
        .replace(/<script\b[^>]*>[^]*?<\/script>/gi, "")
        .replace(/<style\b[^>]*>[^]*?<\/style>/gi, "");
      const content = text(cleanHtml, 15000),
        explicitPeru = /This job can be filled in\s+Per[uú](?:\s|$|[.,])/i.test(
          content,
        ),
        location = [...cleanHtml.matchAll(/<span\b[^>]*>([^]*?)<\/span>/gi)]
          .map((m) => text(m[1], 200))
          .find((v) => /^[A-Za-zÀ-ÿ .'-]{1,60},\s*Peru$/.test(v));
      if (title && /apply/i.test(beforeFaq))
        return {
          support: "extracted",
          draft: {
            sourceUrl: url,
            applyUrl: url,
            title,
            company: "Globant",
            requisitionId: parsedUrl.pathname.split("/").filter(Boolean).at(-1),
            locations: location ? [location.trim()] : [],
            eligibility: explicitPeru ? "peru" : "unknown",
            workplace: /#LI-hybrid/i.test(content) ? "hybrid" : "unknown",
            sourcePublishedAt: null,
            expiresAt: null,
          },
          evidence: {
            ...base.evidence,
            method: "trusted-provider-html",
            active: /no longer accepting applications|job is closed/i.test(
              content,
            )
              ? "closed"
              : "observed-open",
            eligibilityText: explicitPeru
              ? "This job can be filled in Perú"
              : null,
          },
        };
    }
    return base;
  }
  const job = found[0],
    title = text(job.title, 400),
    company = text(job.hiringOrganization?.name, 200);
  if (!title || !company) return base;
  const addresses = list(job.jobLocation)
    .map((p: any) => p?.address)
    .filter(Boolean);
  const locations = addresses
    .map((a: any) =>
      [a.addressLocality, a.addressRegion, country(a.addressCountry)]
        .map((x) => text(x, 200))
        .filter(Boolean)
        .join(", "),
    )
    .filter(Boolean)
    .slice(0, 10);
  const remote =
    String(job.jobLocationType ?? "").toUpperCase() === "TELECOMMUTE";
  const permitted = list(job.applicantLocationRequirements).map((x: any) =>
    country(x),
  );
  const peru = addresses.some((a: any) => isPeru(country(a.addressCountry)));
  let applyUrl = url;
  if (typeof job.url === "string")
    try {
      const next = canonicalVacancyUrl(new URL(job.url, url).href);
      if (new URL(next).origin === new URL(url).origin) applyUrl = next;
    } catch {}
  const expiresAt = date(job.validThrough),
    closed =
      Boolean(expiresAt && Date.parse(expiresAt) <= now.getTime()) ||
      /no longer accepting applications|ya no se aceptan solicitudes|vacante (?:cerrada|finalizada)|job (?:has expired|is closed)/i.test(
        html.replace(/<[^>]*>/g, " "),
      );
  const identifier =
    text(
      typeof job.identifier === "object"
        ? job.identifier?.value
        : job.identifier,
      200,
    ) || null;
  const requisition =
    (/\bRequisition(?:\s+(?:ID|Number))?\s*[:#]\s*([A-Za-z0-9_-]{2,100})/i.exec(
      text(job.description, 20000),
    )?.[1] ??
      (identifier && /^REQ[-_]/i.test(identifier) ? identifier : null)) ||
    null;
  return {
    support: "extracted",
    draft: {
      sourceUrl: url,
      applyUrl,
      title,
      company,
      requisitionId: requisition,
      externalId: identifier,
      locations,
      eligibility: sourceGeography(
        locations,
        remote ? "remote" : "unknown",
        remote ? permitted.join("; ") : "",
        applicantRestrictions(text(job.description, 20000)),
      ),
      workplace: remote ? "remote" : "unknown",
      sourcePublishedAt: date(job.datePosted),
      expiresAt,
    },
    evidence: {
      ...base.evidence,
      applicantRestrictions: applicantRestrictions(
        text(job.description, 20000),
      ),
      active: closed ? "closed" : "observed-open",
      eligibilityText:
        remote && permitted.length
          ? permitted.join(", ")
          : peru
            ? locations.join("; ")
            : null,
    },
  };
}
export async function inspectVacancy(
  input: string,
  transport: Transport = secureRequest,
  now = new Date(),
): Promise<any> {
  const original = canonicalVacancyUrl(input);
  let url = new URL(original);
  const manual = (reason: string, status?: number) => ({
    support: "manual-required",
    reason,
    draft: {
      sourceUrl: original,
      applyUrl: original,
      locations: [],
      eligibility: "unknown",
    },
    evidence: {
      checkedAt: now.toISOString(),
      method: "public-detail",
      status: status ?? null,
      active: "unknown",
      eligibilityText: null,
    },
  });
  try {
    const request = (target: URL, maxBytes: number) =>
      transport(target.href, {
        hosts: [target.hostname],
        maxBytes,
        timeoutMs: 10000,
        headers: { "User-Agent": "CommunityAdminJobs/1.0" },
      });
    const robots = await request(new URL("/robots.txt", url), 128000);
    if (![200, 404].includes(robots.status))
      return manual("ROBOTS_UNAVAILABLE", robots.status);
    if (robots.body.length > 128000) return manual("DETAIL_LIMIT");
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (
        robots.status === 200 &&
        robotsDenied(robots.body.toString(), url.pathname + url.search)
      )
        return manual("ROBOTS_DISALLOWED");
      const response = await request(url, 2_000_000);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = new URL(
          canonicalVacancyUrl(
            new URL(response.headers.location ?? "", url).href,
          ),
        );
        if (next.origin !== url.origin)
          return manual("DETAIL_REDIRECT_BLOCKED", response.status);
        if (redirects === 3) return manual("DETAIL_LIMIT", response.status);
        url = next;
        continue;
      }
      if (response.status !== 200)
        return manual(
          response.status === 429 ? "RATE_LIMIT" : "DETAIL_FETCH_FAILED",
          response.status,
        );
      if (
        response.body.length > 2_000_000 ||
        !/text\/html|application\/xhtml\+xml/i.test(
          response.headers["content-type"] ?? "",
        )
      )
        return manual("UNSUPPORTED_DETAIL_CONTENT", response.status);
      const parsed = parseVacancyDetail(
        response.body.toString(),
        url.href,
        now,
      );
      return {
        ...parsed,
        evidence: {
          ...parsed.evidence,
          status: response.status,
          submittedUrl: original,
          resolvedUrl: url.href,
        },
      };
    }
  } catch (error: any) {
    return manual(error.code ?? "DETAIL_UNAVAILABLE");
  }
  return manual("DETAIL_UNAVAILABLE");
}
/** Employer+verified requisition or original canonical application URL is strong evidence. */
export function strongVacancyDuplicates(
  jobs: any[],
): { ids: string[]; reason: string }[] {
  const groups = new Map<string, Set<string>>();
  for (const j of jobs) {
    const keys: string[] = [];
    try {
      keys.push(
        "url:" +
          canonicalVacancyUrl(j.originalApplyUrl ?? j.applyUrl ?? j.sourceUrl),
      );
    } catch {}
    if (
      j.requisitionId &&
      j.company &&
      (j.requisitionVerified || j.intake?.curator?.requisitionId)
    )
      keys.push(
        "req:" +
          text(j.verifiedEmployerName ?? j.company)
            .normalize("NFKC")
            .toLowerCase() +
          ":" +
          text(j.requisitionId).toLowerCase(),
      );
    for (const key of keys) {
      const group = groups.get(key) ?? new Set();
      group.add(j.id);
      groups.set(key, group);
    }
  }
  const unique = new Map<string, { ids: string[]; reason: string }>();
  for (const [key, group] of groups)
    if (group.size > 1) {
      const ids = [...group].sort();
      unique.set(ids.join("|"), {
        ids,
        reason: key.startsWith("req:")
          ? "shared-requisition"
          : "same-original-url",
      });
    }
  return [...unique.values()];
}
