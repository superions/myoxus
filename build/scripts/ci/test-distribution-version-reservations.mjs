// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertVersionFree } from "../release/assert-distribution-version-free.mjs";
test("published bytes reserve a version even when the source tag is absent", async () => {
  await assert.rejects(
    assertVersionFree(
      "clients",
      "0.41.19",
      async () => new Response("{}", { status: 200 }),
    ),
    /already has published/,
  );
  await assertVersionFree(
    "clients",
    "0.42.0",
    async () => new Response("", { status: 404 }),
  );
  await assert.rejects(
    assertVersionFree("containers", "0.41.18", async (url) =>
      url.includes("/token?")
        ? Response.json({ token: "synthetic-read-token" })
        : new Response("", { status: 200 }),
    ),
    /already has published/,
  );
  await assert.rejects(
    assertVersionFree(
      "clients",
      "0.42.0",
      async () => new Response("", { status: 503 }),
    ),
    /Cannot verify/,
  );
});
