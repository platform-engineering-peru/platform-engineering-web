import Ajv from "ajv";
import addFormats from "ajv-formats";
import schema from "../../content/schemas/jobs-v1.schema.json";
export interface PublicJob {
  schemaVersion: 1;
  id: string;
  slug: string;
  status: "active" | "stale" | "closed";
  title: string;
  company: string;
  sourceId: string;
  externalId: string;
  sourceUrl: string;
  applyUrl: string;
  contentLanguage: string;
  workplace: "remote" | "hybrid" | "onsite";
  eligibility: "peru" | "remote-peru" | "remote-latam-confirmed";
  locations: string[];
  seniority: string | null;
  salary: Record<string, unknown> | null;
  summary: Record<"es-pe" | "en", string>;
  tags: string[];
  sourcePublishedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastVerifiedAt: string;
  expiresAt: string | null;
  closureReason: string | null;
  evidenceRunId: string | null;
}
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile<PublicJob>(schema);
/** Only reviewed public-export JSON belongs in canonical content/jobs; private SQL never reaches this adapter. */
export function validatePublicJobs(input: unknown): PublicJob[] {
  if (!Array.isArray(input)) throw new Error("Public jobs must be an array");
  const ids = new Set<string>(),
    slugs = new Set<string>();
  for (const value of input) {
    if (!validate(value))
      throw new Error(`Invalid public job: ${ajv.errorsText(validate.errors)}`);
    if (ids.has(value.id) || slugs.has(value.slug))
      throw new Error("Duplicate public job identity or slug");
    if (
      Object.values(value.summary).some(
        (text) => !text.trim() || /pending|pendiente/i.test(text),
      )
    )
      throw new Error("Public jobs require reviewed bilingual summaries");
    ids.add(value.id);
    slugs.add(value.slug);
  }
  return input as PublicJob[];
}
export function activeOpportunities(
  input: unknown,
  now = new Date(),
): PublicJob[] {
  return validatePublicJobs(input)
    .filter(
      (job) =>
        job.status === "active" &&
        (!job.expiresAt || Date.parse(job.expiresAt) > now.getTime()),
    )
    .sort(
      (a, b) =>
        Date.parse(b.lastVerifiedAt) - Date.parse(a.lastVerifiedAt) ||
        a.id.localeCompare(b.id),
    );
}
