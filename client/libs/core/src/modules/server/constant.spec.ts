// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const source = readFileSync(
  fileURLToPath(new URL("./constant.ts", import.meta.url)),
  "utf8",
);

describe("built-in server capability fallbacks", () => {
  test.each(["stable", "beta", "internal"])(
    "native %s starts without a synthetic server",
    async (appBuildType) => {
      vi.stubGlobal("BUILD_CONFIG", {
        isNative: true,
        isElectron: true,
        appBuildType,
      });
      vi.resetModules();
      const { BUILD_IN_SERVERS } = await import("./constant");
      expect(BUILD_IN_SERVERS).toEqual([]);
    },
  );

  test("Web keeps the serving origin independently of release channel", async () => {
    vi.stubGlobal("BUILD_CONFIG", {
      isNative: false,
      appBuildType: "internal",
    });
    vi.stubGlobal("environment", { isSelfHosted: true });
    vi.stubGlobal("location", { origin: "https://web.example" });
    vi.resetModules();
    const { BUILD_IN_SERVERS } = await import("./constant");
    expect(BUILD_IN_SERVERS).toHaveLength(1);
    expect(BUILD_IN_SERVERS[0]).toMatchObject({
      id: "myoxus-cloud",
      baseUrl: location.origin,
    });
  });

  test("the client model cannot restore channel-derived destinations", () => {
    expect(source).not.toMatch(
      /appBuildType|getOfficialTelemetryEndpoint|https?:\/\/(?:app|insider)\.myoxus\./,
    );
    for (const owner of [
      "../telemetry/services/telemetry.ts",
      "../../../../../apps/electron/src/main/protocol.ts",
      "../../../../../apps/electron/src/main/server-routing.ts",
      "../../../../../apps/electron/src/main/security/redirect-proxy.ts",
    ]) {
      expect(readFileSync(new URL(owner, import.meta.url), "utf8")).not.toMatch(
        /https?:\/\/(?:app|insider)\.myoxus\./,
      );
    }
  });
  test("do not advertise unconfigured product capabilities", () => {
    expect(source).not.toContain("OAuthProviderType.Google");
    expect(source).not.toContain("OAuthProviderType.Apple");
    expect(source).not.toContain("ServerFeature.");
  });

  test("use neutral fallback names until server config is loaded", () => {
    expect(source).not.toContain("Myoxus Cloud");
    expect(source).toContain("Myoxus Server");
  });
});
