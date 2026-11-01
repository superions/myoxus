import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

const REPO_ROOT = `${process.cwd()}/`;
const fallback = JSON.parse(
  readFileSync(
    `${REPO_ROOT}client/branding/brand-identity-fallback.json`,
    "utf8",
  ),
);

describe("brand identity static fallback", () => {
  test("is generated without drift", () => {
    expect(() =>
      execFileSync(
        "node",
        [
          "build/scripts/branding/export-brand-identity-fallback.mjs",
          "--check",
        ],
        { cwd: REPO_ROOT, stdio: "pipe" },
      ),
    ).not.toThrow();
  });

  test("contains cache-busted local app/server assets only", () => {
    expect(fallback).toMatchObject({
      schemaVersion: 1,
      appServerBranding: {
        logo: {
          publicUrl: expect.stringMatching(
            /^\/style\/logo\.svg\?v=[0-9a-f]{16}$/u,
          ),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
        productMark: {
          publicUrl: expect.stringMatching(
            /^\/style\/product-mark\.svg\?v=[0-9a-f]{16}$/u,
          ),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
        faviconPack: {
          publicUrl: expect.stringMatching(
            /^\/favicon-192\.png\?v=[0-9a-f]{16}$/u,
          ),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      },
    });

    const json = JSON.stringify(fallback);
    expect(json).not.toMatch(/https?:\/\//iu);
    expect(json).not.toMatch(/\bcdn\b/iu);
    expect(json).not.toMatch(/\baffine\b/iu);
  });

  test("keeps favicon metadata in the app/server branding boundary", () => {
    const faviconSizes = fallback.favicons
      .filter((entry: { sizePx?: number }) => typeof entry.sizePx === "number")
      .map((entry: { sizePx: number }) => entry.sizePx);
    expect(faviconSizes).toEqual([32, 36, 48, 72, 96, 144, 192]);
    expect(fallback.favicons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storageKey: "favicon-32.png",
          publicUrl: expect.stringMatching(/^\/favicon-32\.png\?v=/u),
          sizePx: 32,
        }),
        expect.objectContaining({
          storageKey: "favicon-192.png",
          publicUrl: expect.stringMatching(/^\/favicon-192\.png\?v=/u),
          sizePx: 192,
        }),
      ]),
    );
    expect(JSON.stringify(fallback)).not.toMatch(
      /pdf|themeProfile|typography/iu,
    );
  });
});
