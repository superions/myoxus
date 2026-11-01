/**
 * @vitest-environment happy-dom
 */
import { clearBrandIdentityCache } from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ChatLoadingState } from "./loading-state";

function renderWithProvider(title = "Loading chat history") {
  return render(
    <MyoxusUIProvider>
      <ChatLoadingState title={title} />
    </MyoxusUIProvider>,
  );
}

describe("ChatLoadingState branding", () => {
  beforeEach(() => {
    (globalThis as any).environment = {
      subPath: "/myoxus",
    };
    clearBrandIdentityCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        if (String(input) === "/myoxus/api/branding/app-server.json") {
          return {
            ok: true,
            json: async () => ({
              appServerBranding: {
                productMark: { publicUrl: "/style/product-mark.svg?v=runtime" },
              },
            }),
          } as Response;
        }

        return { ok: false, json: async () => ({}) } as Response;
      }),
    );
  });

  afterEach(() => {
    cleanup();
    clearBrandIdentityCache();
    vi.unstubAllGlobals();
  });

  test("renders runtime product mark icon", async () => {
    renderWithProvider();

    const image = await screen.findByRole("img", {
      name: "Myoxus Product Mark",
    });
    expect(image.getAttribute("src")).toBe(
      "/myoxus/style/product-mark.svg?v=runtime",
    );
    expect(screen.getByText("Loading chat history")).toBeTruthy();
    expect(
      document.querySelector('[data-myoxus-ui-role="chat-panel-loading"]'),
    ).toBeTruthy();
  });

  test("falls back to static product mark when runtime asset fails to load", async () => {
    renderWithProvider();

    const image = await screen.findByRole("img", {
      name: "Myoxus Product Mark",
    });
    fireEvent.error(image);

    await waitFor(() => {
      const fallbackImage = screen.getByRole("img", {
        name: "Myoxus Product Mark",
      });
      expect(fallbackImage.getAttribute("src")).toBe(
        "/myoxus/style/product-mark.svg",
      );
    });
  });
});
