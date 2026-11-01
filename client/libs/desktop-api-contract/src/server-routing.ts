// SPDX-License-Identifier: AGPL-3.0-or-later

/** A server identity is an origin, never a URL carrying credentials or a path. */
export function normalizeServerBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Invalid server origin");
  return url.origin;
}

/** HTTP is only meaningful for an explicitly configured local/private server.
 * Public hosts require HTTPS. URL parsing canonicalizes IPv4 spellings before
 * this check; link-local/metadata addresses are deliberately not admitted. */
export function isAllowedDesktopServerOrigin(value: string): boolean {
  try {
    const url = new URL(normalizeServerBaseUrl(value));
    if (url.protocol === "https:") return true;
    const host = url.hostname;
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host === "[::1]"
    )
      return true;
    if (/^\[f[cd][0-9a-f]{2}:/.test(host)) return true;
    const parts = host.split(".").map(Number);
    return (
      parts.length === 4 &&
      parts.every(
        (part) => Number.isInteger(part) && part >= 0 && part <= 255,
      ) &&
      (parts[0] === 127 ||
        parts[0] === 10 ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168))
    );
  } catch {
    return false;
  }
}

/** The only relative Electron server route. Main resolves the opaque ID from
 * its validated persisted list; callers cannot encode a destination origin. */
export function desktopServerRequestUrl(
  serverId: string,
  serverPath: string,
): string {
  if (
    !/^[\w-]+$/.test(serverId) ||
    !serverPath.startsWith("/") ||
    serverPath.startsWith("//") ||
    serverPath.includes("\\")
  ) {
    throw new Error("Invalid server request route");
  }
  // Normalize dot segments before prepending the owner. Otherwise a server-
  // supplied font/asset path could escape /_server/<id> in Chromium's parser.
  const path = new URL(serverPath, "assets://.");
  // The existing popup uses another-host solely to isolate Chromium zoom.
  // Keep its requests same-origin too; Main normalizes this bundled host before
  // resolving the very same registered server ID. No remote origin is accepted.
  const host =
    typeof location !== "undefined" &&
    location.protocol === "assets:" &&
    location.host === "another-host"
      ? "another-host"
      : ".";
  return `assets://${host}/_server/${encodeURIComponent(serverId)}${path.pathname}${path.search}${path.hash}`;
}
