export type PendingPublication = {
  key: string;
  ids: string[];
  versions: Record<string, number>;
  operationId?: string;
  changesetId?: string;
};
/** Store only public identifiers and an idempotency key; never credentials or private content. */
export function pendingPublication(
  storageKey: string,
): PendingPublication | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    return typeof value?.key === "string" &&
      value.key.length <= 100 &&
      [value.operationId, value.changesetId].every(
        (id) =>
          id === undefined ||
          (typeof id === "string" && /^[A-Za-z0-9:_-]{1,100}$/.test(id)),
      ) &&
      Array.isArray(value.ids) &&
      value.ids.length > 0 &&
      value.ids.length <= 100 &&
      value.versions &&
      Object.keys(value.versions).length === value.ids.length &&
      value.ids.every(
        (id: string) =>
          Number.isSafeInteger(value.versions[id]) && value.versions[id] > 0,
      ) &&
      value.ids.every(
        (id: unknown) => typeof id === "string" && id.length <= 100,
      )
      ? value
      : null;
  } catch {
    return null;
  }
}
export function rememberPublication(
  storageKey: string,
  value: PendingPublication,
) {
  sessionStorage.setItem(storageKey, JSON.stringify(value));
}
export function forgetPublication(storageKey: string) {
  sessionStorage.removeItem(storageKey);
}
