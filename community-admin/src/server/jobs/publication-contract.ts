import { ApiError } from "../context";
export interface PublicJobRecord extends Record<string, unknown> {
  id: string;
  status: "active" | "stale" | "closed";
  schemaVersion: 1;
  title: string;
  company: string;
}
export function jobRecordPath(id: string) {
  if (
    !/^(?:greenhouse|lever|manual|hirehive|globant|smartrecruiters):[a-z0-9_-]+:[A-Za-z0-9_-]+$/.test(
      id,
    ) ||
    id.length > 400
  )
    throw new ApiError(
      422,
      "PATH_NOT_ALLOWED",
      "Solo se permiten identidades estables de vacantes públicas.",
    );
  return `content/jobs/${id}.json`;
}
