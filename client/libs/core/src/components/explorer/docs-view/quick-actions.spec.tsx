/**
 * @vitest-environment happy-dom
 */
import { ConfirmModalProvider } from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createDocExplorerContext, DocExplorerContext } from "../context";
import { QuickDeletePermanently } from "./quick-actions";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  guardCan: vi.fn(),
  permanentlyDeletePage: vi.fn(),
}));

vi.mock("@myoxus/core/modules/permissions", () => ({
  GuardService: class GuardService {},
}));

vi.mock("@myoxus/core/components/hooks/myoxus/use-document-operations", () => ({
  useDocumentOperations: () => ({
    permanentlyDeletePage: mocks.permanentlyDeletePage,
  }),
}));

vi.mock("@myoxus/i18n", async (original) => ({
  ...(await original<typeof import("@myoxus/i18n")>()),
  useI18n: () =>
    new Proxy(
      {
        t: (key: string) => key,
      },
      {
        get(target, property: string) {
          if (property in target) {
            return target[property as keyof typeof target];
          }
          return () => property;
        },
      },
    ),
}));

vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useService: (service: { name?: string }) => {
    if (service.name === "GuardService") {
      return {
        can: mocks.guardCan,
      };
    }
    throw new Error(`unexpected service ${String(service.name)}`);
  },
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/ui-facade")>();
  return {
    ...actual,
    notify: vi.fn(),
  };
});

describe("QuickDeletePermanently", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test("keeps the confirm flow pending until the acknowledged permanent delete resolves", async () => {
    let resolveDelete!: () => void;
    mocks.guardCan.mockResolvedValue(true);
    mocks.permanentlyDeletePage.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const explorerContext = createDocExplorerContext({
      quickDeletePermanently: true,
    });

    render(
      <MyoxusUIProvider>
        <ConfirmModalProvider>
          <DocExplorerContext.Provider value={explorerContext}>
            <QuickDeletePermanently
              aria-label="Delete permanently"
              doc={{ id: "doc-a" } as never}
            />
          </DocExplorerContext.Provider>
        </ConfirmModalProvider>
      </MyoxusUIProvider>,
    );

    fireEvent.click(screen.getByTestId("delete-page-button"));
    fireEvent.click(await screen.findByTestId("confirm-modal-confirm"));

    await waitFor(() => {
      expect(mocks.guardCan).toHaveBeenCalledWith("Doc_Delete", "doc-a");
      expect(mocks.permanentlyDeletePage).toHaveBeenCalledWith("doc-a");
    });
    expect(screen.getByTestId("confirm-modal-confirm")).toBeTruthy();

    await act(async () => {
      resolveDelete();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("confirm-modal-confirm")).toBeNull();
    });
  });
});
