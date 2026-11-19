import { randomBytes } from "node:crypto";
import { z } from "zod";
import type pg from "pg";
import type { Session } from "../context";
import { auditEvent, capabilitiesFor } from "../context";
import { transaction } from "../db";
import {
  hashValue,
  deterministicId,
  IntegrationError,
} from "../integrations/security";
import type { Transport } from "../integrations/http";
import { jobGeography } from "./geography";
import { classifyRole } from "./engine";
import {
  canonicalVacancyUrl,
  inspectVacancy,
  strongVacancyDuplicates,
} from "./intake";
export const intakeInput = z
  .object({
    url: z.string().max(2000),
    title: z.string().trim().min(1).max(400),
    company: z.string().trim().min(1).max(200),
    contentLanguage: z.enum(["es-pe", "en", "und"]).optional(),
    locations: z.array(z.string().trim().min(1).max(200)).max(10),
    workplace: z.enum(["unknown", "remote", "hybrid", "onsite"]),
    eligibility: z.enum([
      "unknown",
      "peru",
      "remote-peru",
      "remote-latam-confirmed",
      "restricted",
    ]),
    eligibilityEvidence: z.string().trim().max(2000),
    activeEvidence: z.string().trim().min(10).max(2000),
    roleFamily: z
      .enum(["devops", "platform", "sre", "fde", "infrastructure"])
      .optional(),
    summary: z
      .object({
        "es-pe": z.string().trim().max(4000),
        en: z.string().trim().max(4000),
      })
      .strict(),
    requisitionId: z.string().trim().min(1).max(200).optional(),
    originalApplyUrl: z.string().max(2000).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    previewHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    version: z.number().int().positive().optional(),
  })
  .strict();
