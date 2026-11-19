import type pg from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction } from "../db";
import {
  ApiError,
  auditEvent,
  capabilitiesFor,
  type Session,
} from "../context";
import { hashValue } from "./security";
import { hashRevision } from "../../shared/content";
import { socialNetworks, socialSource } from "../../shared/social-source";
import { validatePayload } from "../product-schema";
const local = (max: number) =>
  z
    .object({
      "es-pe": z.string().trim().min(1).max(max),
      en: z.string().trim().min(1).max(max),
    })
    .strict();
export const socialConfirmationInput = z
  .object({
    version: z.number().int().positive(),
    revisionHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceNetwork: z.enum(socialNetworks),
    sourceNetworkLabel: z.string().trim().max(120).optional(),
    sourceUrl: z.string().max(2048),
    sourcePublishedAt: z.string().datetime({ offset: true }),
    sourceLanguage: z.enum(["es-pe", "en", "und"]),
    attested: z.literal(true),
    blog: z
      .object({
        title: local(120),
        description: local(4000),
        body: local(20000),
        tags: z.array(z.string().min(1).max(100)).max(100),
      })
      .strict(),
  })
  .strict();
const failure = (code: string, status = 409) =>
  new ApiError(status, code, code);
const sourceFields = (payload: any) =>
  Object.fromEntries(
    [
      "sourceNetwork",
      "sourceNetworkLabel",
      "sourceUrl",
      "sourcePublishedAt",
      "sourceLanguage",
    ].map((k) => [k, payload[k] ?? ""]),
  );
