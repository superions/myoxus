import { describe, expect, test } from "vitest";

import { connectionRetryDelay, normalizeSocketConnectError } from "../socket";

describe("Socket.IO connection retry contract", () => {
  test("normalizes typed admission errors without changing legacy errors", () => {
    const admission = normalizeSocketConnectError(
      new Error('{"code":"rate_limited","retryAfterMs":1250}'),
    );
    expect(admission.code).toBe("rate_limited");
    expect(admission.retryAfterMs).toBe(1250);

    const legacy = new Error("AUTHENTICATION_REQUIRED");
    expect(normalizeSocketConnectError(legacy)).toBe(legacy);
    expect(normalizeSocketConnectError(legacy).retryAfterMs).toBeUndefined();
  });

  test("rejects malformed retry values and caps untrusted server floors", () => {
    expect(
      normalizeSocketConnectError(
        new Error('{"code":"rate_limited","retryAfterMs":-1}'),
      ).retryAfterMs,
    ).toBeUndefined();
    expect(
      normalizeSocketConnectError(
        new Error('{"code":"temporarily_unavailable","retryAfterMs":999999}'),
      ).retryAfterMs,
    ).toBe(60_000);
  });

  test("keeps exponential jitter and never retries below the server floor", () => {
    expect(connectionRetryDelay(0, undefined, () => 0)).toBe(800);
    expect(connectionRetryDelay(3, undefined, () => 0.5)).toBe(8_000);
    expect(connectionRetryDelay(0, 10_000, () => 0)).toBe(10_000);
    expect(connectionRetryDelay(0, 10_000, () => 0.5)).toBe(11_000);
    expect(connectionRetryDelay(20, 60_000, () => 1)).toBe(72_000);
  });
});
