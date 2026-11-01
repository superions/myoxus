// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { APIRequestContext, APIResponse } from "@playwright/test";

interface AltchaChallenge {
  algorithm: string;
  challenge: string;
  maxnumber?: number;
  salt: string;
  signature: string;
}

interface CachedSession {
  apiBase: string;
  createdAt: string;
  email: string;
  setCookieHeaders: string[];
}

interface SessionProbeResponse {
  errors?: unknown[];
  data?: {
    currentUser?: {
      email?: string | null;
    } | null;
  } | null;
}

const AUTH_CACHE_DIR =
  process.env.E2E_WEB_SMOKE_AUTH_CACHE_DIR ??
  // Playwright clears `test-results` at the start of every run. Keep the
  // reusable Browser Web session outside that output dir so repeated smoke,
  // editor-flow or visual-evidence gates do not burn ALTCHA per-account
  // attempts. The env var keeps its historical smoke name for compatibility.
  path.join(process.cwd(), "playwright", ".cache", "myoxus-auth");

const signInPromises = new Map<string, Promise<string[]>>();

export function clearSmokeAuthSessionCache(): void {
  signInPromises.clear();
}

export const DEFAULT_SMOKE_USER_EMAIL =
  process.env.E2E_USER_EMAIL ??
  process.env.E2E_ADMIN_EMAIL ??
  "admin@myoxus.local";

export const DEFAULT_SMOKE_USER_PASSWORD =
  process.env.E2E_USER_PASSWORD ??
  process.env.E2E_ADMIN_PASSWORD ??
  "AdminMyoxus2026";

