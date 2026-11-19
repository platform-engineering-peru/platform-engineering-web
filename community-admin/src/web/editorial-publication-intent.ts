import {
  pendingPublication,
  rememberPublication,
  forgetPublication,
  type PendingPublication,
} from "./publication-intent";
type Selection = { id: string; version: number };
const storageKey = (actor: string, id: string, version: number) =>
  `editorial-publication:${actor}:${id}:${version}`;
/** A resumed event keeps the complete immutable batch, including after browser reload. */
export function recoverEditorialIntent(
  actor: string,
  id: string,
  version: number,
) {
  return pendingPublication(storageKey(actor, id, version));
}
export function captureEditorialIntent(
  actor: string,
  selection: Selection[],
): PendingPublication {
  const ordered = [...selection].sort((a, b) => a.id.localeCompare(b.id));
  const ids = ordered.map((r) => r.id),
    versions = Object.fromEntries(ordered.map((r) => [r.id, r.version]));
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ordered.some((r) => !Number.isSafeInteger(r.version) || r.version < 1)
  )
    throw Error("No se pudo identificar la revisión de este envío.");
  const existing = ordered
    .map((r) => recoverEditorialIntent(actor, r.id, r.version))
    .find(Boolean);
  if (
    existing &&
    (JSON.stringify(existing.ids) !== JSON.stringify(ids) ||
      JSON.stringify(existing.versions) !== JSON.stringify(versions))
  )
    throw Error(
      "Esta revisión ya pertenece a un envío conjunto. Comprueba ese envío sin cambiar su selección.",
    );
  const intent = existing ?? { key: crypto.randomUUID(), ids, versions };
  for (const row of ordered)
    rememberPublication(storageKey(actor, row.id, row.version), intent);
  return intent;
}
export function forgetEditorialIntent(
  actor: string,
  intent: PendingPublication,
) {
  for (const id of intent.ids)
    forgetPublication(storageKey(actor, id, intent.versions[id]));
}
