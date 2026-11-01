/**
 * @vitest-environment happy-dom
 */
import { clearBrandIdentityCache } from "@myoxus/ui-facade";
import { MyoxusSettingsMantineProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tokens = {
    auth: Symbol("AuthService"),
    editor: Symbol("EditorService"),
  };
  const streams = {
    presenting: Symbol("presenting"),
    loginStatus: Symbol("loginStatus"),
  };
  return {
    tokens,
    streams,
    state: {
      isPresent: false,
      loginStatus: "unauthenticated",
    },
  };
});

vi.mock("@myoxus/core/modules/server", () => ({
  AuthService: mocks.tokens.auth,
}));

vi.mock("@myoxus/core/modules/editor", () => ({
  EditorService: mocks.tokens.editor,
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    ({
      "com.myoxus.share-page.footer.built-with": () => "Built with",
    }) as any,
}));

vi.mock("@myoxus/infra", () => ({
  useService: (token: unknown) => {
    if (token === mocks.tokens.editor) {
      return {
        editor: {
          isPresenting$: mocks.streams.presenting,
        },
      };
    }
    if (token === mocks.tokens.auth) {
      return {
        session: {
          status$: mocks.streams.loginStatus,
        },
      };
    }
    return {};
  },
  useLiveData: (stream: unknown) => {
    if (stream === mocks.streams.presenting) {
      return mocks.state.isPresent;
    }
    if (stream === mocks.streams.loginStatus) {
      return mocks.state.loginStatus;
    }
    return null;
  },
}));

import { SharePageBrandingFooter } from "./share-page-branding-footer";

const renderWithProvider = () =>
  render(
    <MyoxusSettingsMantineProvider>
      <SharePageBrandingFooter />
    </MyoxusSettingsMantineProvider>,
  );

describe("SharePageBrandingFooter", () => {
  beforeEach(() => {
    clearBrandIdentityCache();
    mocks.state.isPresent = false;
    mocks.state.loginStatus = "unauthenticated";
    (globalThis as any).environment = {
      subPath: "/myoxus",
    };
    (globalThis as any).BUILD_CONFIG = {
      websiteUrl: "https://example.invalid",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          appServerBranding: {
            productMark: {
              publicUrl: "/style/product-mark.svg?v=runtime",
            },
          },
        }),
      })),
    );
  });

  afterEach(() => {
    cleanup();
    clearBrandIdentityCache();
    vi.unstubAllGlobals();
  });

  test("renders branding link with runtime product mark", async () => {
    renderWithProvider();

    const link = screen.getByRole("link", { name: /built with/i });
    expect(link.getAttribute("href")).toBe("https://example.invalid");
    expect(link.dataset.myoxusUiRole).toBe("public-share-floating-brand-link");
    const image = await screen.findByRole("img", {
      name: "Myoxus Product Mark",
    });
    expect(image.getAttribute("src")).toBe(
      "/myoxus/style/product-mark.svg?v=runtime",
    );
  });

  test("hides footer while presenting", () => {
    mocks.state.isPresent = true;
    renderWithProvider();

    expect(screen.queryByRole("link", { name: /built with/i })).toBeNull();
  });

  test("hides footer for authenticated users", () => {
    mocks.state.loginStatus = "authenticated";
    renderWithProvider();

    expect(screen.queryByRole("link", { name: /built with/i })).toBeNull();
  });

  test("falls back to static product mark if runtime asset fails to load", async () => {
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