function hashAlgorithm(algorithm: string): "sha256" | "sha384" | "sha512" {
  const normalized = algorithm.toLowerCase().replace(/-/g, "");
  if (
    normalized === "sha256" ||
    normalized === "sha384" ||
    normalized === "sha512"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported CAPTCHA algorithm: ${algorithm}`);
}

function solveAltchaChallenge(challenge: AltchaChallenge): string {
  const algorithm = hashAlgorithm(challenge.algorithm);
  const maxNumber = challenge.maxnumber ?? 100_000;

  for (let number = 0; number <= maxNumber; number++) {
    const candidate = createHash(algorithm)
      .update(`${challenge.salt}${number}`)
      .digest("hex");
    if (candidate === challenge.challenge) {
      const payload = JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        number,
        salt: challenge.salt,
        signature: challenge.signature,
      });
      // The browser widget sends base64 JSON; smoke auth must exercise the
      // same HTTP contract instead of the Rust-only raw JSON shortcut.
      return Buffer.from(payload, "utf8").toString("base64");
    }
  }

  throw new Error(`Unable to solve CAPTCHA challenge up to ${maxNumber}`);
}

function cacheKey(apiBase: string, email: string): string {
  return `${apiBase}\n${email}`.toLowerCase();
}

function cacheFilePath(apiBase: string, email: string): string {
  const digest = createHash("sha256")
    .update(cacheKey(apiBase, email))
    .digest("hex")
    .slice(0, 16);
  // Keep the existing prefix stable so local dev machines do not invalidate
  // cached sessions when the browser suites are reorganized.
  return path.join(AUTH_CACHE_DIR, `web-smoke-${digest}.json`);
}

function cookieHeader(setCookieHeaders: string[]): string {
  return setCookieHeaders.map((cookie) => cookie.split(";")[0]).join("; ");
}

function cookieValue(setCookieHeaders: string[], name: string): string | null {
  for (const raw of setCookieHeaders) {
    const [nameVal] = raw.split(";");
    const [key, ...rest] = nameVal.split("=");
    if (key.trim() === name) {
      return rest.join("=").trim();
    }
  }
  return null;
}

async function readCachedSession(
  apiBase: string,
  email: string,
): Promise<string[] | null> {
  try {
    const cached = JSON.parse(
      await readFile(cacheFilePath(apiBase, email), "utf8"),
    ) as CachedSession;
    if (
      cached.apiBase !== apiBase ||
      cached.email.toLowerCase() !== email.toLowerCase() ||
      cached.setCookieHeaders.length === 0
    ) {
      return null;
    }
    return cached.setCookieHeaders;
  } catch {
    return null;
  }
}

async function writeCachedSession(
  apiBase: string,
  email: string,
  setCookieHeaders: string[],
): Promise<void> {
  await mkdir(AUTH_CACHE_DIR, { recursive: true });
  await writeFile(
    cacheFilePath(apiBase, email),
    JSON.stringify(
      {
        apiBase,
        createdAt: new Date().toISOString(),
        email,
        setCookieHeaders,
      } satisfies CachedSession,
      null,
      2,
    ),
  );
}

async function hasValidSession(
  request: APIRequestContext,
  apiBase: string,
  email: string,
  setCookieHeaders: string[],
): Promise<boolean> {
  if (
    !setCookieHeaders.some((cookie) => cookie.startsWith("affine_session="))
  ) {
    return false;
  }

  const res = await request.post(`${apiBase}/graphql`, {
    data: {
      query: "query WebSmokeSessionProbe { currentUser { email } }",
    },
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(setCookieHeaders),
    },
  });
  if (!res.ok()) return false;
  const body = await optionalJson<SessionProbeResponse>(res);
  return (
    !body?.errors?.length &&
    body?.data?.currentUser?.email?.toLowerCase() === email.toLowerCase()
  );
}

async function optionalJson<T>(res: APIResponse): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Smoke tests log in through the real public API. When the local stack enforces
 * ALTCHA, the tests must solve the same challenge as the browser widget instead
 * of silently relying on a CAPTCHA-disabled environment.
 */
async function captchaHeaders(
  request: APIRequestContext,
  apiBase: string,
): Promise<Record<string, string>> {
  const res = await request.get(`${apiBase}/api/auth/challenge`, {
    headers: { Accept: "application/json" },
  });
  if (res.status() === 503) {
    return {};
  }
  if (!res.ok()) {
    throw new Error(
      `Failed to fetch CAPTCHA challenge: ${res.status()} ${await res.text()}`,
    );
  }

  return {
    "x-captcha-token": solveAltchaChallenge(
      (await res.json()) as AltchaChallenge,
    ),
  };
}

export async function signInViaApi(
  request: APIRequestContext,
  apiBase: string,
  email: string,
  password: string,
): Promise<string[]> {
  const key = cacheKey(apiBase, email);
  signInPromises.set(
    key,
    signInPromises.get(key) ??
      (async () => {
        const cached = await readCachedSession(apiBase, email);
        if (
          cached &&
          (await hasValidSession(request, apiBase, email, cached))
        ) {
          return cached;
        }

        const fresh = await signInViaApiUncached(
          request,
          apiBase,
          email,
          password,
        );
        await writeCachedSession(apiBase, email, fresh);
        return fresh;
      })(),
  );

  return signInPromises.get(key)!;
}

async function signInViaApiUncached(
  request: APIRequestContext,
  apiBase: string,
  email: string,
  password: string,
): Promise<string[]> {
  const res = await request.post(`${apiBase}/api/auth/sign-in`, {
    data: { email, password },
    headers: {
      "Content-Type": "application/json",
      ...(await captchaHeaders(request, apiBase)),
    },
  });
  if (!res.ok()) {
    throw new Error(
      `Sign-in failed for ${email}: HTTP ${res.status()} ${await res.text()}`,
    );
  }
  return res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value);
}

export async function signOutViaApi(
  request: APIRequestContext,
  apiBase: string,
  setCookieHeaders: string[] | undefined,
): Promise<void> {
  if (!setCookieHeaders?.length) return;
  const csrf = cookieValue(setCookieHeaders, "myoxus_csrf_token");
  if (!csrf) return;

  const res = await request.post(`${apiBase}/api/auth/sign-out`, {
    headers: {
      Cookie: cookieHeader(setCookieHeaders),
      "x-myoxus-csrf-token": csrf,
    },
  });
  if (!res.ok()) {
    throw new Error(
      `Sign-out failed: HTTP ${res.status()} ${await res.text()}`,
    );
  }
  signInPromises.clear();
}
