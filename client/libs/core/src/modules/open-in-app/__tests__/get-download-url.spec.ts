import { expect, test } from "vitest";

import { getDownloadUrl } from "../get-download-url-pure";

test("returns server URL when set", () => {
  const result = getDownloadUrl({
    client: { downloadUrl: "https://myserver.example.com/get" },
  });
  expect(result).toBe("https://myserver.example.com/get");
});

test("falls back to BUILD_CONFIG when server URL is empty string", () => {
  const result = getDownloadUrl({ client: { downloadUrl: "" } });
  expect(result).toBe(BUILD_CONFIG.downloadUrl);
});

test("falls back to BUILD_CONFIG when server URL is undefined or null", () => {
  expect(getDownloadUrl(null)).toBe(BUILD_CONFIG.downloadUrl);
  expect(getDownloadUrl(undefined)).toBe(BUILD_CONFIG.downloadUrl);
  expect(getDownloadUrl({ client: { downloadUrl: undefined } })).toBe(
    BUILD_CONFIG.downloadUrl,
  );
});
