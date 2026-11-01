// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `virgultum-mermaid-block-http-helpers.ts`
 * — P-VIRG-ARCH-I-04f
 *
 * HTTP, GQL and auth helpers extracted
 * from `virgultum-mermaid-block.spec.ts`
 * (pre-I-04f lines 271-329). The 4
 * functions here (`cookieHeader`,
 * `nativeGql`, `injectCookies`,
 * `suppressOpenInApp`) are byte-for-byte
 * identical to the inline versions; the
 * move is a relocation, not a
 * reimplementation.
 *
 * **Why this file exists (slice
 * charter).** The pre-I-04f smoke spec
 * was 5371 lines, with 36+ helper
 * functions crowded into a 2474-line
 * pre-describe block (lines 271-2745).
 * I-04f..i splits that block into 4
 * sibling helper files (HTTP/Auth,
 * Doc/Assertions, Flowchart-Page,
 * Edgeless). I-04f is the first sub-slice
 * and contains the helpers that every
 * test() block depends on for sign-in
 * and GQL — landing it first unblocks
 * the other 3 sub-slices and makes the
 * dependency graph explicit.
 *
 * **Why `FRONTEND` and `GQL` are
 * re-declared here instead of imported
 * from the main spec.** The 2 constants
 * are module-private to the main spec
 * (no `export` keyword, lines 20-23).
 * Adding a re-export to the main spec
 * would force all 4 sub-slices to
 * coordinate their re-export ordering
 * (cf. E-02-style re-export risk in the
 * data-view kanban refactor). Re-
 * declaring the 2 constants locally keeps this executable helper independent
 * from the split declaration file. The browser journeys own endpoint behavior;
 * byte equality between test files is intentionally not a product gate.
 *
 * **Why `cookieHeader` is `function`
 * (not `const`) while the other 3 are
 * `async function`.** The 4 functions
 * preserve their original declaration
 * shape — `cookieHeader` is sync, the
 * other 3 are `async`. The byte-for-
 * byte charter forbids reformatting.
 *
 * **Why no `import` for the
 * `assert`-style helpers (`injectCookies`,
 * `suppressOpenInApp`)**. Both call
 * `context.addCookies` / `context.addInitScript`
 * from the Playwright `BrowserContext`
 * API, no extra imports needed.
 *
 * **Callers.** The 4 helpers are used
 * by 7 of the 7 test() blocks in the
 * main spec: every test signs in via
 * `injectCookies` + `suppressOpenInApp`
 * before any assertion, and the
 * `createDisposableDoc`/`cleanupDoc`
 * pair (I-04g) uses `nativeGql` to
 * issue the `deleteDocumentsPermanently`
 * GraphQL mutation. The 7 test() blocks
 * stay in the main spec unchanged; only
 * the import block at the top of the
 * main spec is edited.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md
 *      §I (P-VIRG-ARCH-I-04f)
 * @see docs/dev/virgultum/closeouts/phase-i.md
 *      (P-VIRG-ARCH-I-04f closeout)
 */

import type { APIRequestContext, BrowserContext } from "@playwright/test";

// Kept local so this helper can execute independently from the split
// declaration file. Browser requests validate these endpoints directly.
const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const GQL = `${FRONTEND}/graphql`;

export function cookieHeader(cookies: string[]): string {
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

export async function nativeGql<T>(
  request: APIRequestContext,
  cookies: string[],
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await request.post(GQL, {
    data: { query, variables },
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(cookies),
      "x-myoxus-client": "web-smoke",
      "x-myoxus-client-capabilities": "trash-cleanup",
      "x-myoxus-client-format": "myoxus-native",
    },
    timeout: 15_000,
  });
  if (!response.ok()) {
    throw new Error(
      `GraphQL HTTP ${response.status()}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { data?: T; errors?: unknown[] };
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  if (!body.data) throw new Error("GraphQL response did not contain data");
  return body.data;
}

export async function injectCookies(
  context: BrowserContext,
  rawCookies: string[],
): Promise<void> {
  for (const raw of rawCookies) {
    const [nameVal] = raw.split(";");
    const [name, ...rest] = nameVal.split("=");
    await context.addCookies([
      {
        name: name.trim(),
        value: rest.join("=").trim(),
        url: FRONTEND,
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);
  }
}

export async function suppressOpenInApp(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(() => {
    localStorage.setItem("global-state:open-link-mode", '"open-in-web"');
  });
}
