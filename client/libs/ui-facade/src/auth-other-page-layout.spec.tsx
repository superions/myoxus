// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MyoxusOtherPageLayout } from "./index";
import { MyoxusUIProvider } from "./provider";

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    "com.myoxus.auth.open.myoxus.download-app": () => "Download app",
  }),
}));

function renderLayout(
  props: Partial<Parameters<typeof MyoxusOtherPageLayout>[0]> = {},
) {
  return render(
    <MyoxusUIProvider>
      <MyoxusOtherPageLayout {...props}>
        <main>Auth surface</main>
      </MyoxusOtherPageLayout>
    </MyoxusUIProvider>,
  );
}

describe("MyoxusOtherPageLayout", () => {
  beforeEach(() => {
    vi.stubGlobal("BUILD_CONFIG", {
      downloadUrl: "https://example.invalid/download",
      isElectron: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      }),
    );
    vi.stubGlobal("open", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("keeps the download action visible by default for Web auth surfaces", () => {
    renderLayout();

    expect(screen.getByRole("button", { name: "Download app" })).not.toBeNull();
  });

  test("allows Admin bootstrap surfaces to hide the download action", () => {
    renderLayout({ showDownloadAction: false });

    expect(screen.queryByRole("button", { name: "Download app" })).toBeNull();
    expect(screen.getByText("Auth surface")).not.toBeNull();
  });

  test("uses the caller-provided download URL", () => {
    renderLayout({
      downloadUrl: "https://example.invalid/custom-download",
    });

    fireEvent.click(screen.getByRole("button", { name: "Download app" }));
    expect(globalThis.open).toHaveBeenCalledWith(
      "https://example.invalid/custom-download",
      "_blank",
    );
  });
});
