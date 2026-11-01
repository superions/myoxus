// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18n } from "@myoxus/i18n";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  ConfirmModal,
  ConfirmModalProvider,
  DetailPeek,
  Modal,
  ModalStack,
  Select,
  PromptModal,
  useConfirmModal,
} from "./index";
import { MyoxusUIProvider } from "./provider";

const originalMatchMedia = window.matchMedia;

function setViewportMatch(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches,
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
    writable: true,
  });
}

beforeEach(() => setViewportMatch(false));
afterEach(() => {
  cleanup();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: originalMatchMedia,
    writable: true,
  });
});

function TransientOpenerModal() {
  const [open, setOpen] = useState(true);
  const durableTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <MyoxusUIProvider>
      <button ref={durableTriggerRef} type="button">
        Database actions
      </button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        returnFocusRef={durableTriggerRef}
        title="Export database"
      >
        Export options
      </Modal>
    </MyoxusUIProvider>
  );
}

function InteractiveDetailPeek() {
  const [open, setOpen] = useState(true);
  const durableTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <MyoxusUIProvider>
      <button ref={durableTriggerRef} type="button">
        Task card
      </button>
      <DetailPeek
        open={open}
        onOpenChange={setOpen}
        returnFocusRef={durableTriggerRef}
        title="Task details"
        closeButtonLabel="Close"
        data-testid="detail-peek"
      >
        Editable properties
      </DetailPeek>
    </MyoxusUIProvider>
  );
}

