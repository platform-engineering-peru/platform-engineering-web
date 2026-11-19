import { assertLifecyclePublication } from "./lifecycle";
import type pg from "pg";
import { encryptPrivate, decryptPrivate } from "./private-data";
import { ApiError, auditEvent, type Session } from "./context";
import { hashRevision } from "../shared/content";
export async function requirePublicConsent(
  db: pg.Pool | pg.PoolClient,
  communityId: string,
  personId: string,
  profileId: string,
) {
  const rows = (
    await db.query(
      "SELECT * FROM records WHERE community_id=$1 AND ((type='consents') OR id=$2 OR id=$3) AND state<>'deleted'",
      [communityId, personId, profileId],
    )
  ).rows;
  const person = rows.find((r) => r.id === personId),
    profile = rows.find((r) => r.id === profileId);
  const payload = profile && decryptPrivate(profile.id, profile.payload);
  const revoked = rows
    .filter((r) => r.type === "consents")
    .some((r) => {
      const p = decryptPrivate(r.id, r.payload);
      return (
        p.personId === personId &&
        (r.state === "archived" || Boolean(p.revokedAt))
      );
    });
  if (
    !person ||
    !profile ||
    person.state === "archived" ||
    profile.state === "archived" ||
    !payload.publicConsent ||
    !payload.consentEvidence ||
    revoked
  )
    throw new ApiError(
      422,
      "CONSENT_REQUIRED",
      "El permiso público debe estar vigente y verificable; revisa cualquier retiro registrado.",
    );
}
export async function invalidatePublicConsent(
  db: pg.PoolClient,
  user: Session,
  type: string,
  payload: any,
  removed = false,
) {
  const personId =
    type === "people" && removed
      ? payload.id
      : type === "consents" && (removed || payload.revokedAt)
        ? payload.personId
        : type === "speaker-profiles" && (removed || !payload.publicConsent)
          ? payload.personId
          : null;
  if (!personId) return;
  const linked = (
    await db.query(
      "SELECT r.* FROM records r JOIN public_projections p ON p.public_record_id=r.id WHERE p.person_id=$1 AND r.community_id=$2 AND r.state NOT IN('deleted','archived') FOR UPDATE OF r",
      [personId, user.communityId],
    )
  ).rows;
  for (const row of linked) {
    await assertLifecyclePublication(db, user.communityId, row.id);
    const updatedAt = new Date().toISOString(),
      revision = row.revision + 1,
      hash = hashRevision({
        id: row.id,
        revision,
        payload: row.payload,
        updatedAt,
      });
    await db.query(
      "UPDATE records SET state='draft',approved_hash=NULL,submitted_hash=NULL,desired_status='archived',revision=$2,revision_hash=$3,updated_at=$4 WHERE id=$1",
      [row.id, revision, hash, updatedAt],
    );
    await db.query(
      "INSERT INTO record_revisions(record_id,revision,payload,revision_hash,updated_at) VALUES($1,$2,$3,$4,$5)",
      [row.id, revision, row.payload, hash, updatedAt],
    );
    await auditEvent(db, user, row.id, "consent_revoked_removal_required", {
      personId,
      revision,
    });
  }
  if (removed && type === "consents") {
    const profiles = (
      await db.query(
        "SELECT * FROM records WHERE community_id=$1 AND type='speaker-profiles' AND state NOT IN('deleted','archived') ORDER BY id FOR UPDATE",
        [user.communityId],
      )
    ).rows;
    for (const row of profiles) {
      const p = decryptPrivate(row.id, row.payload);
      if (p.personId !== personId || !p.publicConsent) continue;
      const updatedAt = new Date().toISOString(),
        revision = row.revision + 1,
        payload = encryptPrivate(row.id, { ...p, publicConsent: false });
      const hash = hashRevision({ id: row.id, revision, payload, updatedAt });
      await db.query(
        "UPDATE records SET payload=$2,revision=$3,revision_hash=$4,approved_hash=NULL,submitted_hash=NULL,updated_at=$5 WHERE id=$1",
        [row.id, payload, revision, hash, updatedAt],
      );
      await db.query(
        "INSERT INTO record_revisions(record_id,revision,payload,revision_hash,updated_at) VALUES($1,$2,$3,$4,$5)",
        [row.id, revision, payload, hash, updatedAt],
      );
      await auditEvent(
        db,
        user,
        row.id,
        "consent_record_removed_profile_invalidated",
        { personId, revision },
      );
    }
  }
}
