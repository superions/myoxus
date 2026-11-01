// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DatabaseRichTextCell } from "./rich-text-cell";

const scrollIntoView = vi.fn();
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: scrollIntoView,
});

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});

const value = {
  plainText: "Bold project brief",
  document: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Bold project brief",
            marks: [{ type: "bold" }],
          },
        ],
      },
    ],
  },
};

afterEach(() => {
  cleanup();
  scrollIntoView.mockClear();
});

describe("DatabaseRichTextCell", () => {
  test("renders the server projection and opens an accessible shared editor", async () => {
    render(
      <MyoxusUIProvider env="test">
        <DatabaseRichTextCell
          fieldName="Description"
          value={value}
          onSave={vi.fn()}
        />
      </MyoxusUIProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Bold project brief" });
    fireEvent.click(trigger);

    expect(
      await screen.findByRole("dialog", { name: "Description" }),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Bold" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Italic" })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Strikethrough" }),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Inline code" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add link" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("uses the same expanded editor owner in Side Peek mode", () => {
    render(
      <MyoxusUIProvider env="test">
        <DatabaseRichTextCell
          expanded
          fieldName="Acceptance criteria"
          value={value}
          onSave={vi.fn()}
        />
      </MyoxusUIProvider>,
    );

    expect(screen.queryByTestId("database-rich-text-open")).toBeNull();
    expect(screen.getByLabelText("Acceptance criteria")).not.toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled,
    ).toBe(true);
  });

  test("opens from the keyboard, edits, and persists the canonical document", async () => {
    const user = userEvent.setup();
    const onEditStart = vi.fn();
    const onSave = vi.fn().mockResolvedValue(true);
    render(
      <MyoxusUIProvider env="test">
        <DatabaseRichTextCell
          fieldName="Description"
          value={value}
          onEditStart={onEditStart}
          onSave={onSave}
        />
      </MyoxusUIProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Bold project brief" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const editor = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".ProseMirror");
      expect(element).not.toBeNull();
      return element!;
    });
    await user.click(editor);
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: () => " 123456",
        items: [],
        types: ["text/plain"],
      },
    });
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Save" })
          .disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onEditStart).toHaveBeenCalled();
    expect(onSave.mock.calls[0]?.[0]?.type).toBe("doc");
    expect(JSON.stringify(onSave.mock.calls[0]?.[0])).toContain("123456");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("keeps inline editing inside its card and supports commit and cancel shortcuts", async () => {
    const onCardOpen = vi.fn();
    const onSave = vi.fn().mockResolvedValue(true);
    render(
      <MyoxusUIProvider env="test">
        <div onClick={onCardOpen}>
          <DatabaseRichTextCell
            inline
            fieldName="Description"
            value={value}
            onSave={onSave}
          />
        </div>
      </MyoxusUIProvider>,
    );

    let trigger = screen.getByRole("button", {
      name: "Bold project brief",
    });
    fireEvent.keyDown(trigger, { key: "F2" });
    const editor = await waitFor(() =>
      document.querySelector<HTMLElement>(".ProseMirror"),
    );
    expect(editor).not.toBeNull();
    fireEvent.paste(editor!, {
      clipboardData: {
        files: [],
        getData: () => " updated",
        items: [],
        types: ["text/plain"],
      },
    });
    fireEvent.keyDown(editor!, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.queryByTestId("database-rich-text-inline-editor"),
      ).toBeNull(),
    );
    trigger = screen.getByRole("button", { name: "Bold project brief" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(onCardOpen).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    const reopened = await waitFor(() =>
      document.querySelector<HTMLElement>(".ProseMirror"),
    );
    fireEvent.keyDown(reopened!, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByTestId("database-rich-text-inline-editor"),
      ).toBeNull(),
    );
    expect(onSave).toHaveBeenCalledOnce();
    expect(onCardOpen).not.toHaveBeenCalled();
  });

  test("keeps the draft mounted for validation errors and pending conflicts", async () => {
    const user = userEvent.setup();
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error("invalid"))
      .mockResolvedValueOnce(false);
    render(
      <MyoxusUIProvider env="test">
        <DatabaseRichTextCell
          fieldName="Description"
          value={value}
          onSave={onSave}
        />
      </MyoxusUIProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "Bold project brief" }),
    );
    const editor = await waitFor(() =>
      document.querySelector<HTMLElement>(".ProseMirror"),
    );
    expect(editor).not.toBeNull();
    await user.click(editor!);
    fireEvent.paste(editor!, {
      clipboardData: {
        files: [],
        getData: () => " 123456",
        items: [],
        types: ["text/plain"],
      },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("The rich text could not be saved."),
    ).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(screen.getByRole("dialog", { name: "Description" })).not.toBeNull();
    expect(
      document.querySelector(".mantine-ScrollArea-content"),
    ).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("dialog", { name: "Description" })).not.toBeNull();
    expect(editor?.textContent).toContain("123456");
  });

  test("keeps expanded read-only consumers on the compact projection", () => {
    render(
      <MyoxusUIProvider env="test">
        <DatabaseRichTextCell
          expanded
          fieldName="Description"
          readOnly
          value={value}
        />
      </MyoxusUIProvider>,
    );

    expect(screen.getByText("Bold project brief")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".ProseMirror")).toBeNull();
  });
});
