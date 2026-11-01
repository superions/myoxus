// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, test, vi } from "vitest";

import { fetchGlobalTlsSnapshot } from "./runtime-status-api";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../fetch-utils", () => ({ adminFetch: fetchMock }));
afterEach(() => fetchMock.mockReset());

function respond(detail: unknown, code = "tls_bootstrap_loaded") {
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        checks: [
          {
            name: "additional_ca_trust",
            status: "pass",
            code,
            detail: JSON.stringify(detail),
          },
        ],
      }),
    ),
  );
}

const empty = {
  source: "DEFAULT",
  source_key: "default.yaml",
  additional_ca_count: 0,
  legacy_git_ca_count: 0,
  snapshot_id: "library-public-roots",
  restart_required: true,
};

test("accepts the server startup shape without inventing a public-root count", async () => {
  respond(empty);
  expect(await fetchGlobalTlsSnapshot()).toMatchObject({
    additional_ca_count: 0,
    snapshot_id: "library-public-roots",
    legacy: false,
  });
  expect(fetchMock.mock.calls[0][0]).toBe("/ready");
});

test("preserves the explicit Git-only migration state", async () => {
  respond(
    { ...empty, legacy_git_ca_count: 2 },
    "tls_legacy_git_migration_required",
  );
  expect(await fetchGlobalTlsSnapshot()).toMatchObject({
    additional_ca_count: 0,
    legacy_git_ca_count: 2,
    legacy: true,
  });
});

test.each([
  null,
  {},
  { ...empty, additional_ca_count: -1 },
  { ...empty, additional_ca_count: "2" },
  { ...empty, restart_required: false },
])("rejects malformed or unconfirmed trust status %j", async (value) => {
  respond(value);
  await expect(fetchGlobalTlsSnapshot()).rejects.toThrow();
});

test("missing startup status cannot masquerade as empty trust", async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ status: "ok", checks: [] })),
  );
  await expect(fetchGlobalTlsSnapshot()).rejects.toThrow("unavailable");
});
