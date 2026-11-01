// SPDX-License-Identifier: AGPL-3.0-or-later

/** @vitest-environment happy-dom */

import { describe, expect, test } from "vitest";

import { linkIframe } from "./iframe-container";

describe("linkIframe", () => {
  test("renders locally while keeping preview content on an opaque origin", () => {
    const iframe = document.createElement("iframe");
    iframe.src = "https://stale.example/preview";
    iframe.sandbox.add("allow-same-origin");

    linkIframe(iframe, "<h1>Local preview</h1>");

    expect(iframe.getAttribute("src")).toBeNull();
    expect(iframe.srcdoc).toBe("<h1>Local preview</h1>");
    expect(iframe.sandbox.contains("allow-scripts")).toBe(true);
    expect(iframe.sandbox.contains("allow-same-origin")).toBe(false);
  });
});
