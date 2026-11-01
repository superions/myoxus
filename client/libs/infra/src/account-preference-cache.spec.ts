// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from "vitest";

import { readCachedTelemetryPreference } from "./account-preference-cache";

const storage = (entries: Record<string, string>): Storage => {
  const values = new Map(Object.entries(entries));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
};

describe("readCachedTelemetryPreference", () => {
  test("keeps a valid account opt-out when another cache record is malformed", () => {
    const cache = storage({
      "global-state:broken-auth": "{",
      "global-state:private-auth": JSON.stringify({
        account: { id: "user-private" },
      }),
      "global-state:user-preferences:private:user-private": JSON.stringify({
        confirmedEffectiveValues: { telemetryEnabled: true },
        pendingPatch: { telemetryEnabled: false },
      }),
    });

    expect(readCachedTelemetryPreference(cache)).toBe(false);
  });
});
