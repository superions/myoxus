/**
 * Authentication helpers for E2E tests.
 *
 * All interactions go through the real HTTP API — no database access.
 * The admin account is bootstrapped via POST /api/setup/create-admin-user
 * (idempotent: the server returns 200 if the admin already exists).
 *
 * Regular users are created via the GraphQL mutation executed with
 * admin credentials.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  APIRequestContext,
  APIResponse,
  BrowserContext,
  Page,
} from "@playwright/test";

export const API_BASE =
  process.env.MYOXUS_API_BASE_URL ?? "http://localhost:3001";
export const FRONTEND_BASE =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
export const ADMIN_FRONTEND_BASE = `${FRONTEND_BASE}/adminfrontend`;

/** Credentials that tests share for the system admin account.
 *
 * These match the standard local dev dataset provisioned by
 * `build/scripts/test/seed-test-users.sh`.  Override via env vars
 * if you run the tests against a non-default environment.
 */
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@myoxus.local";
export const ADMIN_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD ?? "AdminMyoxus2026";
export const ADMIN_NAME = "Admin";
const AUTH_STATE_PATH =
  process.env.E2E_ADMIN_STORAGE_STATE ??
  path.join(
    process.cwd(),
    "playwright",
    ".cache",
    "myoxus-auth",
    "admin-storage-state.json",
  );

export type RequestStorageState = Awaited<
  ReturnType<APIRequestContext["storageState"]>
>;

type RequestFactory = {
  newContext: (options?: {
    storageState?: string | RequestStorageState;
  }) => Promise<APIRequestContext>;
};

let cachedAdminStorageStatePromise: Promise<RequestStorageState> | null = null;
const requestAdminCookieHeaders = new WeakMap<APIRequestContext, string>();

// ---------------------------------------------------------------------------
// Low-level API helpers
// ---------------------------------------------------------------------------

export interface ApiUser {
  id: string;
  name: string;
  email: string;
  password: string;
}

interface AltchaChallenge {
  algorithm: string;
  challenge: string;
  maxnumber?: number;
  salt: string;
  signature: string;
}

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
      return JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        number,
        salt: challenge.salt,
        signature: challenge.signature,
      });
    }
  }

  throw new Error(`Unable to solve CAPTCHA challenge up to ${maxNumber}`);
}

function hasSessionCookie(storageState: RequestStorageState): boolean {
  return storageState.cookies.some(
    (cookie) => cookie.name === "affine_session",
  );
}

