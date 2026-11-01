/**
 * Myoxus Service Worker
 *
 * Strategy:
 *   - Static assets (JS, CSS, fonts, images): release-cache-first
 *     Assets from older releases are never considered.
 *   - Navigation requests (HTML): network-first, offline fallback to /index.html
 *   - API / GraphQL / WebSocket: network-only (never cache)
 */

const BUILD_ID = "__MYOXUS_BUILD_ID__";
const CACHE_PREFIX = "myoxus-";
const STATIC_CACHE = `${CACHE_PREFIX}static-${BUILD_ID}`;
const OFFLINE_CACHE = `${CACHE_PREFIX}offline-${BUILD_ID}`;
const OFFLINE_URL = "/index.html";
const CURRENT_CACHES = new Set([STATIC_CACHE, OFFLINE_CACHE]);
const BUILD_ID_REQUEST = "myoxus:get-build-id";
const BUILD_ID_RESPONSE = "myoxus:build-id";

const CACHEABLE_EXTENSIONS = [
  ".js",
  ".mjs",
  ".css",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".svg",
  ".ico",
  ".gif",
];

function isStaticAsset(url) {
  const { pathname } = new URL(url);
  return CACHEABLE_EXTENSIONS.some(ext => pathname.endsWith(ext));
}

function isNavigationRequest(event) {
  return (
    event.request.mode === "navigate" ||
    (event.request.method === "GET" &&
      event.request.headers.get("Accept")?.includes("text/html"))
  );
}

function isNetworkOnlyRequest(url) {
  const { pathname } = new URL(url);
  return (
    pathname === "/graphql" ||
    pathname === "/mcp" ||
    pathname === "/api" ||
    pathname === "/rpc" ||
    pathname === "/socket.io" ||
    pathname === "/admin" ||
    pathname === "/adminfrontend" ||
    pathname === "/public" ||
    pathname === "/public-assets" ||
    pathname === "/share" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/rpc/") ||
    pathname.startsWith("/socket.io/") ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/adminfrontend/") ||
    pathname.startsWith("/public/") ||
    pathname.startsWith("/public-assets/") ||
    pathname.startsWith("/share/")
  );
}

self.addEventListener("message", event => {
  if (event.data?.type !== BUILD_ID_REQUEST) {
    return;
  }
  event.ports[0]?.postMessage({
    type: BUILD_ID_RESPONSE,
    buildId: BUILD_ID,
  });
});

async function cacheNetworkResponse(cache, request, response) {
  try {
    await cache.put(request, response.clone());
  } catch {
    // CacheStorage is optional: write failures must not discard a valid network
    // response or turn a successful shell fetch into offline fallback.
  }
}

async function fetchCurrentShell(request, cache = "no-store") {
  const response = await fetch(request, { cache });
  if (response.ok) {
    const offlineCache = await caches.open(OFFLINE_CACHE);
    await cacheNetworkResponse(offlineCache, OFFLINE_URL, response);
  }
  return response;
}

// Install: fetch the release's shell without consulting the HTTP cache.
self.addEventListener("install", event => {
  event.waitUntil(
    (async () => {
      const response = await fetchCurrentShell(OFFLINE_URL, "reload");
      if (!response.ok) {
        throw new Error(`Offline shell request failed with ${response.status}`);
      }
      await self.skipWaiting();
    })(),
  );
});

// Activate: remove only stale Myoxus release caches, never foreign storage.
self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            key => key.startsWith(CACHE_PREFIX) && !CURRENT_CACHES.has(key),
          )
          .map(key => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

// Fetch: apply routing strategy.
self.addEventListener("fetch", event => {
  const { request } = event;

  // Only handle GET requests.
  if (request.method !== "GET") {
    return;
  }

  // Never cache cross-origin requests or API calls.
  if (
    !request.url.startsWith(self.location.origin) ||
    isNetworkOnlyRequest(request.url)
  ) {
    return;
  }

  if (isNavigationRequest(event)) {
    // Network-first and keep the offline shell aligned with this release.
    event.respondWith(
      fetchCurrentShell(request).catch(async error => {
        const offlineCache = await caches.open(OFFLINE_CACHE);
        const cached = await offlineCache.match(OFFLINE_URL);
        if (cached) return cached;
        throw error;
      }),
    );
    return;
  }

  if (isStaticAsset(request.url)) {
    // Cache-first within the current release only.
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const cached = await cache.match(request);
        if (cached) {
          return cached;
        }
        const response = await fetch(request);
        if (response.ok) {
          await cacheNetworkResponse(cache, request, response);
        }
        return response;
      })(),
    );
  }
});
