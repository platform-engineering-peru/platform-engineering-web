/** Public attribution only. Syntactic validation never proves a remote post exists. */
export const socialNetworks = [
  "linkedin",
  "youtube",
  "facebook",
  "instagram",
  "x",
  "tiktok",
  "other",
] as const;
export type SocialNetwork = (typeof socialNetworks)[number];
export function socialSource(network: string, sourceUrl: string, label = "") {
  if (
    !socialNetworks.includes(network as SocialNetwork) ||
    sourceUrl.length > 2048
  )
    throw Error("SOCIAL_SOURCE_INVALID");
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw Error("SOCIAL_SOURCE_INVALID");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) ||
    !host.includes(".") ||
    /^[0-9.]+$/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)
  )
    throw Error("SOCIAL_SOURCE_INVALID");
  const path = url.pathname.replace(/%3a/gi, ":");
  const valid =
    network === "other"
      ? !!label.trim() &&
        label.length <= 120 &&
        ![
          "linkedin.com",
          "www.linkedin.com",
          "youtube.com",
          "www.youtube.com",
          "m.youtube.com",
          "youtu.be",
          "facebook.com",
          "www.facebook.com",
          "m.facebook.com",
          "instagram.com",
          "www.instagram.com",
          "x.com",
          "www.x.com",
          "twitter.com",
          "www.twitter.com",
          "tiktok.com",
          "www.tiktok.com",
        ].includes(host)
      : network === "linkedin"
        ? ["linkedin.com", "www.linkedin.com"].includes(host) &&
          (/^\/feed\/update\/urn:li:(?:activity|share|ugcPost):\d+\/?$/.test(
            path,
          ) ||
            /^\/posts\/[^/]+-activity-\d+[^/]*\/?$/.test(path))
        : network === "youtube"
          ? (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(
              host,
            ) &&
              ((path === "/watch" &&
                /^[\w-]{11}$/.test(url.searchParams.get("v") ?? "")) ||
                /^\/(?:shorts|live)\/[\w-]{11}\/?$/.test(path))) ||
            (host === "youtu.be" && /^\/[\w-]{11}\/?$/.test(path))
          : network === "facebook"
            ? ["facebook.com", "www.facebook.com", "m.facebook.com"].includes(
                host,
              ) &&
              (/^\/[^/]+\/(?:posts|videos)\/[^/]+\/?$/.test(path) ||
                (["/permalink.php", "/story.php"].includes(path) &&
                  !!url.searchParams.get("story_fbid") &&
                  !!url.searchParams.get("id")))
            : network === "instagram"
              ? ["instagram.com", "www.instagram.com"].includes(host) &&
                /^\/(?:p|reel)\/[\w-]+\/?$/.test(path)
              : network === "x"
                ? [
                    "x.com",
                    "www.x.com",
                    "twitter.com",
                    "www.twitter.com",
                  ].includes(host) && /^\/[^/]+\/status\/\d+\/?$/.test(path)
                : ["tiktok.com", "www.tiktok.com"].includes(host) &&
                  /^\/@[^/]+\/video\/\d+\/?$/.test(path);
  if (!valid) throw Error("SOCIAL_SOURCE_INVALID");
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key.toLowerCase()))
      url.searchParams.delete(key);
  return {
    network: network as SocialNetwork,
    sourceUrl,
    canonicalKey: url.href,
    label: label.trim(),
  };
}