describe("Modal", () => {
  test("unmounting an open sibling restores its owner's visibility, focus and actions", async () => {
    const user = userEvent.setup();
    const commit = vi.fn();
    function SiblingDialogs() {
      const [prompt, setPrompt] = useState(false);
      return (
        <ModalStack>
          <Modal open title="Task draft">
            <input aria-label="Task title" defaultValue="Retained draft" />
            <button onClick={() => setPrompt(true)}>Template inputs</button>
            <button onClick={commit}>Save draft</button>
          </Modal>
          {prompt ? (
            <Modal open title="Required inputs">
              <button onClick={() => setPrompt(false)}>Return rejection</button>
            </Modal>
          ) : null}
        </ModalStack>
      );
    }
    render(
      <MyoxusUIProvider>
        <SiblingDialogs />
      </MyoxusUIProvider>,
    );
    const parent = await screen.findByRole("dialog", { name: "Task draft" });
    const trigger = within(parent).getByRole("button", {
      name: "Template inputs",
    });
    await user.click(trigger);
    const prompt = await screen.findByRole("dialog", {
      name: "Required inputs",
    });
    await waitFor(() =>
      expect(parent.getAttribute("data-hidden")).toBe("true"),
    );
    await user.click(
      within(prompt).getByRole("button", { name: "Return rejection" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Required inputs" }),
      ).toBeNull();
      expect(parent.hasAttribute("data-hidden")).toBe(false);
      expect(parent.contains(document.activeElement)).toBe(true);
    });
    expect(
      (
        within(parent).getByRole("textbox", {
          name: "Task title",
        }) as HTMLInputElement
      ).value,
    ).toBe("Retained draft");
    await user.click(
      within(parent).getByRole("button", { name: "Save draft" }),
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(parent.hasAttribute("data-hidden")).toBe(false);
  });

  test("stacks a global confirmation above a separately mounted settings owner", async () => {
    const rootStyle = document.documentElement.style;
    const previousLayer = rootStyle.getPropertyValue("--myoxus-z-index-modal");
    rootStyle.setProperty("--myoxus-z-index-modal", "1300");
    const user = userEvent.setup();
    const confirm = vi.fn();
    function SettingsOwner() {
      const { openConfirmModal } = useConfirmModal();
      return (
        <Modal open title="Workspace settings">
          <button
            onClick={() =>
              openConfirmModal({
                title: "Confirm public access",
                confirmText: "Publish",
                onConfirm: confirm,
              })
            }
          >
            Public workspace
          </button>
        </Modal>
      );
    }
    render(
      <MyoxusUIProvider>
        <ConfirmModalProvider>
          <SettingsOwner />
        </ConfirmModalProvider>
      </MyoxusUIProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Public workspace" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Confirm public access",
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: "Publish" }),
      ),
    );
    await waitFor(() =>
      expect(
        dialog.closest(".mantine-Modal-root")?.getAttribute("style"),
      ).toContain("calc(1300 + 1 + 1)"),
    );
    rootStyle.setProperty("--myoxus-z-index-modal", previousLayer);
    await waitFor(() =>
      expect(
        screen
          .getByRole("dialog", { name: "Workspace settings" })
          .getAttribute("data-hidden"),
      ).toBe("true"),
    );
    await user.click(within(dialog).getByRole("button", { name: "Publish" }));
    expect(confirm).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Confirm public access" }),
      ).toBeNull(),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("dialog", { name: "Workspace settings" })
          .hasAttribute("data-hidden"),
      ).toBe(false),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Public workspace" }),
      ),
    );
  });

  test("keeps confirmation focus and Escape above its full-screen owner", async () => {
    const user = userEvent.setup();
    const restore = vi.fn();
    function HistoryDialogs() {
      const [confirm, setConfirm] = useState(false);
      return (
        <MyoxusUIProvider>
          <ModalStack>
            <Modal
              stackId="history"
              open
              fullScreen
              keepVisibleInStack
              title="Document history"
            >
              <button onClick={() => setConfirm(true)}>
                Restore selected snapshot
              </button>
              <ConfirmModal
                stackId="confirm"
                open={confirm}
                onOpenChange={setConfirm}
                title="Confirm restore"
                confirmText="Restore"
                onConfirm={restore}
              />
            </Modal>
          </ModalStack>
        </MyoxusUIProvider>
      );
    }
    render(<HistoryDialogs />);
    await user.click(
      screen.getByRole("button", { name: "Restore selected snapshot" }),
    );
    const confirmation = await screen.findByRole("dialog", {
      name: "Confirm restore",
    });
    await user.click(
      within(confirmation).getByRole("button", {
        name: "Restore",
      }),
    );
    expect(restore).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Confirm restore" }),
      ).toBeNull(),
    );
    await user.click(
      screen.getByRole("button", { name: "Restore selected snapshot" }),
    );
    await screen.findByRole("dialog", { name: "Confirm restore" });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Confirm restore" }),
      ).toBeNull(),
    );
    expect(
      screen.getByRole("dialog", { name: "Document history" }),
    ).not.toBeNull();
    expect(restore).toHaveBeenCalledOnce();
  });

  test("exposes Escape before closing an editor-embedded dialog", async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn((event: KeyboardEvent) => {
      event.stopPropagation();
    });
    const onOpenChange = vi.fn();
    function EscapeAwareModal() {
      const [open, setOpen] = useState(true);
      return (
        <MyoxusUIProvider>
          <Modal
            open={open}
            title="Edit chart item"
            onEscape={onEscape}
            onOpenChange={(next) => {
              onOpenChange(next);
              setOpen(next);
            }}
          >
            <button type="button">Chart value</button>
          </Modal>
        </MyoxusUIProvider>
      );
    }
    render(<EscapeAwareModal />);

    await user.click(screen.getByRole("button", { name: "Chart value" }));
    await user.keyboard("{Escape}");

    expect(onEscape).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Edit chart item" }),
      ).toBeNull();
    });
  });

  test("returns focus to a durable trigger after a transient opener has unmounted", async () => {
    const user = userEvent.setup();
    render(<TransientOpenerModal />);

    await user.click(
      screen.getByRole("button", {
        name: I18n["com.myoxus.peek-view-controls.close"](),
      }),
    );

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Database actions" }),
      );
    });
  });

  test("keeps form selections usable outside a modal's clipping scroll area", async () => {
    const user = userEvent.setup();
    const select = vi.fn();
    render(
      <MyoxusUIProvider>
        <Modal open scrollable title="Properties">
          <span>
            Detailed implementation notes and cross-team acceptance criteria
          </span>
          <Select
            // Happy DOM has no layout; browser QA covers clipping and hit testing.
            comboboxProps={{ hideDetached: false }}
            data={[{ value: "target", label: "Destination workspace" }]}
            label="Destination"
            value=""
            onChange={select}
          />
        </Modal>
      </MyoxusUIProvider>,
    );

    const content = document.querySelector<HTMLElement>(
      ".mantine-ScrollArea-content",
    );
    expect(content?.style.minWidth).toBe("0");
    expect(content?.style.width).toBe("100%");
    const dialog = screen.getByRole("dialog", { name: "Properties" });
    await user.click(screen.getByRole("combobox", { name: "Destination" }));
    const option = await screen.findByRole("option", {
      name: "Destination workspace",
    });
    expect(dialog.contains(option)).toBe(false);
    expect(option.closest('[data-myoxus-ui-role="settings-modal-root"]')).toBe(
      dialog.closest('[data-myoxus-ui-role="settings-modal-root"]'),
    );
    await user.click(option);
    expect(select).toHaveBeenCalledWith("target");
    expect(screen.getByRole("dialog", { name: "Properties" })).toBe(dialog);
  });

  test("uses the shared modal frame and semantic form label for prompts", () => {
    render(
      <MyoxusUIProvider>
        <PromptModal
          open
          title="New collection"
          description="Collections keep related content together."
          label="Name"
          confirmText="Create"
          onOpenChange={vi.fn()}
        />
      </MyoxusUIProvider>,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "New collection" })
        .textContent,
    ).toBe("New collection");
    expect(screen.getByRole("textbox", { name: "Name" })).toBeInstanceOf(
      HTMLElement,
    );
    expect(
      document.querySelector('[data-myoxus-ui-role="settings-modal-header"]'),
    ).not.toBeNull();
    const description = document.querySelector<HTMLElement>(
      '[data-myoxus-ui-role="settings-modal-description"]',
    );
    expect(description?.tagName).toBe("DIV");
    expect(description?.style.fontStyle).toBe("italic");
    expect(screen.getByRole("separator")).toBeInstanceOf(HTMLElement);
  });
});

describe("DetailPeek", () => {
  test("keeps desktop source content interactive and returns focus on close", async () => {
    const user = userEvent.setup();
    render(<InteractiveDetailPeek />);

    const peek = screen.getByTestId("detail-peek");
    expect(peek.dataset.myoxusUiRole).toBe("detail-peek");
    expect(document.querySelector(".mantine-Drawer-overlay")).toBeNull();
    expect(screen.getByText("Editable properties")).toBeInstanceOf(HTMLElement);

    await user.click(within(peek).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Task card" }),
      );
    });
  });

  test("uses Mantine modal behavior at the theme medium breakpoint", () => {
    setViewportMatch(true);
    render(<InteractiveDetailPeek />);

    const peek = screen.getAllByTestId("detail-peek").at(-1)!;
    expect(peek.querySelector(".mantine-Drawer-overlay")).not.toBeNull();
    expect(peek.style.getPropertyValue("--drawer-size")).toBe("100%");
    expect(
      peek.querySelector('[role="dialog"]')?.getAttribute("aria-modal"),
    ).toBe("true");
  });
});