export class VacancyIntakeService {
  private previews = new Map<
    string,
    { actor: string; community: string; expires: number; value: any }
  >();
  constructor(
    private pool: pg.Pool,
    private transport?: Transport,
    private clock = () => new Date(),
  ) {}
  private async rows(
    community: string,
    db: pg.Pool | pg.PoolClient = this.pool,
  ) {
    return (
      await db.query(
        "SELECT * FROM job_records WHERE community_id=$1 ORDER BY id LIMIT 10000",
        [community],
      )
    ).rows;
  }
  async preview(user: Session, url: string) {
    const value = await inspectVacancy(url, this.transport, this.clock());
    const token = randomBytes(32).toString("hex"),
      expires = this.clock().getTime() + 15 * 60 * 1000;
    for (const [key, p] of this.previews)
      if (p.expires < this.clock().getTime()) this.previews.delete(key);
    if (this.previews.size >= 500)
      this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(token, {
      actor: user.id,
      community: user.communityId,
      expires,
      value,
    });
    const rows = await this.rows(user.communityId);
    return {
      ...value,
      previewHash: token,
      previewExpiresAt: new Date(expires).toISOString(),
      duplicateSuggestions: strongVacancyDuplicates([
        ...rows.map((r) => r.payload),
        {
          ...value.draft,
          id: "preview",
          originalApplyUrl: value.draft.applyUrl,
        },
      ]).filter((g) => g.ids.includes("preview")),
    };
  }
  async save(user: Session, raw: unknown, key: string, id?: string) {
    const input = intakeInput.parse(raw),
      url = canonicalVacancyUrl(input.url);
    if (!key || key.length > 160)
      throw new IntegrationError("IDEMPOTENCY_KEY_REQUIRED", 428);
    if (
      !["unknown", "restricted"].includes(input.eligibility) &&
      input.eligibilityEvidence.length < 10
    )
      throw new IntegrationError("ELIGIBILITY_EVIDENCE_REQUIRED");
    const original = input.originalApplyUrl
      ? canonicalVacancyUrl(input.originalApplyUrl)
      : null;
    const preview = input.previewHash
      ? this.previews.get(input.previewHash)
      : null;
    const sourceId = "original-detail",
      externalId = hashValue(url).slice(0, 40),
      recordId = id ?? `manual:${sourceId}:${externalId}`;
    const requestHash = hashValue({ user: user.id, id: recordId, input }),
      requestKey = "vacancy-intake:" + key;
    return transaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "vacancy-intake:" + user.communityId,
      ]);
      const actor = (
        await db.query(
          "SELECT active,role,roles FROM users WHERE id=$1 AND community_id=$2",
          [user.id, user.communityId],
        )
      ).rows[0];
      const capabilities = actor
        ? capabilitiesFor(actor.roles?.length ? actor.roles : [actor.role])
        : [];
      if (
        !actor?.active ||
        (!capabilities.includes("*") && !capabilities.includes("jobs:curate"))
      )
        throw new IntegrationError("ACTOR_REVOKED", 403);
      const previous = (
        await db.query(
          "SELECT request_hash,response FROM integration_requests WHERE community_id=$1 AND key=$2",
          [user.communityId, requestKey],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash)
          throw new IntegrationError("IDEMPOTENCY_CONFLICT", 409);
        return previous.response;
      }
      if (
        input.previewHash &&
        (!preview ||
          preview.actor !== user.id ||
          preview.community !== user.communityId ||
          preview.expires < this.clock().getTime() ||
          canonicalVacancyUrl(
            preview.value.evidence.submittedUrl ??
              preview.value.draft.sourceUrl,
          ) !== url)
      )
        throw new IntegrationError("PREVIEW_EXPIRED", 409);
      const rows = await this.rows(user.communityId, db),
        old = rows.find((r) => r.id === recordId);
      if (id && (!old || old.payload.intake?.kind !== "single-detail"))
        throw new IntegrationError("NOT_FOUND", 404);
      if (id && old.version !== input.version)
        throw new IntegrationError("REVISION_CONFLICT", 409);
      if (id && canonicalVacancyUrl(old.payload.sourceUrl) !== url)
        throw new IntegrationError("SOURCE_IDENTITY_IMMUTABLE", 409);
      const same = rows.find((r) => {
        try {
          return (
            r.id !== id &&
            canonicalVacancyUrl(
              r.payload.originalApplyUrl ?? r.payload.sourceUrl,
            ) === url
          );
        } catch {
          return false;
        }
      });
      if (same && !id) {
        const result = { item: same, created: false, duplicateSuggestions: [] };
        await db.query(
          "INSERT INTO integration_requests(community_id,key,request_hash,response) VALUES($1,$2,$3,$4)",
          [user.communityId, requestKey, requestHash, result],
        );
        return result;
      }
      const now = this.clock().toISOString(),
        family = input.roleFamily ?? classifyRole(input.title),
        facts = preview?.value ?? old?.payload.intake?.sourceFacts ?? null;
      const effectiveOriginal =
        original ?? old?.payload.originalApplyUrl ?? null;
      const payload = {
        ...old?.payload,
        schemaVersion: 1,
        id: recordId,
        slug: old?.payload.slug ?? `vacancy-${externalId}`,
        sourceId: old?.source_id ?? sourceId,
        externalId: old?.payload.externalId ?? externalId,
        title: input.title,
        company: input.company,
        sourceUrl: url,
        applyUrl: effectiveOriginal ?? url,
        originalApplyUrl: effectiveOriginal,
        contentLanguage:
          input.contentLanguage ?? old?.payload.contentLanguage ?? "und",
        locations: input.locations,
        workplace: input.workplace,
        eligibility: input.eligibility,
        seniority: null,
        salary: null,
        summary: input.summary,
        tags: [],
        status:
          old?.payload.status === "closed" || old?.payload.editorialClosure
            ? "closed"
            : "needs-review",
        approved: false,
        relevanceScore: family ? 4 : 0,
        roleFamily: family,
        sourcePublishedAt: facts?.draft.sourcePublishedAt ?? null,
        firstSeenAt: old?.payload.firstSeenAt ?? now,
        lastSeenAt: now,
        lastVerifiedAt: now,
        expiresAt: Object.hasOwn(input, "expiresAt")
          ? input.expiresAt
          : (facts?.draft.expiresAt ?? old?.payload.expiresAt ?? null),
        ...(Object.hasOwn(input, "expiresAt")
          ? { editorialExpiresAt: input.expiresAt }
          : {}),
        closureReason: old?.payload.closureReason ?? null,
        evidenceRunId: old?.payload.evidenceRunId ?? null,
        sourceClosed: Boolean(
          old?.payload.sourceClosed || facts?.evidence.active === "closed",
        ),
        requisitionId:
          facts?.draft.requisitionId ?? input.requisitionId ?? null,
        requisitionVerified: Boolean(facts?.draft.requisitionId),
        verifiedEmployerName: facts?.draft.company ?? null,
        intake: {
          kind: "single-detail",
          submittedUrl: input.url,
          sourceFacts: facts,
          curator: {
            eligibilityEvidence: input.eligibilityEvidence,
            activeEvidence: input.activeEvidence,
            roleFamily: input.roleFamily ?? null,
            requisitionId: input.requisitionId ?? null,
            originalApplyUrl: original,
            contentLanguage:
              input.contentLanguage ??
              old?.payload.intake?.curator?.contentLanguage ??
              null,
            attestedAt: now,
            actorId: user.id,
          },
          verificationMethod: facts
            ? facts.evidence.method
            : "operator-attestation",
          completeSourceSnapshot: false,
        },
      };
      const row = (
        await db.query(
          id
            ? "UPDATE job_records SET payload=$4,version=version+1,updated_at=now() WHERE community_id=$1 AND id=$2 AND version=$3 RETURNING *"
            : "INSERT INTO job_records(community_id,id,source_id,payload) VALUES($1,$2,$3,$4) RETURNING *",
          id
            ? [user.communityId, recordId, input.version, payload]
            : [user.communityId, recordId, sourceId, payload],
        )
      ).rows[0];
      if (!row) throw new IntegrationError("REVISION_CONFLICT", 409);
      await auditEvent(
        db,
        user,
        deterministicId({ job: recordId }),
        id ? "vacancy_intake_updated" : "vacancy_intake_created",
        {
          jobId: recordId,
          method: payload.intake.verificationMethod,
          version: row.version,
        },
      );
      const result = {
        item: { ...row, geography: jobGeography(row.payload) },
        created: !id,
        duplicateSuggestions: strongVacancyDuplicates([
          ...rows.filter((r) => r.id !== recordId).map((r) => r.payload),
          payload,
        ]).filter((g) => g.ids.includes(recordId)),
      };
      await db.query(
        "INSERT INTO integration_requests(community_id,key,request_hash,response) VALUES($1,$2,$3,$4)",
        [user.communityId, requestKey, requestHash, result],
      );
      return result;
    });
  }
}
