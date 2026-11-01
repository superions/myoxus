import * as dns from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const BLOCKED_IPS = new BlockList();
const ALLOWED_IPV6 = new BlockList();

function stripZoneId(address: string) {
  const idx = address.indexOf("%");
  return idx === -1 ? address : address.slice(0, idx);
}

function stripIpv6Brackets(hostname: string) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

// Use Node's built-in BlockList from Electron's bundled Node runtime.
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmark testing
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["100.64.0.0", 10], // CGNAT
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved (includes broadcast)
] as const) {
  BLOCKED_IPS.addSubnet(network, prefix, "ipv4");
}

BLOCKED_IPS.addAddress("::", "ipv6");
BLOCKED_IPS.addAddress("::1", "ipv6");
BLOCKED_IPS.addSubnet("ff00::", 8, "ipv6"); // multicast
BLOCKED_IPS.addSubnet("fc00::", 7, "ipv6"); // unique local
BLOCKED_IPS.addSubnet("fe80::", 10, "ipv6"); // link-local
BLOCKED_IPS.addSubnet("2001:db8::", 32, "ipv6"); // documentation
ALLOWED_IPV6.addSubnet("2000::", 3, "ipv6"); // global unicast

function extractEmbeddedIPv4FromIPv6(address: string): string | null {
  if (!address.includes(".")) {
    return null;
  }
  const idx = address.lastIndexOf(":");
  if (idx === -1) {
    return null;
  }
  const tail = address.slice(idx + 1);
  return isIP(tail) === 4 ? tail : null;
}

function isBlockedIpAddress(address: string): boolean {
  const ip = stripZoneId(address);
  const family = isIP(ip);
  if (family === 4) {
    return BLOCKED_IPS.check(ip, "ipv4");
  }
  if (family === 6) {
    const embeddedV4 = extractEmbeddedIPv4FromIPv6(ip);
    if (embeddedV4) {
      return isBlockedIpAddress(embeddedV4);
    }
    if (!ALLOWED_IPV6.check(ip, "ipv6")) {
      return true;
    }
    return BLOCKED_IPS.check(ip, "ipv6");
  }
  return true;
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  const lowered = hostname.toLowerCase();
  if (lowered === "localhost" || lowered.endsWith(".localhost")) {
    return ["127.0.0.1", "::1"];
  }

  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

export async function resolveAndValidateUrlForPreview(
  rawUrl: string,
): Promise<{ url: URL; address: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error("Disallowed URL protocol");
  }

  if (url.username || url.password) {
    throw new Error("URL must not include credentials");
  }

  if (!url.hostname) {
    throw new Error("Missing hostname");
  }

  const hostname = stripIpv6Brackets(url.hostname);
  if (isIP(hostname)) {
    if (isBlockedIpAddress(hostname)) {
      throw new Error("Blocked IP address");
    }
    return { url, address: hostname };
  }

  const addresses = await resolveHostAddresses(hostname);
  if (!addresses.length) {
    throw new Error("Unresolvable hostname");
  }

  for (const addr of addresses) {
    if (isBlockedIpAddress(addr)) {
      throw new Error("Blocked IP address");
    }
  }

  return { url, address: addresses[0] };
}

function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_hostname, options, callback) =>
    callback(
      null,
      options.all ? [{ address, family }] : address,
      options.all ? undefined : family,
    );
}

/**
 * Fetches a bounded JSON response without a DNS time-of-check/time-of-use gap.
 * The URL keeps its original hostname for Host/SNI while the socket lookup is
 * pinned to the public address validated immediately before the request.
 */
export async function fetchValidatedJson(
  rawUrl: string,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<unknown> {
  const { url, address } = await resolveAndValidateUrlForPreview(rawUrl);
  const transport = url.protocol === "https:" ? https : http;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 6000;

  return new Promise((resolve, reject) => {
    const request = transport.get(
      url,
      {
        lookup: pinnedLookup(address),
        headers: { Accept: "application/json" },
      },
      (response) => {
        if (
          response.statusCode === undefined ||
          response.statusCode < 200 ||
          response.statusCode >= 300
        ) {
          response.resume();
          reject(
            new Error(
              `Validated JSON request failed with status ${response.statusCode ?? "unknown"}`,
            ),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += buffer.length;
          if (received > maxBytes) {
            request.destroy(new Error("Validated JSON response is too large"));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("Validated JSON response is invalid"));
          }
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Validated JSON request timed out"));
    });
    request.on("error", reject);
  });
}

export type ValidatedTextResponse = {
  body: string;
  contentType: string | undefined;
  url: URL;
};

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Fetches bounded text while pinning every request to its freshly validated
 * public address. Redirect targets are resolved relative to the current URL
 * and pass through the same validation before any connection is opened.
 */
export async function fetchValidatedText(
  rawUrl: string,
  options: {
    maxBytes?: number;
    maxRedirects?: number;
    timeoutMs?: number;
    userAgent?: string;
  } = {},
): Promise<ValidatedTextResponse> {
  const { url, address } = await resolveAndValidateUrlForPreview(rawUrl);
  const transport = url.protocol === "https:" ? https : http;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const timeoutMs = options.timeoutMs ?? 6000;

  return new Promise((resolve, reject) => {
    const request = transport.get(
      url,
      {
        lookup: pinnedLookup(address),
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "User-Agent": options.userAgent ?? "Myoxus Desktop",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = headerValue(response.headers.location);
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          response.resume();
          if (maxRedirects <= 0) {
            reject(new Error("Validated text request exceeded redirect limit"));
            return;
          }
          let redirectedUrl: URL;
          try {
            redirectedUrl = new URL(location, url);
          } catch {
            reject(
              new Error("Validated text request received invalid redirect"),
            );
            return;
          }
          resolve(
            fetchValidatedText(redirectedUrl.toString(), {
              ...options,
              maxBytes,
              maxRedirects: maxRedirects - 1,
              timeoutMs,
            }),
          );
          return;
        }

        if (status < 200 || status >= 300) {
          response.resume();
          reject(
            new Error(`Validated text request failed with status ${status}`),
          );
          return;
        }

        const declaredLength = Number(response.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          response.resume();
          reject(new Error("Validated text response is too large"));
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += buffer.length;
          if (received > maxBytes) {
            request.destroy(new Error("Validated text response is too large"));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          const contentType = headerValue(response.headers["content-type"]);
          const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(
            contentType ?? "",
          )?.[1];
          let body: string;
          try {
            body = new TextDecoder(charset ?? "utf-8").decode(
              Buffer.concat(chunks),
            );
          } catch {
            body = Buffer.concat(chunks).toString("utf8");
          }
          resolve({ body, contentType, url });
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Validated text request timed out"));
    });
    request.on("error", reject);
  });
}
