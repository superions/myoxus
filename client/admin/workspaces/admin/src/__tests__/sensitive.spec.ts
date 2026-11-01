/** @vitest-environment happy-dom */
import { describe, expect, test } from "vitest";

import { isSensitiveConfigField } from "../modules/settings/sensitive";

describe("isSensitiveConfigField", () => {
  test('returns true for a field key matching "password"', () => {
    expect(
      isSensitiveConfigField("mailer", "smtpPassword", { type: "String" }),
    ).toBe(true);
  });

  test('returns true for a field key matching "secret"', () => {
    expect(
      isSensitiveConfigField("oauth", "clientSecret", { type: "String" }),
    ).toBe(true);
  });

  test('returns true for a field key matching "token"', () => {
    expect(
      isSensitiveConfigField("server", "accessToken", { type: "String" }),
    ).toBe(true);
  });

  test('returns true when env var name contains "API_KEY"', () => {
    expect(
      isSensitiveConfigField("copilot", "provider", {
        type: "String",
        env: "OPENAI_API_KEY",
      }),
    ).toBe(true);
  });

  test('returns true when desc contains "webhook key"', () => {
    expect(
      isSensitiveConfigField("integrations", "hookValue", {
        type: "String",
        desc: "Webhook key for verification",
      }),
    ).toBe(true);
  });

  test("returns false for a non-sensitive String field", () => {
    expect(
      isSensitiveConfigField("server", "name", {
        type: "String",
        desc: "Server name",
      }),
    ).toBe(false);
  });

  test("returns false when type is not String even if key matches password", () => {
    expect(
      isSensitiveConfigField("auth", "password", { type: "Boolean" }),
    ).toBe(false);
  });

  test("returns false when type is Number", () => {
    expect(
      isSensitiveConfigField("server", "apiKeyCount", { type: "Number" }),
    ).toBe(false);
  });

  test("returns false when no descriptor is provided", () => {
    expect(isSensitiveConfigField("auth", "password")).toBe(false);
  });

  test("returns false for empty string field key with non-String type", () => {
    expect(isSensitiveConfigField("server", "", { type: "Boolean" })).toBe(
      false,
    );
  });
});
