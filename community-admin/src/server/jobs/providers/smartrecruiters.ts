import {
  secureRequest,
  jsonBody,
  type Transport,
} from "../../integrations/http";

export interface SmartRecruitersSource {
  boardIdentifier: string;
  allowedHosts: string[];
  pageLimit?: number;
  requestLimit?: number;
}
export interface SmartRecruitersResult {
  status: "complete" | "incomplete" | "failed";
  observed: { id: string; title: string }[];
  records: any[];
  totalFound: number | null;
  requestCount: number;
  errors: string[];
}
const API = "api.smartrecruiters.com";
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const bounded = (value: number | undefined, fallback: number, max: number) =>
  value === undefined
    ? fallback
    : Number.isInteger(value) && value > 0 && value <= max
      ? value
      : 0;
function postingUrl(value: unknown, board: string, id: string): string {
  const url = new URL(text(value));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["jobs.smartrecruiters.com", "careers.smartrecruiters.com"].includes(
      url.hostname,
    ) ||
    !url.pathname.startsWith(`/${board}/${id}`) ||
    !new RegExp(`^/${board}/${id}(?:-[^/]*)?/?$`).test(url.pathname) ||
    url.hash
  )
    throw Error("UNSAFE_POSTING_URL");
  return url.href;
}
function plain(value: unknown): string {
  return text(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(?:x0*a0|0*160);|&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function rawRecord(detail: any, listed: any, board: string) {
  if (
    detail?.id !== listed.id ||
    detail.company?.identifier !== board ||
    detail.location?.country?.toLowerCase() !== "pe" ||
    (detail.visibility !== undefined && detail.visibility !== "PUBLIC") ||
    typeof detail.active !== "boolean" ||
    text(detail.name) !== text(listed.name)
  )
    throw Error("DETAIL_IDENTITY");
  const original = postingUrl(detail.postingUrl, board, detail.id);
  const apply = postingUrl(detail.applyUrl, board, detail.id);
  const sections = detail.jobAd?.sections;
  if (!sections || typeof sections !== "object" || Array.isArray(sections))
    throw Error("DETAIL_CONTENT");
  const content = ["jobDescription", "qualifications", "additionalInformation"]
    .map((key) => text(sections[key]?.text))
    .filter(Boolean)
    .join("\n");
  if (!plain(content)) throw Error("DETAIL_CONTENT");
  const facts = new Set<string>();
  if (detail.location.remote === true) facts.add("remote");
  if (detail.location.hybrid === true) facts.add("hybrid");
  // False provider flags are not an explicit on-site declaration. Match only
  // a workplace statement, never references to remote servers or hybrid cloud.
  const statement =
    /\b(?:trabajo|modalidad(?: de trabajo)?|work(?:place)? (?:mode|model|type|arrangement))\s*[:：-]?\s*((?:fully |100% )?(?:remote|remot[oa]|hybrid|h[ií]brid[oa]|on[ -]?site|presencial))\b/gi;
  for (const match of plain(content).matchAll(statement)) {
    facts.add(
      /hybrid|h[ií]brid/i.test(match[1])
        ? "hybrid"
        : /remote|remot[oa]/i.test(match[1])
          ? "remote"
          : "onsite",
    );
  }
  const workplace = facts.size === 1 ? [...facts][0] : "unknown";
  const location =
    text(detail.location.fullLocation) ||
    [detail.location.city, detail.location.region, "Peru"]
      .map(text)
      .filter(Boolean)
      .join(", ");
  return {
    id: detail.id,
    status: detail.active ? "active" : "closed",
    title: text(detail.name),
    location: { name: location },
    absolute_url: original,
    hostedUrl: original,
    applyUrl: apply,
    requisition_id: text(detail.refNumber) || null,
    language: text(detail.language?.code) || null,
    content,
    updated_at: detail.releasedDate ?? null,
    expires_at: detail.unpublishOn ?? listed.unpublishOn ?? null,
    metadata: [{ name: "Workplace type", value: workplace }],
    workplaceEvidence: {
      source: "smartrecruiters",
      remote: detail.location.remote ?? null,
      hybrid: detail.location.hybrid ?? null,
      statements: [...plain(content).matchAll(statement)].map((x) => x[0]),
      conflict: facts.size > 1,
    },
  };
}
/** Public Peru board reader. Incomplete results must never drive missing-job closures. */
export async function collectSmartRecruiters(
  source: SmartRecruitersSource,
  transport: Transport = secureRequest,
  options: { isRelevantTitle: (title: string) => boolean },
): Promise<SmartRecruitersResult> {
  const result: SmartRecruitersResult = {
    status: "failed",
    observed: [],
    records: [],
    totalFound: null,
    requestCount: 0,
    errors: [],
  };
  const board = source.boardIdentifier;
  const pages = bounded(source.pageLimit, 10, 10),
    requests = bounded(source.requestLimit, 110, 110);
  try {
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(board) ||
      !source.allowedHosts.includes(API) ||
      !pages ||
      !requests
    )
      throw Error("SOURCE_POLICY");
    const request = async (url: string) => {
      if (result.requestCount >= requests) throw Error("REQUEST_LIMIT");
      result.requestCount++;
      const response = await transport(url, {
        hosts: [API],
        maxBytes: 4_000_000,
        timeoutMs: 15_000,
      });
      if (response.status !== 200) throw Error(`HTTP_${response.status}`);
      if (response.body.length > 4_000_000) throw Error("RESPONSE_LIMIT");
      return jsonBody(response);
    };
    const relevant: any[] = [];
    const seen = new Set<string>();
    let finished = false;
    for (let page = 0; page < pages; page++) {
      const offset = page * 100;
      const url = new URL(`https://${API}/v1/companies/${board}/postings`);
      url.searchParams.set("country", "pe");
      url.searchParams.set("limit", "100");
      url.searchParams.set("offset", String(offset));
      const body = await request(url.href);
      if (
        !Number.isInteger(body.totalFound) ||
        body.totalFound < 0 ||
        body.totalFound > 1000 ||
        body.offset !== offset ||
        body.limit !== 100 ||
        !Array.isArray(body.content) ||
        body.content.length > 100
      )
        throw Error("LIST_SHAPE_OR_LIMIT");
      if (result.totalFound !== null && result.totalFound !== body.totalFound)
        throw Error("COUNT_CHANGED");
      result.totalFound = body.totalFound;
      for (const row of body.content) {
        if (
          !/^\d{1,30}$/.test(row?.id) ||
          !text(row.name) ||
          row.company?.identifier !== board ||
          row.location?.country?.toLowerCase() !== "pe" ||
          seen.has(row.id)
        )
          throw Error("LIST_IDENTITY_OR_DUPLICATE");
        seen.add(row.id);
        result.observed.push({ id: row.id, title: text(row.name) });
        if (options.isRelevantTitle(text(row.name))) relevant.push(row);
      }
      if (seen.size > body.totalFound) throw Error("COUNT_MISMATCH");
      if (seen.size === body.totalFound) {
        finished = true;
        break;
      }
      if (body.content.length !== 100) throw Error("TRUNCATED_PAGE");
    }
    if (!finished) throw Error("PAGE_LIMIT");
    if (relevant.length > 100) throw Error("DETAIL_LIMIT");
    // Construct every endpoint locally. Never follow response-provided refs or redirects.
    for (const row of relevant) {
      const detail = await request(
        `https://${API}/v1/companies/${board}/postings/${row.id}`,
      );
      const record = rawRecord(detail, row, board);
      if (record) result.records.push(record);
    }
    result.status = "complete";
  } catch (error) {
    result.status = result.observed.length ? "incomplete" : "failed";
    result.errors.push(
      error instanceof Error &&
        /^(?:SOURCE_POLICY|REQUEST_LIMIT|HTTP_\d{3}|RESPONSE_LIMIT|LIST_SHAPE_OR_LIMIT|COUNT_CHANGED|LIST_IDENTITY_OR_DUPLICATE|COUNT_MISMATCH|TRUNCATED_PAGE|PAGE_LIMIT|DETAIL_LIMIT|DETAIL_IDENTITY|DETAIL_CONTENT|UNSAFE_POSTING_URL)$/.test(
          error.message,
        )
        ? error.message
        : "PROVIDER_FAILURE",
    );
  }
  return result;
}
