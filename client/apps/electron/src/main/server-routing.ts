// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  isAllowedDesktopServerOrigin,
  normalizeServerBaseUrl,
} from "@myoxus/desktop-api-contract";
import { createHash } from "node:crypto";
import { session } from "electron";
import { z } from "zod";

import { globalStateStorage } from "./shared-storage/storage";
import { responseCookieMutations } from "./response-cookies";

const metadataSchema = z.object({
  id: z.string().regex(/^[\w-]+$/),
  baseUrl: z.string(),
});
const configSchema = z.object({
  type: z.enum(["Standalone", "Cloud"]),
  serverName: z.string(),
  features: z.array(z.string()),
  oauthProviders: z.array(z.string()),
  credentialsRequirement: z.object({
    password: z.object({ minLength: z.number(), maxLength: z.number() }),
  }),
});

export type RegisteredDesktopServer = z.infer<typeof metadataSchema>;

/** Validate the existing persisted handshake shape without dropping its fields. */
export function validateDesktopServerRegistration(
  server: unknown,
  config: unknown,
) {
  const metadata = metadataSchema.safeParse(server);
  if (
    !metadata.success ||
    !configSchema.safeParse(config).success ||
    !isAllowedDesktopServerOrigin(metadata.data.baseUrl) ||
    normalizeServerBaseUrl(metadata.data.baseUrl) !== metadata.data.baseUrl
  ) {
    throw new TypeError("Invalid configured server registration");
  }
  return metadata.data;
}

/** Read the authoritative shared storage each time, including on redirects.
 * No cache or second registry can outlive removal of a configured server. */
export function registeredDesktopServers(): RegisteredDesktopServer[] {
  const records = globalStateStorage.get<unknown>("serverList");
  if (!Array.isArray(records)) return [];
  const servers: RegisteredDesktopServer[] = [];
  for (const record of records) {
    const result = metadataSchema.safeParse(record);
    if (!result.success) continue;
    const server = result.data;
    if (
      !isAllowedDesktopServerOrigin(server.baseUrl) ||
      normalizeServerBaseUrl(server.baseUrl) !== server.baseUrl
    )
      continue;
    if (
      !configSchema.safeParse(
        globalStateStorage.get(`serverConfig:${server.id}`),
      ).success
    )
      continue;
    servers.push(server);
  }
  // Ambiguous persisted identities are not usable authorities.
  return servers.filter(
    (server) =>
      servers.filter(
        (other) => other.id === server.id || other.baseUrl === server.baseUrl,
      ).length === 1,
  );
}

export function registeredDesktopServer(id: string) {
  return registeredDesktopServers().find((server) => server.id === id);
}

export function desktopServerForUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    if (url.username || url.password) return undefined;
    return registeredDesktopServers().find(
      (server) => server.baseUrl === url.origin,
    );
  } catch {
    return undefined;
  }
}

/** Socket.IO's HTTP polling and WebSocket upgrade carry the same native ID.
 * A matching URL alone never authorizes attaching a user's session cookies. */
export function desktopSocketServer(rawUrl: string) {
  const url = new URL(rawUrl);
  const id = url.searchParams.get("myoxusServerId");
  if (!id) return undefined;
  const server = desktopServerForUrl(rawUrl);
  if (!server || server.id !== id || !url.pathname.startsWith("/socket.io/")) {
    throw new Error("Invalid desktop socket authority");
  }
  return server;
}

export function resolveDesktopServerRequest(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.protocol !== "assets:" || url.host !== ".")
    throw new Error("Invalid server proxy origin");
  const match = /^\/_server\/([\w-]+)(\/.*)$/.exec(url.pathname);
  const server = match && registeredDesktopServer(match[1]);
  if (!server) throw new Error("Server proxy requires a registered server");
  const target = new URL(match[2] + url.search, server.baseUrl);
  if (target.origin !== server.baseUrl || target.username || target.password)
    throw new Error("Invalid server proxy target");
  return { server, target };
}