export async function assertBlogConfirmation(
  db: pg.Pool | pg.PoolClient,
  community: string,
  id: string,
  payload: any,
) {
  const link = (
    await db.query(
      "SELECT source_fields FROM social_blog_links WHERE community_id=$1 AND blog_record_id=$2",
      [community, id],
    )
  ).rows[0];
  if (!link) throw failure("BLOG_CONFIRMATION_REQUIRED");
  if (hashValue(link.source_fields) !== hashValue(sourceFields(payload)))
    throw failure("BLOG_SOURCE_IMMUTABLE");
}
async function currentActor(db: pg.PoolClient, session: Session) {
  const row = (
    await db.query(
      "SELECT * FROM users WHERE id=$1 AND community_id=$2 FOR SHARE",
      [session.id, session.communityId],
    )
  ).rows[0];
  const caps = row?.active
    ? capabilitiesFor(row.roles?.length ? row.roles : [row.role])
    : [];
  if (
    !["publishing:write", "content:write"].every(
      (cap) => caps.includes("*") || caps.includes(cap),
    )
  )
    throw failure("PERMISSION_DENIED", 403);
}
export async function confirmSocialPost(
  pool: pg.Pool,
  user: Session,
  id: string,
  raw: unknown,
  key: string,
) {
  const input = socialConfirmationInput.parse(raw);
  z.string().uuid().parse(id);
  if (!key || key.length > 200) throw failure("IDEMPOTENCY_KEY_REQUIRED", 428);
  let source: ReturnType<typeof socialSource>;
  try {
    source = socialSource(
      input.sourceNetwork,
      input.sourceUrl,
      input.sourceNetworkLabel,
    );
  } catch {
    throw failure("SOCIAL_SOURCE_INVALID", 422);
  }
  const requestHash = hashValue({ id, input });
  return transaction(pool, async (db) => {
    // Shared lifecycle/reference order precedes publication and record locks.
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      user.communityId + ":record-lifecycle",
    ]);
    await currentActor(db, user);
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      user.communityId + ":social-confirm:" + key,
    ]);
    const prior = (
      await db.query(
        "SELECT * FROM social_blog_requests WHERE community_id=$1 AND request_key=$2",
        [user.communityId, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash || prior.actor_id !== user.id)
        throw failure("IDEMPOTENCY_CONFLICT");
      return prior.response;
    }
    const publication = (
      await db.query(
        "SELECT * FROM integration_publications WHERE community_id=$1 AND id=$2 FOR UPDATE",
        [user.communityId, id],
      )
    ).rows[0];
    if (!publication) throw failure("NOT_FOUND", 404);
    if (
      publication.version !== input.version ||
      publication.revision_hash !== input.revisionHash
    )
      throw failure("REVISION_CONFLICT");
    if (
      publication.approved_hash !== input.revisionHash ||
      !publication.reviewer_id ||
      publication.reviewer_id === publication.author_id
    )
      throw failure("APPROVAL_REQUIRED");
    const reviewer = (
      await db.query(
        "SELECT * FROM users WHERE id=$1 AND community_id=$2 FOR SHARE",
        [publication.reviewer_id, user.communityId],
      )
    ).rows[0];
    const reviewCaps = reviewer?.active
      ? capabilitiesFor(
          reviewer.roles?.length ? reviewer.roles : [reviewer.role],
        )
      : [];
    if (!reviewCaps.includes("*") && !reviewCaps.includes("content:review"))
      throw failure("APPROVAL_REVOKED");
    if (
      !["approved", "manual-export", "manual-published"].includes(
        publication.state,
      )
    )
      throw failure("PUBLICATION_STATE");
    const pending = await db.query(
      "SELECT id FROM worker_outbox WHERE community_id=$1 AND subject_id=$2 AND (state IN('queued','processing','sending','unknown','running') OR lease_until>now()) FOR UPDATE",
      [user.communityId, id],
    );
    if (pending.rowCount) throw failure("PUBLICATION_IN_FLIGHT");
    if (
      publication.channel !== "manual" &&
      publication.channel !== input.sourceNetwork
    )
      throw failure("SOCIAL_NETWORK_MISMATCH", 422);
    const linked = (
      await db.query(
        "SELECT * FROM social_blog_links WHERE community_id=$1 AND (publication_id=$2 OR (source_network=$3 AND canonical_permalink_key=$4))",
        [user.communityId, id, source.network, source.canonicalKey],
      )
    ).rows[0];
    if (linked)
      throw failure(
        linked.publication_id === id
          ? "SOCIAL_ALREADY_INDEXED"
          : "SOCIAL_SOURCE_ALREADY_INDEXED",
      );
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      user.communityId + ":public:blog",
    ]);
    const recordId = randomUUID(),
      now = new Date().toISOString();
    const order = (
      await db.query(
        "SELECT COALESCE(MAX((payload->>'displayOrder')::integer),0)::integer+10 AS value FROM records WHERE community_id=$1 AND type='blog' AND state NOT IN('archived','deleted')",
        [user.communityId],
      )
    ).rows[0].value;
    const payload = validatePayload(
      "blog",
      {
        slug: `post-${recordId}`,
        ...input.blog,
        displayOrder: order,
        sourceNetwork: source.network,
        sourceNetworkLabel: source.label,
        sourceUrl: source.sourceUrl,
        sourcePublishedAt: input.sourcePublishedAt,
        sourceLanguage: input.sourceLanguage,
      },
      true,
    );
    const hash = hashRevision({
      id: recordId,
      revision: 1,
      payload,
      updatedAt: now,
    });
    const record = (
      await db.query(
        "INSERT INTO records(id,community_id,type,scope,author_id,payload,revision,state,revision_hash,updated_at) VALUES($1,$2,'blog','public',$3,$4,1,'draft',$5,$6) RETURNING *",
        [recordId, user.communityId, user.id, payload, hash, now],
      )
    ).rows[0];
    await db.query(
      "INSERT INTO record_revisions(record_id,revision,payload,revision_hash,updated_at) VALUES($1,1,$2,$3,$4)",
      [recordId, payload, hash, now],
    );
    await db.query(
      "INSERT INTO social_blog_links(community_id,publication_id,blog_record_id,source_network,canonical_permalink_key,source_fields,confirmed_by,publication_version,publication_revision_hash,method) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'operator-attested')",
      [
        user.communityId,
        id,
        recordId,
        source.network,
        source.canonicalKey,
        sourceFields(payload),
        user.id,
        input.version,
        input.revisionHash,
      ],
    );
    const updated = (
      await db.query(
        "UPDATE integration_publications SET state='manual-published',remote_url=$3,version=version+1,updated_at=now() WHERE community_id=$1 AND id=$2 RETURNING *",
        [user.communityId, id, source.sourceUrl],
      )
    ).rows[0];
    await auditEvent(db, user, id, "social_post_attested", {
      blogRecordId: recordId,
      revisionHash: input.revisionHash,
      version: input.version,
      method: "operator-attested",
    });
    await auditEvent(db, user, recordId, "blog_indexed_local", {
      publicationId: id,
      revision: 1,
    });
    const { upload_state: _, ...safePublication } = updated;
    const response = {
      state: "manual-published",
      publication: {
        ...safePublication,
        socialIndex: {
          id: recordId,
          revision: 1,
          state: "draft",
          desiredStatus: "published",
          confirmationMethod: "operator-attested",
        },
      },
      blog: {
        id: recordId,
        type: "blog",
        payload: record.payload,
        state: "draft",
        revision: 1,
        revisionHash: hash,
        desiredStatus: "published",
      },
      website: { state: "local", scope: "at-confirmation" },
      receiptSnapshot: true,
      confirmationMethod: "operator-attested",
    };
    const durableResponse = JSON.parse(JSON.stringify(response));
    await db.query(
      "INSERT INTO social_blog_requests(community_id,request_key,actor_id,request_hash,response) VALUES($1,$2,$3,$4,$5)",
      [user.communityId, key, user.id, requestHash, durableResponse],
    );
    return durableResponse;
  });
}
