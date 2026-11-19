import { workspaces } from "./navigation";
const sections = new Set(
  workspaces.flatMap((workspace) => workspace.items.map((item) => item.id)),
);
export function validSection(section: string, fixtureEnabled = false) {
  return sections.has(section) || (fixtureEnabled && section === "memories");
}
export function sectionFromUrl(
  url: URL,
  fallback = "overview",
  fixtureEnabled = false,
) {
  const requested = url.searchParams.get("section");
  if (requested !== null)
    return validSection(requested, fixtureEnabled) ? requested : fallback;
  return fixtureEnabled && url.hash === "#fixture-memories"
    ? "memories"
    : fallback;
}
export function sectionUrl(url: URL, section: string) {
  const next = new URL(url);
  next.searchParams.set("section", section);
  return next;
}
export function defaultSection(role: string) {
  return role === "coordinator"
    ? "people"
    : role === "jobs_curator"
      ? "jobs-candidates"
      : role === "publisher"
        ? "calendar"
        : "overview";
}
