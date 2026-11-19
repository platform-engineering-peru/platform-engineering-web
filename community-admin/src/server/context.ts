import type { Response } from "express";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { roleCapabilities } from "../shared/product-contract";
export interface Session {
  id: string;
  communityId: string;
  name: string;
  role: string;
  roles: string[];
  capabilities: string[];
  csrfToken: string;
  isFixture?: boolean;
  authenticatedAt?: string;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fieldErrors: { path: string; message: string }[] = [],
    public currentRevision?: number,
  ) {
    super(message);
  }
}
export function capabilitiesFor(roles: string[]): string[] {
  const all = [
    "content:read",
    "content:write",
    "content:review",
    "content:publish",
    "contacts:read",
    "contacts:write",
    "contacts:export",
    "community:write",
    "jobs:curate",
    "publishing:write",
    "operations:read",
    "members:manage",
  ];
  if (roles.includes("owner")) return ["*", ...all];
  return [...new Set(roles.flatMap((r) => roleCapabilities[r] ?? []))];
}
export function getSession(res: Response): Session {
  return res.locals.session;
}
export function requireCapability(res: Response, capability: string) {
  const user = getSession(res);
  if (
    !user ||
    (!user.capabilities.includes("*") &&
      !user.capabilities.includes(capability))
  )
    throw new ApiError(
      403,
      "PERMISSION_DENIED",
      "Tu cuenta no tiene permiso para esta acción.",
    );
  return user;
}
export async function auditEvent(
  db: pg.PoolClient,
  user: Pick<Session, "id" | "communityId">,
  entityId: string,
  action: string,
  details: unknown = {},
) {
  await db.query(
    "INSERT INTO audit_events(id,community_id,actor_id,entity_id,action,details) VALUES($1,$2,$3,$4,$5,$6)",
    [randomUUID(), user.communityId, user.id, entityId, action, details],
  );
}

export function requireRecentAuthentication(res: Response) {
  const user = getSession(res);
  if (
    !user.authenticatedAt ||
    Date.now() - Date.parse(user.authenticatedAt) > 15 * 60 * 1000
  )
    throw new ApiError(
      403,
      "REAUTHENTICATION_REQUIRED",
      "Vuelve a iniciar sesión antes de esta acción sensible.",
    );
  return user;
}
