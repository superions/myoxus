// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {
  DATABASE_CONFLICT_ERROR_NAMES,
  GraphQLError,
  UserFriendlyError,
} from "@myoxus/error";
import { describe, expect, test } from "vitest";

import { shouldNotifySWRFailure } from "./swr-config-provider";

function normalizedError(code: string): UserFriendlyError {
  return UserFriendlyError.fromAny(
    new GraphQLError("request failed", {
      extensions: { code, name: code, type: code },
    }),
  );
}

describe("SWR failure notification policy", () => {
  test.each(DATABASE_CONFLICT_ERROR_NAMES)(
    "leaves %s exclusively to the Database resolution modal",
    (code) => {
      expect(shouldNotifySWRFailure(normalizedError(code), {})).toBe(false);
    },
  );

  test("does not classify a similar unknown code as a handled conflict", () => {
    expect(
      shouldNotifySWRFailure(normalizedError("MIX_DATABASE_CONFLICT"), {}),
    ).toBe(true);
  });

  test("keeps ordinary transport failures visible", () => {
    expect(shouldNotifySWRFailure(normalizedError("BAD_REQUEST"), {})).toBe(
      true,
    );
  });

  test("honours route-owned error-state suppression", () => {
    expect(
      shouldNotifySWRFailure(normalizedError("BAD_REQUEST"), {
        suppressErrorNotification: true,
      }),
    ).toBe(false);
  });
});
