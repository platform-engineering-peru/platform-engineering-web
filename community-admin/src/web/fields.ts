export function getValue(value: any, path: string): any {
  return path.split(".").reduce((v, k) => v?.[k], value);
}
export function setValue(value: any, path: string, next: any): any {
  const copy = structuredClone(value);
  const parts = path.split(".");
  let target = copy;
  for (const key of parts.slice(0, -1))
    target = target[key] ?? (target[key] = {});
  target[parts.at(-1)!] = next;
  return copy;
}
