import { isIP } from "node:net";
import { createHash } from "node:crypto";
import {
  secureRequest,
  isPublicAddress,
  type Transport,
} from "../integrations/http";
import { IntegrationError } from "../integrations/security";
export function validateCareersUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IntegrationError("INVALID_CAREERS_URL", 422);
  }
  const host = url.hostname.replace(/[\[\]]/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !host.includes(".") ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) ||
    (isIP(host) && !isPublicAddress(host))
  )
    throw new IntegrationError("INVALID_CAREERS_URL", 422);
  return url;
}
export function identifyBoard(url: URL) {
  const parts = url.pathname.split("/").filter(Boolean);
  let provider: "greenhouse" | "lever" | "smartrecruiters" | null = null,
    board: string | undefined;
  if (
    ["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(url.hostname)
  ) {
    provider = "greenhouse";
    board =
      parts[0] === "embed"
        ? (url.searchParams.get("for") ?? undefined)
        : parts[0];
  } else if (
    url.hostname === "boards-api.greenhouse.io" &&
    parts[0] === "v1" &&
    parts[1] === "boards"
  ) {
    provider = "greenhouse";
    board = parts[2];
  } else if (url.hostname === "jobs.lever.co") {
    provider = "lever";
    board = parts[0];
  } else if (
    url.hostname === "api.lever.co" &&
    parts[0] === "v0" &&
    parts[1] === "postings"
  ) {
    provider = "lever";
    board = parts[2];
  } else if (
    ["jobs.smartrecruiters.com", "careers.smartrecruiters.com"].includes(
      url.hostname,
    )
  ) {
    provider = "smartrecruiters";
    board = parts[0];
  } else if (
    url.hostname === "api.smartrecruiters.com" &&
    parts[0] === "v1" &&
    parts[1] === "companies" &&
    parts[3] === "postings"
  ) {
    provider = "smartrecruiters";
    board = parts[2];
  }
  if (!provider || !board || !/^[a-zA-Z0-9_-]{1,100}$/.test(board)) return null;
  return {
    provider,
    boardIdentifier: board,
    canonicalUrl:
      provider === "lever"
        ? `https://jobs.lever.co/${board}`
        : provider === "smartrecruiters"
          ? `https://jobs.smartrecruiters.com/${board}`
          : `https://boards.greenhouse.io/${board}`,
  };
}
export function identifyDetailProvider(url: URL) {
  const hire = /^([a-z0-9-]+)\.hirehive\.com$/.exec(url.hostname),
    globant =
      url.hostname === "career.globant.com" &&
      /^\/job\/[a-z0-9-]+\/\d+\/?$/i.test(url.pathname);
  if (
    !(hire && /^\/[a-z0-9-]+-[a-z0-9]{4,20}\/?$/i.test(url.pathname)) &&
    !globant
  )
    return null;
  const provider = hire ? "hirehive" : "globant",
    identity = createHash("sha256")
      .update(url.origin + url.pathname)
      .digest("hex")
      .slice(0, 16);
  return {
    provider,
    boardIdentifier: `${hire?.[1] ?? "globant"}-${identity}`,
    canonicalUrl: url.href,
    coverage: "single-detail",
  };
}
function normalizedOctets(value: string) {
  return value.replace(/%[a-f0-9]{2}/gi, (part) => {
    const char = String.fromCharCode(parseInt(part.slice(1), 16));
    return /[A-Za-z0-9._~-]/.test(char) ? char : part.toUpperCase();
  });
}
export function robotsDenied(body: string, path: string) {
  const groups: {
    agents: string[];
    rules: { allow: boolean; pattern: string }[];
  }[] = [];
  let current = {
    agents: [] as string[],
    rules: [] as { allow: boolean; pattern: string }[],
  };
  for (const line of body.split(/\r?\n/)) {
    const [raw, ...rest] = line.split(":");
    const key = raw.trim().toLowerCase(),
      value = rest.join(":").split("#")[0].trim();
    if (key === "user-agent") {
      if (current.rules.length) {
        groups.push(current);
        current = { agents: [], rules: [] };
      }
      if (value) current.agents.push(value.toLowerCase());
    } else if (
      ["allow", "disallow"].includes(key) &&
      current.agents.length &&
      value.startsWith("/")
    )
      current.rules.push({ allow: key === "allow", pattern: value });
  }
  groups.push(current);
  const score = (agents: string[]) =>
    Math.max(
      -1,
      ...agents.map((a) =>
        a === "*" ? 0 : "communityadminjobs".startsWith(a) ? a.length : -1,
      ),
    );
  const specificity = Math.max(-1, ...groups.map((g) => score(g.agents)));
  let best = -1,
    allowed = true;
  for (const group of groups.filter(
    (g) => score(g.agents) === specificity && specificity >= 0,
  ))
    for (const rule of group.rules) {
      const pattern = normalizedOctets(rule.pattern),
        anchored = pattern.endsWith("$"),
        body = anchored ? pattern.slice(0, -1) : pattern;
      const regex =
        "^" +
        body
          .split("*")
          .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        (anchored ? "$" : "");
      if (new RegExp(regex).test(normalizedOctets(path))) {
        const weight = body.replaceAll("*", "").length;
        if (weight > best || (weight === best && rule.allow)) {
          best = weight;
          allowed = rule.allow;
        }
      }
    }
  return !allowed;
}
export async function discoverCareers(
  input: string,
  company = "",
  transport: Transport = secureRequest,
  now = new Date(),
): Promise<any> {
  const initial = validateCareersUrl(input);
  let url = initial;
  let detected: any = identifyBoard(url) ?? identifyDetailProvider(url),
    method = "url";
  let requests = 0;
  const fetch = async (target: URL, maxBytes: number) => {
    if (++requests > 5) throw new IntegrationError("DISCOVERY_LIMIT", 422);
    return transport(target.href, {
      hosts: [target.hostname],
      maxBytes,
      timeoutMs: 10000,
      headers: { "User-Agent": "CommunityAdminJobs/1.0" },
    });
  };
  let reason = "UNSUPPORTED_CAREERS_PAGE";
  if (!detected) {
    method = "html-link";
    const robots = await fetch(new URL("/robots.txt", url), 128000);
    if (robots.body.length > 128000)
      throw new IntegrationError("DISCOVERY_LIMIT", 422);
    if (
      robots.status === 200 &&
      robotsDenied(robots.body.toString(), url.pathname + url.search)
    )
      return {
        supported: false,
        provider: null,
        company,
        canonicalUrl: url.href,
        reason: "ROBOTS_DISALLOWED",
        evidence: {
          inputUrl: initial.href,
          finalUrl: url.href,
          method,
          checkedAt: now.toISOString(),
        },
      };
    if (![200, 404].includes(robots.status))
      return {
        supported: false,
        provider: null,
        company,
        canonicalUrl: url.href,
        reason: "ROBOTS_UNAVAILABLE",
        evidence: {
          inputUrl: initial.href,
          finalUrl: url.href,
          method,
          checkedAt: now.toISOString(),
        },
      };
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (
        robots.status === 200 &&
        robotsDenied(robots.body.toString(), url.pathname + url.search)
      )
        return {
          supported: false,
          provider: null,
          company,
          canonicalUrl: url.href,
          reason: "ROBOTS_DISALLOWED",
          evidence: {
            inputUrl: initial.href,
            finalUrl: url.href,
            method,
            checkedAt: now.toISOString(),
          },
        };
      const response = await fetch(url, 2_000_000);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = validateCareersUrl(
          new URL(response.headers.location ?? "", url).href,
        );
        const board = identifyBoard(next);
        if (next.origin !== url.origin && !board)
          throw new IntegrationError("DISCOVERY_REDIRECT_BLOCKED", 422);
        if (board) {
          url = next;
          detected = board;
          break;
        }
        if (redirects === 3) throw new IntegrationError("DISCOVERY_LIMIT", 422);
        url = next;
        continue;
      }
      if (response.status !== 200)
        throw new IntegrationError(
          response.status === 429 ? "RATE_LIMIT" : "CAREERS_FETCH_FAILED",
          503,
        );
      if (
        response.body.length > 2_000_000 ||
        !/text\/html|application\/xhtml\+xml/i.test(
          response.headers["content-type"] ?? "",
        )
      )
        throw new IntegrationError("UNSUPPORTED_CAREERS_CONTENT", 422);
      const html = response.body
        .toString()
        .replace(/<!--[^]*?-->/g, "")
        .replace(/<script\b[^>]*>[^]*?<\/script\s*>/gi, "");
      const boards = new Map<
        string,
        NonNullable<ReturnType<typeof identifyBoard>>
      >();
      for (const m of html.matchAll(
        /<(?:a|iframe)\b[^>]*\b(?:href|src)\s*=\s*["']([^"']+)["'][^>]*>/gi,
      )) {
        try {
          const link = validateCareersUrl(
              new URL(m[1].replaceAll("&amp;", "&"), url).href,
            ),
            board = identifyBoard(link);
          if (board)
            boards.set(board.provider + ":" + board.boardIdentifier, board);
        } catch {
          /* Unsupported links are not followed. */
        }
      }
      if (boards.size === 1) detected = [...boards.values()][0];
      else if (boards.size > 1) reason = "MULTIPLE_BOARDS_REQUIRE_SELECTION";
      break;
    }
  }
  const evidence = {
    inputUrl: initial.href,
    finalUrl: url.href,
    method,
    checkedAt: now.toISOString(),
  };
  if (!detected)
    return {
      supported: false,
      provider: null,
      boardIdentifier: null,
      canonicalUrl: url.href,
      company,
      reason,
      evidence,
    };
  const name = company.trim().slice(0, 200) || detected.boardIdentifier;
  return {
    supported: true,
    ...detected,
    company: name,
    evidence,
    config: {
      id: `${detected.provider}-${detected.boardIdentifier.toLowerCase()}`,
      adapter: detected.provider,
      boardIdentifier: detected.boardIdentifier,
      company: name,
      careersUrl: initial.href,
      enabled: false,
      allowedHosts: [
        detected.provider === "hirehive" || detected.provider === "globant"
          ? url.hostname
          : detected.provider === "greenhouse"
            ? "boards-api.greenhouse.io"
            : detected.provider === "smartrecruiters"
              ? "api.smartrecruiters.com"
              : "api.lever.co",
      ],
      schedule: { enabled: false, intervalHours: 12 },
      ...(detected.coverage ? { coverage: detected.coverage } : {}),
    },
  };
}
