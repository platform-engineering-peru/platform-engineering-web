/** Native local controls only where the API stores an unambiguous wall-clock value. */
export function fieldInputType(key: string, kind: string): string {
  if (kind === "number" || kind === "url") return kind;
  if (key === "date") return "date";
  if (key === "time" || key === "endTime") return "time";
  return "text";
}

export function fieldGroup(key: string, kind: string): string {
  if (
    [
      "slug",
      "displayOrder",
      "order",
      "timeZone",
      "color",
      "datePrecision",
    ].includes(key)
  )
    return "Opciones avanzadas";
  if (key === "title") return "Información principal";
  if (kind === "localized") return "Contenido bilingüe";
  if (kind === "media" || /asset|photo|figurine/i.test(key))
    return "Imágenes y archivos";
  if (kind === "reference" || kind === "url" || /links|globalLinks/.test(key))
    return "Relaciones y enlaces";
  return "Información principal";
}

export function fieldSection(
  key: string,
  kind: string,
  target?: string,
): string {
  if (kind === "media" || target === "media") return "media";
  if (kind === "reference" || kind === "url" || /links/i.test(key))
    return "relationships";
  if (kind === "localized" && key !== "title") return "content";
  return "info";
}
export function fieldPriority(key: string): number {
  return [
    "title",
    "name",
    "preferredName",
    "shortName",
    "date",
    "time",
    "endTime",
    "venue",
    "location",
    "city",
  ].indexOf(key) < 0
    ? 99
    : [
        "title",
        "name",
        "preferredName",
        "shortName",
        "date",
        "time",
        "endTime",
        "venue",
        "location",
        "city",
      ].indexOf(key);
}