/** Native cookie partitions isolate even two servers on the same hostname but
 * different ports, which a domain-keyed shared browser cookie jar cannot do.
 * The server list remains the authority; partitions store only HTTP state. */
export function desktopServerSession(server: RegisteredDesktopServer) {
  if (registeredDesktopServer(server.id)?.baseUrl !== server.baseUrl)
    throw new Error("Server was removed or replaced");
  const originKey = createHash("sha256").update(server.baseUrl).digest("hex");
  // Do not reinterpret deployed Keychain-encrypted macOS cookie databases as
  // plaintext. This stable partition changes once, then survives every update.
  const owner =
    process.platform === "darwin" ? "myoxus-profile-server" : "myoxus-server";
  return session.fromPartition(`persist:${owner}-${server.id}-${originKey}`);
}

export async function persistDesktopServerCookies(
  server: RegisteredDesktopServer,
  url: string,
  headers: string[],
) {
  const cookies = desktopServerSession(server).cookies;
  for (const header of headers) {
    for (const mutation of responseCookieMutations(header, url)) {
      if (mutation.type === "remove")
        await cookies.remove(mutation.url, mutation.name);
      else await cookies.set(mutation.details);
    }
  }
}

export async function proxyDesktopServerRequest(
  request: Request,
): Promise<Response> {
  let resolved: ReturnType<typeof resolveDesktopServerRequest>;
  try {
    resolved = resolveDesktopServerRequest(request.url);
  } catch {
    return new Response("Unregistered server route", { status: 403 });
  }
  const { server } = resolved;
  let target = resolved.target;
  let method = request.method;
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("host");
  headers.delete("referer");
  headers.set("origin", server.baseUrl);

  // Handle redirects within this owner instead of allowing Chromium to carry
  // an authenticated request to another origin. Re-read registration for every
  // hop; removing a server fences an in-flight redirect chain too.
  for (let redirects = 0; redirects <= 20; redirects++) {
    if (registeredDesktopServer(server.id)?.baseUrl !== server.baseUrl) {
      return new Response("Server was removed", { status: 403 });
    }
    const nativeSession = desktopServerSession(server);
    // The assets renderer cannot read the registered server's CSRF cookie.
    // Keep the double-submit proof inside that same isolated cookie owner,
    // replacing any renderer-supplied token rather than mixing server sessions.
    headers.delete("x-myoxus-csrf-token");
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const cookies = await nativeSession.cookies.get({
        url: target.toString(),
      });
      const csrf = cookies.find(
        (cookie) => cookie.name === "myoxus_csrf_token",
      );
      if (csrf) headers.set("x-myoxus-csrf-token", csrf.value);
      if (registeredDesktopServer(server.id)?.baseUrl !== server.baseUrl)
        return new Response("Server was removed", { status: 403 });
    }
    const response = await nativeSession.fetch(target.toString(), {
      method,
      headers,
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : request.clone().body,
      credentials: "include",
      redirect: "manual",
      signal: request.signal,
      // Electron accepts streaming bodies using the Fetch Request contract.
      duplex: "half",
    } as RequestInit);
    await persistDesktopServerCookies(
      server,
      target.toString(),
      response.headers.getSetCookie(),
    );
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("set-cookie");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location)
      return new Response("Missing server redirect", { status: 502 });
    const next = new URL(location, target);
    if (next.origin !== server.baseUrl || next.username || next.password) {
      return new Response("Cross-server redirect rejected", { status: 403 });
    }
    if (
      (response.status === 303 && method !== "HEAD") ||
      ((response.status === 301 || response.status === 302) &&
        method === "POST")
    ) {
      method = "GET";
      headers.delete("content-type");
      headers.delete("content-length");
    }
    target = next;
  }
  return new Response("Too many server redirects", { status: 508 });
}
