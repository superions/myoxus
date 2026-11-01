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
import { type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { requestSignIn, openDialog } = vi.hoisted(() => ({
  requestSignIn: vi.fn(),
  openDialog: vi.fn(),
}));

vi.mock("@myoxus/core/modules/server", () => ({
  AuthService: class AuthService {},
  DefaultServerService: class DefaultServerService {},
}));

vi.mock("@myoxus/core/modules/dialogs", () => ({
  GlobalDialogService: Symbol("GlobalDialogService"),
}));

vi.mock("@myoxus/graphql", () => ({
  ServerDeploymentType: { Cloud: "Cloud", Standalone: "Standalone" },
  ServerFeature: {
    LocalWorkspace: "LocalWorkspace",
  },
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    ({
      "com.myoxus.workspace.cloud.auth": () => "Sign in",
      "com.myoxus.workspace.cloud.description": () => "Use cloud sync",
    }) as any,
}));

vi.mock("@myoxus/track", () => ({
  track: {
    $: {
      navigationPanel: {
        workspaceList: {
          requestSignIn,
          createWorkspace: vi.fn(),
        },
      },
    },
  },
}));

vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  return {
    ...actual,
    useLiveData: () => ({ status: "authenticated" }),
    useService: () => ({
      session: { session$: new actual.LiveData({ status: "authenticated" }) },
      open: openDialog,
      server: {
        config$: {
          value: {
            features: [],
          },
        },
      },
    }),
  };
});

vi.mock("./add-workspace", () => ({
  AddWorkspace: ({ onNewWorkspace }: { onNewWorkspace: () => void }) => (
    <button onClick={onNewWorkspace}>New workspace</button>
  ),
}));

vi.mock("./workspace-list", () => ({
  MyoxusWorkspaceList: () => null,
}));

import { clearBrandIdentityCache } from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";

import { SignInItem } from "./index";

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("SignInItem branding", () => {
  beforeEach(() => {
    requestSignIn.mockReset();
    openDialog.mockReset();
    (globalThis as any).environment = {
      subPath: "/myoxus",
    };
    clearBrandIdentityCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url === "/myoxus/api/branding/app-server.json") {
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
    vi.unstubAllGlobals();
  });

  test("renders product mark from runtime branding path", async () => {
    renderWithProvider(<SignInItem />);

    const image = await screen.findByRole("img", {
      name: "Myoxus Product Mark",
    });
    expect(image.getAttribute("src")).toBe(
      "/myoxus/style/product-mark.svg?v=runtime",
    );
    expect(screen.getByText("Sign in")).toBeTruthy();
    expect(screen.getByText("Use cloud sync")).toBeTruthy();
  });

  test("falls back to static product mark when runtime asset cannot be loaded", async () => {
    renderWithProvider(<SignInItem />);
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

  test("tracks and opens sign-in dialog on click", () => {
    renderWithProvider(<SignInItem />);
    fireEvent.click(screen.getByTestId("cloud-signin-button"));

    expect(requestSignIn).toHaveBeenCalledTimes(1);
    expect(openDialog).toHaveBeenCalledWith("sign-in", {});
  });
});
