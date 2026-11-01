// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AttachmentBlockModel } from "@virgultum/editor/model";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  download: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    ({
      "com.myoxus.attachment.download": () => "Herunterladen",
      "com.myoxus.common.open-menu": () => "Menü öffnen",
    }) as any,
}));

vi.mock("./utils", () => ({ download: mocks.download }));

import { AttachmentWorkbenchHeader, Titlebar } from "./viewer";

const model = {} as AttachmentBlockModel;

function renderWithProvider(node: React.ReactNode) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

afterEach(() => {
  cleanup();
  mocks.download.mockClear();
});

describe("attachment viewer header actions", () => {
  test("Workbench uses the shared burger and both localized download paths", async () => {
    renderWithProvider(
      <AttachmentWorkbenchHeader
        model={model}
        name="report"
        ext="pdf"
        size="1 MB"
      />,
    );

    const directDownload = screen.getByRole("button", {
      name: "Herunterladen",
    });
    const burger = screen.getByRole("button", { name: "Menü öffnen" });
    expect(burger.dataset.myoxusUiRole).toBe("workbench-header-menu");

    fireEvent.click(directDownload);
    await waitFor(() => expect(mocks.download).toHaveBeenCalledWith(model));

    fireEvent.click(burger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Herunterladen" }),
    );
    await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(2));
  });

  test("Peek keeps its contextual overflow without adopting the Workbench role", async () => {
    renderWithProvider(
      <Titlebar model={model} name="report" ext="pdf" size="1 MB" />,
    );

    const overflow = screen.getByRole("button", { name: "Menü öffnen" });
    expect(overflow.dataset.myoxusUiRole).not.toBe("workbench-header-menu");
    expect(screen.getByRole("button", { name: "Herunterladen" })).toBeTruthy();

    fireEvent.click(overflow);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Herunterladen" }),
    );
    await waitFor(() => expect(mocks.download).toHaveBeenCalledWith(model));
  });
});
