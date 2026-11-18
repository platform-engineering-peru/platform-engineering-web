import { activeOpportunities } from "./opportunities-contract";
const canonical = import.meta.glob("../../content/jobs/*.json", {
  eager: true,
  import: "default",
});
for (const [path, value] of Object.entries(canonical)) {
  const record = value as { id?: string };
  if (!path.endsWith(`/${record.id}.json`))
    throw new Error(
      `Public job filename must match its stable identity: ${path}`,
    );
}
/** Static website reads approved canonical exports only; no admin database or demonstration vacancies. */
export const opportunities = activeOpportunities(Object.values(canonical));
