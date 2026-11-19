import { parse } from "csv-parse/browser/esm/sync";
export const contactColumns: Record<string, string> = {
  name: "Nombre",
  email: "Correo",
  phone: "Teléfono",
  location: "Ubicación",
  notes: "Notas privadas",
  provenance: "Procedencia",
  permissionBasis: "Base de permiso",
};
export function readImportRows(csv: string): string[][] {
  if (!csv.trim()) return [];
  return parse(csv, {
    skip_empty_lines: true,
    bom: true,
    relax_column_count: false,
  });
}
export function mappedImport(
  rows: string[][],
  mapping: Record<string, string>,
) {
  const columns = Object.keys(contactColumns).filter(
    (key) => mapping[key] !== undefined && mapping[key] !== "",
  );
  const quote = (value: string) =>
    '"' + String(value ?? "").replaceAll('"', '""') + '"';
  return [
    columns.join(","),
    ...rows
      .slice(1)
      .map((row) =>
        columns.map((key) => quote(row[Number(mapping[key])])).join(","),
      ),
  ].join("\r\n");
}
