/**
 * @vitest-environment happy-dom
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { openDialog } = vi.hoisted(() => ({
  openDialog: vi.fn(),
}));

vi.mock("@myoxus/core/components/hooks/use-catch-event-hook", () => ({
  useCatchEventCallback: (callback: (...args: any[]) => void) => callback,
}));

vi.mock("@myoxus/core/modules/server", () => ({
  AuthService: Symbol("AuthService"),
}));

vi.mock("@myoxus/core/modules/dialogs", () => ({
  GlobalDialogService: Symbol("GlobalDialogService"),
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    ({
      "com.myoxus.settings.sign": () => "Sign in",
      "com.myoxus.setting.sign.message": () => "Sign in to sync data",
      "com.myoxus.settingSidebar.title": () => "Settings",
      "com.myoxus.settingSidebar.settings.general": () => "General",
      "com.myoxus.settingSidebar.settings.workspace": () => "Workspace",
    }) as any,
}));

vi.mock("@myoxus/track", () => ({
  track: {
    $: {
      settingsPanel: {
        menu: {
          openSettings: () => undefined,
        },
      },
    },
  },
}));

vi.mock("@myoxus/infra", () => ({
  useLiveData: () => "unauthenticated",
  useService: () => ({
    open: openDialog,
    session: {
      account$: null,
      status$: null,
    },
  }),
}));

vi.mock("../general-setting", () => ({
  useGeneralSettingList: () => [],
}));

vi.mock("../workspace-setting", () => ({
  useWorkspaceSettingList: () => [],
}));

vi.mock("@myoxus/icons/react", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
}));

import { clearBrandIdentityCache } from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";

import { SignInButton } from "./index";

function renderSignInButton() {
  return render(
    <MyoxusUIProvider>
      <SignInButton />
    </MyoxusUIProvider>,
  );
}

describe("SettingSidebar SignInButton branding", () => {
  beforeEach(() => {
    openDialog.mockReset();
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

  test("renders product mark from runtime branding asset path", async () => {
    renderSignInButton();

    const image = await screen.findByRole("img", {
      name: "Myoxus Product Mark",
    });
    expect(image.getAttribute("src")).toBe(
      "/myoxus/style/product-mark.svg?v=runtime",
    );
    const signIn = screen.getByRole("button", {
      name: /Sign in Sign in to sync data/,
    });
    expect(signIn.contains(image)).toBe(true);
    expect(openDialog).not.toHaveBeenCalled();
    fireEvent.click(signIn);
    expect(openDialog).toHaveBeenCalledExactlyOnceWith("sign-in", {});
  });

  test("falls back to static product mark when runtime asset cannot be loaded", async () => {
    renderSignInButton();

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
