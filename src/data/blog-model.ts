import type { Localized } from "../i18n/utils";

export interface BlogEntry {
  id: string;
  slug: string;
  status: string;
  title: Localized;
  description: Localized;
  body: Localized;
  sourceNetwork: string;
  sourceNetworkLabel?: string;
  sourceUrl: string;
  sourcePublishedAt: string;
  sourceLanguage: "es-pe" | "en" | "und";
  tags: string[];
}

/** Defense in depth for links rendered from the schema-validated public export. */
export function sourceLink(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes(":")
  ) {
    throw new Error("Expected a public HTTPS source link");
  }
  return value;
}

/** Confirmation is enforced by the server exporter; this reader only sees public JSON. */
export function blogEntries(records: BlogEntry[]): BlogEntry[] {
  return records
    .filter((record) => record.status === "published")
    .map((record) => {
      sourceLink(record.sourceUrl);
      if (!Number.isFinite(Date.parse(record.sourcePublishedAt)))
        throw new Error("Invalid source publication date");
      return record;
    })
    .sort(
      (a, b) =>
        Date.parse(b.sourcePublishedAt) - Date.parse(a.sourcePublishedAt) ||
        a.slug.localeCompare(b.slug),
    );
}

export const bodyParagraphs = (body: string) =>
  body
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);

export function networkLabel(post: BlogEntry): string {
  return (
    (
      {
        linkedin: "LinkedIn",
        youtube: "YouTube",
        facebook: "Facebook",
        instagram: "Instagram",
        x: "X",
        tiktok: "TikTok",
      } as Record<string, string>
    )[post.sourceNetwork] ??
    post.sourceNetworkLabel ??
    post.sourceNetwork
  );
}
