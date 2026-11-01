// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { responseCookieMutations } from "../../src/main/response-cookies";

describe("Electron response cookie projection", () => {
  test("maps typed parser output to Electron cookie details", () => {
    const expires = "Wed, 01 Jan 2031 00:00:00 GMT";

    expect(
      responseCookieMutations(
        `session=value; Domain=.myoxus.example; Path=/; Expires=${expires}; HttpOnly; Secure; SameSite=Lax`,
        "https://app.myoxus.example/graphql",
      ),
    ).toEqual([
      {
        type: "set",
        details: {
          url: "https://app.myoxus.example/graphql",
          name: "session",
          value: "value",
          domain: ".myoxus.example",
          path: "/",
          expirationDate: Date.parse(expires) / 1_000,
          httpOnly: true,
          secure: true,
          sameSite: "lax",
        },
      },
    ]);
  });

  test("persists server session cookies from Max-Age", () => {
    const now = Date.parse("2026-09-01T12:00:00.000Z");

    expect(
      responseCookieMutations(
        "affine_session=value; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000",
        "https://app.myoxus.example/api/auth/sign-in",
        now,
      ),
    ).toEqual([
      {
        type: "set",
        details: {
          url: "https://app.myoxus.example/api/auth/sign-in",
          name: "affine_session",
          value: "value",
          domain: undefined,
          path: "/",
          expirationDate: now / 1_000 + 2_592_000,
          httpOnly: true,
          secure: undefined,
          sameSite: "lax",
        },
      },
    ]);
  });

  test("lets Max-Age override Expires and removes expired cookies", () => {
    const now = Date.parse("2026-09-01T12:00:00.000Z");

    expect(
      responseCookieMutations(
        "session=value; Path=/; Max-Age=60; Expires=Wed, 01 Jan 2031 00:00:00 GMT",
        "https://app.myoxus.example/graphql",
        now,
      )[0],
    ).toMatchObject({
      type: "set",
      details: { expirationDate: now / 1_000 + 60 },
    });
    expect(
      responseCookieMutations(
        "session=value; Path=/; Max-Age=0",
        "https://app.myoxus.example/graphql",
        now,
      ),
    ).toEqual([
      {
        type: "remove",
        name: "session",
        url: "https://app.myoxus.example/graphql",
      },
    ]);
  });

  test("projects an empty response cookie as a session removal", () => {
    expect(
      responseCookieMutations(
        "session=; Path=/; Max-Age=0",
        "https://app.myoxus.example/graphql",
      ),
    ).toEqual([
      {
        type: "remove",
        name: "session",
        url: "https://app.myoxus.example/graphql",
      },
    ]);
  });
});
