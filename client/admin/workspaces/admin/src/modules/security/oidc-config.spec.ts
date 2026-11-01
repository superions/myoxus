// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import {
  applyOidcProviderPreset,
  equalOidcGroupDirectory,
  oidcMappingRuleError,
  normalizeOidcProviderConfig,
  serializeOidcProviderConfig,
  type OidcGroupDirectoryConfig,
} from "./oidc-config";

describe("OIDC config helpers", () => {
  test("keeps Custom endpoints explicit while still normalizing safe defaults", () => {
    const config = applyOidcProviderPreset(
      normalizeOidcProviderConfig({
        clientId: "client",
        clientSecret: "secret",
        authUrl: "https://idp.example.test/auth",
        tokenUrl: "https://idp.example.test/token",
        userinfoUrl: "https://idp.example.test/me",
      }),
      "custom",
    );

    expect(serializeOidcProviderConfig(config)).toMatchObject({
      authUrl: "https://idp.example.test/auth",
      tokenUrl: "https://idp.example.test/token",
      userinfoUrl: "https://idp.example.test/me",
      scopes: ["openid", "profile", "email"],
      claims: expect.objectContaining({ groupsSource: "userinfo" }),
    });
    expect(serializeOidcProviderConfig(config)).not.toHaveProperty(
      "groupDirectory",
    );

    const incomplete = { providerGroup: " Finance ", targetUnitId: "" };
    expect(oidcMappingRuleError(incomplete)).toBe(
      "admin.security.oauth.mapping-unit-required",
    );
    const manual = {
      providerGroup: "Manual transformed claim",
      targetUnitId: "existing-ou",
      role: "reader" as const,
    };
    expect(oidcMappingRuleError(manual)).toBeUndefined();
    const serialized = serializeOidcProviderConfig({
      ...config,
      groupMapping: { ...config.groupMapping, mappings: [incomplete, manual] },
    });
    expect(serialized.groupMapping.mappings).toEqual([
      { providerGroup: "Finance", targetUnitId: "", role: undefined },
      manual,
    ]);

    const directories: Array<OidcGroupDirectoryConfig | null> = [
      {
        type: "authentik",
        baseUrl: "https://idp.example.test/prefix",
        token: "***REDACTED***",
      },
      {
        type: "keycloak",
        baseUrl: "https://idp.example.test/prefix",
        realm: "Office",
        clientId: "ReadClient",
        clientSecret: "***REDACTED***",
        claimValueMode: "path",
      },
      null,
    ];
    for (const groupDirectory of directories) {
      const reordered =
        groupDirectory === null
          ? undefined
          : (Object.fromEntries(
              Object.entries(groupDirectory).reverse(),
            ) as OidcGroupDirectoryConfig);
      expect(equalOidcGroupDirectory(groupDirectory, reordered)).toBe(true);
      for (const preset of ["custom", "authentik", "keycloak"] as const) {
        const form = normalizeOidcProviderConfig({ ...config, groupDirectory });
        const saved = serializeOidcProviderConfig(
          applyOidcProviderPreset(form, preset),
        );
        expect(saved.groupDirectory).toEqual(groupDirectory);
      }
    }
  });
});
