import type { MemoryPayload } from "./content";
export interface User {
  id: string;
  name: string;
  role: string;
  roles?: string[];
  capabilities?: string[];
  isFixture?: boolean;
  csrfToken: string;
  authenticatedAt?: string;
  authMethod?: "local-gh";
  github?: {
    subject: string;
    login: string;
    name: string;
    profileUrl: string;
    avatarUrl: string;
    source: "local-gh";
    verifiedAt: string;
  };
}
export interface Draft {
  id: string;
  authorId: string;
  revision: number;
  state: "draft" | "submitted" | "approved" | "changes_requested";
  payload: MemoryPayload;
  revisionHash: string;
  approvedHash: string | null;
  updatedAt: string;
}
export interface AuditEvent {
  id: string;
  action: string;
  actor: string;
  details: Record<string, unknown>;
  created_at: string;
}
