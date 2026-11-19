const mediaId =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Presentation filter only; the authenticated server independently checks inventory and real paths. */
export function trustedPreviewPath(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^brand\/[a-zA-Z0-9][a-zA-Z0-9/_ .-]*\.(?:svg|png|jpe?g|webp|gif|avif)$/i.test(
      value,
    )
  )
    return null;
  if (value.split("/").some((part) => !part || part === "." || part === ".."))
    return null;
  return value;
}
export function recordCoverSource(record: {
  id?: string;
  type: string;
  payload?: Record<string, any>;
}): string | null {
  const p = record.payload ?? {};
  if (record.type === "brands") {
    const path =
      trustedPreviewPath(p.previewPath) || trustedPreviewPath(p.path);
    return path && typeof record.id === "string" && mediaId.test(record.id)
      ? `/api/brand-assets/${record.id}/preview`
      : null;
  }
  if (record.type === "speakers" && typeof p.photo === "string") {
    const local =
      /^speakers\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:png|jpe?g|webp|avif)$/i.test(
        p.photo,
      );
    let remote = false;
    try {
      const url = new URL(p.photo);
      remote =
        url.protocol === "https:" &&
        url.hostname === "img.evbuc.com" &&
        !url.username &&
        !url.password &&
        !url.port;
    } catch {
      /* Local inventory paths are resolved by the authenticated server. */
    }
    if (remote) return p.photo;
    return local && typeof record.id === "string" && mediaId.test(record.id)
      ? `/api/speaker-assets/${record.id}/preview`
      : null;
  }
  const id =
    record.type === "organizers"
      ? p.figurineAssetId
      : (p.media?.[0]?.assetId ?? p.photoAssetId ?? p.previewAssetId);
  return typeof id === "string" && mediaId.test(id) ? `/api/media/${id}` : null;
}
/** The organizer's explicit editorial order travels with its identity and artwork. */
export function orderManagerRecords<
  T extends { payload?: Record<string, any> },
>(records: T[], type: string): T[] {
  if (type !== "organizers") return records;
  const order = (record: T) =>
    Number.isFinite(record.payload?.displayOrder)
      ? (record.payload!.displayOrder as number)
      : Number.MAX_SAFE_INTEGER;
  return [...records].sort((a, b) => order(a) - order(b));
}
