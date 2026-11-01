/**
 * E2E: CAPTCHA (P-Captcha-F) — API-level smoke covering the server-visible
 * invariants of the ALTCHA integration.
 *
 * Browser-widget interaction is deliberately NOT exercised here — the ALTCHA
 * custom element runs a real proof-of-work in a WebWorker, which is flaky and
 * slow in CI. The unit tests (`server/crates/application/src/captcha/`) and
 * the Rust integration tests (`server/crates/api/tests/captcha_endpoint_test.rs`)
 * cover the full solve/verify/replay/expiry/rotation path against the same
 * binary; this spec verifies only the HTTP contract as seen by a browser
 * client without trying to solve a PoW inside Playwright.
 *
 * Invariants:
 *   INV-CAPTCHA-07 (honeypot): a populated `website` field rejects sign-in
 *     with `CAPTCHA_HONEYPOT` BEFORE credentials are checked.
 *   INV-CAPTCHA-E (admin status auth): `/api/admin/captcha/status` returns
 *     401 to anonymous callers and an authenticated admin sees only the
 *     boolean `hmac_key_configured` (never the key itself).
 *
 * Prerequisites:
 *   - Stack running: build/scripts/server/stack-up.sh
 *   - Admin user seeded (ensured in beforeAll via /api/setup/create-admin-user)
 */

import { API_BASE, ensureAdminUser } from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

test.describe("captcha — honeypot + admin status", () => {
  test.beforeAll(async ({ request }) => {
    await ensureAdminUser(request);
  });

  test("honeypot field set on sign-in rejects with CAPTCHA_HONEYPOT", async ({
    request,
  }) => {
    const res = await request.post(`${API_BASE}/api/auth/sign-in`, {
      data: {
        email: "nobody@myoxus.local",
        password: "anything",
        website: "http://spam.example",
      },
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status(), "honeypot must reject with 400").toBe(400);
    const body = await res.json();
    expect(body.name).toBe("CAPTCHA_HONEYPOT");
  });

  test("admin captcha status requires authentication", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/admin/captcha/status`, {
      headers: { Accept: "application/json" },
    });
    expect(res.status(), "anonymous access must be 401").toBe(401);
  });

  test("admin captcha status never leaks hmac_key value", async ({
    adminRequest,
  }) => {
    const res = await adminRequest.get(`${API_BASE}/api/admin/captcha/status`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Contract: boolean `hmac_key_configured` is present.
    expect(typeof body.hmac_key_configured).toBe("boolean");
    // The raw key itself must never appear anywhere in the response body.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/hmac_key"\s*:\s*"[^"]+"/i);
    // Counter fields are numeric (cumulative since process start).
    expect(typeof body.verified_total).toBe("number");
    expect(typeof body.rejected_total).toBe("number");
    expect(typeof body.honeypot_total).toBe("number");
  });
});