function cookieHeaderFromStorageState(
  storageState: RequestStorageState,
): string {
  return storageState.cookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

async function readCachedAdminStorageState(): Promise<RequestStorageState | null> {
  try {
    const state = JSON.parse(
      await readFile(AUTH_STATE_PATH, "utf8"),
    ) as RequestStorageState;
    return hasSessionCookie(state) ? state : null;
  } catch {
    return null;
  }
}

async function writeCachedAdminStorageState(
  storageState: RequestStorageState,
): Promise<void> {
  await mkdir(path.dirname(AUTH_STATE_PATH), { recursive: true });
  await writeFile(AUTH_STATE_PATH, JSON.stringify(storageState, null, 2));
}

async function requestHasAdminSession(
  request: APIRequestContext,
): Promise<boolean> {
  const res = await request.post(`${API_BASE}/graphql`, {
    data: {
      query:
        "query AdminE2ESessionProbe { admin { adminDashboard { generatedAt } } }",
    },
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok()) return false;
  const body = await responseJsonOrNull(res);
  return !!body?.data?.admin?.adminDashboard && !body?.errors?.length;
}

async function storageStateHasAdminSession(
  request: APIRequestContext,
  storageState: RequestStorageState,
): Promise<boolean> {
  if (!hasSessionCookie(storageState)) return false;
  const res = await request.post(`${API_BASE}/graphql`, {
    data: {
      query:
        "query AdminE2EStorageStateProbe { admin { adminDashboard { generatedAt } } }",
    },
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeaderFromStorageState(storageState),
    },
  });
  if (!res.ok()) return false;
  const body = await responseJsonOrNull(res);
  return !!body?.data?.admin?.adminDashboard && !body?.errors?.length;
}

async function responseJsonOrNull(res: APIResponse): Promise<any | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function validateAdminStorageState(
  requestFactory: RequestFactory,
  storageState: RequestStorageState,
): Promise<boolean> {
  const probe = await requestFactory.newContext({ storageState });
  try {
    return await requestHasAdminSession(probe);
  } finally {
    await probe.dispose();
  }
}

async function createFreshAdminStorageState(
  requestFactory: RequestFactory,
): Promise<RequestStorageState> {
  const bootstrap = await requestFactory.newContext();
  try {
    await ensureAdminUserExists(bootstrap);
    // A rejected cache needs actual cookies, not ensureAdminUser's request-only header reuse.
    await apiSignIn(bootstrap, ADMIN_EMAIL, ADMIN_PASSWORD);
    const storageState = await bootstrap.storageState();
    if (!hasSessionCookie(storageState))
      throw new Error("Admin sign-in returned no session cookie");
    await writeCachedAdminStorageState(storageState);
    return storageState;
  } finally {
    await bootstrap.dispose();
  }
}

/**
 * Returns one reusable authenticated admin storage-state for the E2E run.
 *
 * Local stacks normally enable ALTCHA with strict per-account/per-IP limits.
 * Re-signing in for every spec file makes the tests fail for the wrong
 * reason. The cache lives under ignored `playwright/.cache/`, but every reuse
 * is still probed against the live GraphQL AdminRoot. That validation is
 * essential because logout E2Es intentionally invalidate a browser session and
 * must never leave later specs with a stale admin cookie.
 */
export async function getCachedAdminStorageState(
  requestFactory: RequestFactory,
): Promise<RequestStorageState> {
  let inMemory: RequestStorageState | null = null;
  if (cachedAdminStorageStatePromise) {
    try {
      inMemory = await cachedAdminStorageStatePromise;
    } catch {
      cachedAdminStorageStatePromise = null;
    }
  }
  if (inMemory && (await validateAdminStorageState(requestFactory, inMemory))) {
    return inMemory;
  }

  const cached = await readCachedAdminStorageState();
  if (cached && (await validateAdminStorageState(requestFactory, cached))) {
    cachedAdminStorageStatePromise = Promise.resolve(cached);
    return cached;
  }

  cachedAdminStorageStatePromise = createFreshAdminStorageState(requestFactory);
  return cachedAdminStorageStatePromise;
}

/**
 * Returns the sign-in CAPTCHA header when the running server requires ALTCHA.
 *
 * Local self-host stacks often enable CAPTCHA. API-level login helpers must
 * therefore follow the same server contract as the UI widget instead of
 * bypassing the protection and failing with CAPTCHA_MISSING_TOKEN.
 */
export async function captchaSignInHeaders(
  request: APIRequestContext,
): Promise<Record<string, string>> {
  const res = await request.get(`${API_BASE}/api/auth/challenge`, {
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

  const challenge = (await res.json()) as AltchaChallenge;
  return { "x-captcha-token": solveAltchaChallenge(challenge) };
}

/**
 * Ensures the admin user exists without creating a session.
 *
 * Global setup only needs this idempotent bootstrap step. Keeping it separate
 * from sign-in avoids consuming CAPTCHA per-account rate limits before the
 * actual test fixture creates the authenticated API context.
 */
export async function ensureAdminUserExists(
  request: APIRequestContext,
): Promise<void> {
  const res = await request.post(`${API_BASE}/api/setup/create-admin-user`, {
    data: {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      name: ADMIN_NAME,
    },
    headers: { "Content-Type": "application/json" },
  });
  // Accept: 200/201 (created), 403 ALREADY_INITIALIZED, 409 (duplicate)
  if (!res.ok() && res.status() !== 409 && res.status() !== 403) {
    throw new Error(
      `Failed to bootstrap admin user: ${res.status()} ${await res.text()}`,
    );
  }
}

/**
 * Ensures the admin user exists AND signs in with admin credentials so the
 * provided `request` context carries a valid admin session cookie for all
 * subsequent API / GraphQL calls.
 */
export async function ensureAdminUser(
  request: APIRequestContext,
): Promise<void> {
  await ensureAdminUserExists(request);

  if (await requestHasAdminSession(request)) {
    requestAdminCookieHeaders.delete(request);
    return;
  }

  const cached = await readCachedAdminStorageState();
  if (cached && (await storageStateHasAdminSession(request, cached))) {
    requestAdminCookieHeaders.set(
      request,
      cookieHeaderFromStorageState(cached),
    );
    return;
  }

  // Sign in so the request context carries a valid admin session cookie.
  // Playwright's APIRequestContext automatically stores Set-Cookie headers,
  // so all subsequent calls in this context will be authenticated.
  const signInRes = await request.post(`${API_BASE}/api/auth/sign-in`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    headers: {
      "Content-Type": "application/json",
      ...(await captchaSignInHeaders(request)),
    },
  });
  if (!signInRes.ok()) {
    throw new Error(
      `Admin sign-in failed after bootstrap: ${signInRes.status()} ${await signInRes.text()}`,
    );
  }
  requestAdminCookieHeaders.delete(request);
  await writeCachedAdminStorageState(await request.storageState());
}

/**
 * Signs in via `POST /api/auth/sign-in` and returns the Set-Cookie header
 * values so the caller can inject them into a BrowserContext.
 *
 * @returns Raw `Set-Cookie` header string array.
 */
export async function apiSignIn(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<string[]> {
  requestAdminCookieHeaders.delete(request);
  const res = await request.post(`${API_BASE}/api/auth/sign-in`, {
    data: { email, password },
    headers: {
      "Content-Type": "application/json",
      ...(await captchaSignInHeaders(request)),
    },
  });
  if (!res.ok()) {
    throw new Error(
      `Sign-in failed for ${email}: ${res.status()} ${await res.text()}`,
    );
  }
  requestAdminCookieHeaders.delete(request);
  return res
    .headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => header.value);
}

/**
 * Executes a GraphQL query/mutation against the running API using the
 * provided `APIRequestContext` (which carries any authentication cookies
 * previously set).
 */
export async function gqlRequest<T = unknown>(
  request: APIRequestContext,
  query: string,
  variables?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<T> {
  const cachedAdminCookie = requestAdminCookieHeaders.get(request);
  const res = await request.post(`${API_BASE}/graphql`, {
    data: { query, variables },
    headers: {
      "Content-Type": "application/json",
      ...(cachedAdminCookie ? { Cookie: cachedAdminCookie } : {}),
      ...headers,
    },
  });
  if (!res.ok()) {
    throw new Error(`GraphQL HTTP error: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  return body.data as T;
}

/**
 * Creates a regular (non-admin) user via the admin GraphQL API.
 * Returns the new user's id, email, and cleartext password.
 */
export async function createTestUser(
  request: APIRequestContext,
  overrides?: Partial<{ name: string; email: string; password: string }>,
): Promise<ApiUser> {
  // Use a timestamp suffix to avoid collisions across parallel runs.
  const suffix =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const email = overrides?.email ?? `e2e-user-${suffix}@myoxus.local`;
  const name = overrides?.name ?? `E2E User ${suffix}`;
  const password = overrides?.password ?? `TestPass_${suffix}!`;

  // The server exposes user creation under the admin namespace
  // (`admin { createUser }`), guarded by `ensure_admin`.  The caller must
  // therefore pass an admin-authenticated `request` context.
  const data = await gqlRequest<{
    admin: { createUser: { id: string; email: string; name: string } };
  }>(
    request,
    `mutation CreateE2EUser($input: CreateUserInput!) {
       admin {
         createUser(input: $input) {
           id
           email
           name
         }
       }
     }`,
    { input: { email, name, password } },
  );

  return { id: data.admin.createUser.id, email, name, password };
}

/**
 * Deletes a user previously created via `createTestUser`.  This wraps
 * `admin { deleteUser(id) { success } }` and tolerates "user not found"
 * errors so tests can call it unconditionally in their `afterAll` blocks
 * without race conditions if a previous step already removed the user.
 *
 * Tests **must** call this for every user they create — leaving orphaned
 * test users behind pollutes the dev DB and the admin Accounts page.
 */
export async function deleteTestUser(
  request: APIRequestContext,
  userId: string,
): Promise<void> {
  try {
    await gqlRequest<{ admin: { deleteUser: { success: boolean } } }>(
      request,
      `mutation DeleteE2EUser($id: String!) {
         admin {
           deleteUser(id: $id) {
             success
           }
         }
       }`,
      { id: userId },
    );
  } catch {
    // Swallow — afterAll cleanup must never fail the test.
  }
}

// ---------------------------------------------------------------------------
// Browser-level helpers
// ---------------------------------------------------------------------------

/**
 * Injects a real admin session into the browser context and opens the admin
 * dashboard. Admin-domain E2E tests exercise the target pages, not the shared
 * sign-in form; API sign-in keeps them stable across login UI/i18n changes.
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  const cached = await readCachedAdminStorageState();
  if (cached && (await storageStateHasAdminSession(page.request, cached))) {
    await page.context().addCookies(cached.cookies);
  } else {
    await ensureAdminUser(page.request);
    await injectRequestSessionCookies(page.context(), page.request);
  }
  await page.goto(`${ADMIN_FRONTEND_BASE}/dashboard`, {
    waitUntil: "networkidle",
  });
}

/**
 * Signs in a user through the main web frontend sign-in flow.
 * Assumes the web frontend presents an email + password form.
 */
export async function loginAsUser(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto(`${FRONTEND_BASE}/`);
  // Open sign-in modal / navigate to sign-in page
  const signinButton = page.locator('[data-testid="sidebar-user-avatar"]');
  if (await signinButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await signinButton.click({ delay: 200 });
  }
  await page.fill('[placeholder*="email" i], input[type="email"]', email);
  const continueBtn = page.locator('[data-testid="continue-login-button"]');
  if (await continueBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await continueBtn.click({ delay: 200 });
  }
  await page.fill(
    '[data-testid="password-input"], input[type="password"]',
    password,
  );
  await page.click('[data-testid="sign-in-button"], button[type="submit"]');
  // Wait for session to be established
  await page.waitForTimeout(2_000);
}

/**
 * Injects session cookies obtained from `apiSignIn` into a browser context
 * so that subsequent `page.goto()` calls are already authenticated.
 * This is faster than UI-based login and avoids flakiness from animated modals.
 */
export async function injectSessionCookies(
  context: BrowserContext,
  setCookieHeaders: string[],
): Promise<void> {
  for (const header of setCookieHeaders) {
    // Parse `name=value; Path=/; Domain=...; ...`
    const parts = header.split(";").map((s) => s.trim());
    const [nameValue, ...attrs] = parts;
    const eqIdx = nameValue.indexOf("=");
    const name = nameValue.slice(0, eqIdx);
    const value = nameValue.slice(eqIdx + 1);
    const attrMap: Record<string, string> = {};
    for (const attr of attrs) {
      const [k, v] = attr.split("=").map((s) => s.trim());
      attrMap[k.toLowerCase()] = v ?? "";
    }
    await context.addCookies([
      {
        name,
        value,
        domain: new URL(FRONTEND_BASE).hostname,
        path: attrMap["path"] || "/",
        httpOnly: header.toLowerCase().includes("httponly"),
        secure: header.toLowerCase().includes("secure"),
        sameSite: (attrMap["samesite"] as "Strict" | "Lax" | "None") ?? "Lax",
      },
    ]);
  }
}

/**
 * Mirrors the authenticated cookies from a Playwright APIRequestContext into a
 * browser context. This avoids a second `/api/auth/sign-in` call after
 * `ensureAdminUser()` has already authenticated the request context, which is
 * important on stacks with per-account CAPTCHA rate limits enabled.
 */
export async function injectRequestSessionCookies(
  context: BrowserContext,
  request: APIRequestContext,
): Promise<void> {
  const storageState = await request.storageState();
  if (storageState.cookies.length === 0) {
    throw new Error("Authenticated request context has no session cookies");
  }
  await context.addCookies(storageState.cookies);
}
