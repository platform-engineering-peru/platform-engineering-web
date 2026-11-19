import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";
import { IntegrationError } from "./security";
export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}
export type Transport = (
  url: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
    maxBytes?: number;
    timeoutMs?: number;
    hosts?: string[];
  },
) => Promise<HttpResult>;
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 2) ||
      (a === 198 && b === 51) ||
      (a === 203 && b === 0)
    );
  }
  if (isIP(ip) === 6) {
    const s = ip.toLowerCase(),
      parts = s.split(":");
    return (
      /^2[0-9a-f]{3}:/.test(s) &&
      parts[0] !== "2002" &&
      !(
        parts[0] === "2001" &&
        (parseInt(parts[1] || "0", 16) <= 0x1ff || parts[1] === "db8")
      )
    );
  }
  return false;
}
/** Node 22 may request all answers for autoSelectFamily; return only the vetted pinned answer. */
export function pinnedLookup(address: { address: string; family: number }) {
  return (_host: string, options: any, callback: any) =>
    options?.all
      ? callback(null, [{ address: address.address, family: address.family }])
      : callback(null, address.address, address.family);
}
export const secureRequest: Transport = async (input, options = {}) => {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !options.hosts?.includes(url.hostname)
  )
    throw new IntegrationError("BLOCKED");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new IntegrationError("BLOCKED");
  // Pin the vetted DNS answer for this request to prevent DNS-rebinding between check and connect.
  const address = addresses[0];
  return await new Promise<HttpResult>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const req = https.request(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers,
        lookup: pinnedLookup(address),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (b: Buffer) => {
          bytes += b.length;
          if (bytes > (options.maxBytes ?? 4_000_000)) {
            res.destroy();
            fail(new IntegrationError("RESPONSE_LIMIT"));
          } else chunks.push(b);
        });
        res.on("error", fail);
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.join(",") : (v ?? ""),
              ]),
            ),
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    const deadline = setTimeout(
      () =>
        req.destroy(
          new IntegrationError(
            "TIMEOUT",
            503,
            !!options.method &&
              !["GET", "HEAD", "PUT"].includes(options.method),
          ),
        ),
      options.timeoutMs ?? 15000,
    );
    req.on("close", () => clearTimeout(deadline));
    req.setTimeout(options.timeoutMs ?? 15000, () =>
      req.destroy(
        new IntegrationError(
          "TIMEOUT",
          503,
          options.method !== undefined && options.method !== "GET",
        ),
      ),
    );
    req.on("error", fail);
    if (options.body) req.write(options.body);
    req.end();
  });
};
export function jsonBody<T = any>(result: HttpResult): T {
  try {
    if (!/json/i.test(result.headers["content-type"] ?? "application/json"))
      throw 0;
    return JSON.parse(result.body.toString());
  } catch {
    throw new IntegrationError("PARSE");
  }
}
export async function apiRequest(
  transport: Transport,
  url: string,
  options: Parameters<Transport>[1] = {},
): Promise<HttpResult> {
  let result: HttpResult;
  try {
    result = await transport(url, options);
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError(
      "TRANSPORT",
      503,
      !!options?.method && !["GET", "HEAD", "PUT"].includes(options.method),
    );
  }
  if (result.status === 401 || result.status === 403)
    throw new IntegrationError("NEEDS_RECONNECTION", 503);
  if (result.status === 429)
    throw new IntegrationError(
      "RATE_LIMIT",
      503,
      false,
      Math.min(3600, Number(result.headers["retry-after"]) || 60),
    );
  if (result.status >= 500)
    throw new IntegrationError(
      "PROVIDER_UNAVAILABLE",
      503,
      !!options?.method && options.method === "POST",
    );
  if (result.status >= 400)
    throw new IntegrationError("PROVIDER_REJECTED", 422);
  return result;
}
