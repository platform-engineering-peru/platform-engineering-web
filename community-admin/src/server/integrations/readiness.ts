import type { IntegrationOptions } from "./service";
/** Configuration readiness only; it does not assert provider approval or account access. */
export function providerReadiness(
  options: Pick<IntegrationOptions, "liveEnabled" | "secretKey">,
  env: NodeJS.ProcessEnv = process.env,
) {
  const result: Record<
    string,
    { ready: boolean; reasons: string[]; destinationKind: string }
  > = {};
  for (const provider of ["linkedin", "youtube"] as const) {
    const prefix = provider.toUpperCase(),
      reasons: string[] = [];
    if (!options.liveEnabled) reasons.push("LIVE_DISABLED");
    if (!env[`${prefix}_CLIENT_ID`]?.trim()) reasons.push("CLIENT_ID_MISSING");
    if (!env[`${prefix}_CLIENT_SECRET`]?.trim())
      reasons.push("CLIENT_SECRET_MISSING");
    const uri = env[`${prefix}_REDIRECT_URI`];
    if (!uri) reasons.push("REDIRECT_URI_MISSING");
    else {
      try {
        const u = new URL(uri);
        if (
          u.username ||
          u.password ||
          u.hash ||
          u.search ||
          u.pathname !== `/api/integrations/${provider}/oauth/callback` ||
          !(
            u.protocol === "https:" ||
            (provider === "youtube" &&
              u.protocol === "http:" &&
              u.hostname === "127.0.0.1")
          )
        )
          reasons.push("REDIRECT_URI_INVALID");
      } catch {
        reasons.push("REDIRECT_URI_INVALID");
      }
    }
    if (!options.secretKey)
      reasons.push(
        env.CONNECTOR_ENCRYPTION_KEY
          ? "CONNECTOR_KEY_INVALID"
          : "CONNECTOR_KEY_MISSING",
      );
    else if (options.secretKey.length !== 32)
      reasons.push("CONNECTOR_KEY_INVALID");
    if (provider === "linkedin") {
      if (!env.LINKEDIN_API_VERSION) reasons.push("API_VERSION_MISSING");
      else if (!/^20\d{2}(?:0[1-9]|1[0-2])$/.test(env.LINKEDIN_API_VERSION))
        reasons.push("API_VERSION_INVALID");
    }
    result[provider] = {
      ready: reasons.length === 0,
      reasons,
      destinationKind:
        provider === "linkedin" ? "organization-urn" : "youtube-channel-id",
    };
  }
  return result;
}
