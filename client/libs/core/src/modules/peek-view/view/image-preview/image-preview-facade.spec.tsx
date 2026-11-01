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
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  downloadResourceWithUrl,
  resourceUrlToBlob,
} from "../../../../utils/resource";
import { GenericImagePreviewModal } from "./index";

vi.mock("../../../../utils/resource", () => ({
  downloadResourceWithUrl: vi.fn(),
  resourceUrlToBlob: vi.fn(),
}));

const imageUrl = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";

function renderImagePreviewModal() {
  const previous = vi.fn();
  const next = vi.fn();
  const onDelete = vi.fn();
  const onClose = vi.fn();

  render(
    <MyoxusUIProvider>
      <GenericImagePreviewModal
        total={3}
        image={{
          index: 1,
          url: imageUrl,
          caption: "Preview caption",
          previous,
          next,
          onDelete,
        }}
        onClose={onClose}
      />
    </MyoxusUIProvider>,
  );

  return { next, onClose, onDelete, previous };
}

describe("image preview facade lightbox", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  test("renders image chrome through shared facade roles", () => {
    renderImagePreviewModal();

    const modal = screen.getByTestId("image-preview-modal");
    expect(modal.getAttribute("data-myoxus-ui-role")).toBe("media-lightbox");
    expect(
      modal.querySelector('[data-myoxus-ui-role="media-lightbox-toolbar"]'),
    ).toBeTruthy();
    expect(
      modal.querySelector('[data-myoxus-ui-role="media-lightbox-toolbar"]')
        ?.className,
    ).toContain("mantine-Card-root");
    expect(
      modal.querySelector(
        '[data-myoxus-ui-role="media-lightbox-toolbar"] [data-myoxus-ui-role="toolbar-surface-content"]',
      ),
    ).toBeTruthy();
    expect(
      modal.querySelector('[data-myoxus-ui-role="media-lightbox-counter"]')
        ?.textContent,
    ).toBe("2/3");
    expect(
      modal
        .querySelector('[data-myoxus-ui-role="media-lightbox-zoom-area"]')
        ?.getAttribute("data-zoom-state"),
    ).toBe("fit");
    expect(screen.getByRole("img", { name: "Preview caption" })).toBeTruthy();
    expect(
      screen
        .getByTestId("reset-scale-button")
        .getAttribute("data-myoxus-ui-role"),
    ).toBe("media-lightbox-scale-button");
    expect(screen.getByTestId("image-caption-zoomedout").className).toContain(
      "mantine-Text-root",
    );
  });

  test("keeps toolbar actions wired after replacing local buttons", () => {
    const { next, onClose, onDelete, previous } = renderImagePreviewModal();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(
      screen
        .getByTestId("image-preview-modal")
        .querySelector('[data-myoxus-ui-role="media-lightbox-dismiss-layer"]')!,
    );

    expect(previous).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("keeps keyboard navigation and resource actions wired in the modal owner", async () => {
    vi.mocked(resourceUrlToBlob).mockResolvedValue(
      new Blob(["image"], { type: "image/png" }),
    );
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "ClipboardItem",
      class ClipboardItem {
        constructor(readonly items: Record<string, Blob>) {}
      },
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write: clipboardWrite },
    });

    const { next, previous } = renderImagePreviewModal();

    fireEvent.keyUp(document, { key: "ArrowLeft" });
    fireEvent.keyUp(document, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
    fireEvent.copy(document.body);

    expect(previous).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(downloadResourceWithUrl).toHaveBeenCalledWith(
        imageUrl,
        "Preview caption",
      ),
    );
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(2));
  });

  test("keeps zoom button state inside the component instead of browser setup", () => {
    renderImagePreviewModal();

    expect(screen.getByTestId("reset-scale-button").textContent).toBe("100%");

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByTestId("reset-scale-button").textContent).toBe("110%");

    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByTestId("reset-scale-button").textContent).toBe("100%");

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByTestId("reset-scale-button"));
    expect(screen.getByTestId("reset-scale-button").textContent).toBe("100%");
  });
});
