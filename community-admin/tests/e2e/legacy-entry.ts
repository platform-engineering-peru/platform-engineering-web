/** One historical UI fixture has a fixed local port and generates another source template. */
export function rewriteLegacyEntry(
  source: string,
  sourceURL: URL,
  port: number,
) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4455)
    throw Error("E2E_INVALID_FIXTURE_PORT");
  return source
    .replaceAll("4468", String(port))
    .replace(
      /^(\s*import[^\n]+?\bfrom\s*["'])(\.[^"']+)(["'])/gm,
      (_, prefix, specifier, suffix) =>
        prefix + new URL(specifier, sourceURL).href + suffix,
    );
}
