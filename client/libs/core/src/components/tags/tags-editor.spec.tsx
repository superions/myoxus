// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import type { TagColorRole } from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { TagsEditor, TagsInlineEditor } from "./tags-editor";
import type { TagColor, TagLike } from "./types";

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    new Proxy(
      {},
      {
        get: (_target, key) => () => String(key),
      },
    ),
}));

const colors: TagColor[] = [
  { id: "red", name: "Red", value: "tag.red" },
  { id: "blue", name: "Blue", value: "tag.blue" },
];

function renderWithProvider(children: ReactNode) {
  return render(<MyoxusUIProvider>{children}</MyoxusUIProvider>);
}

function renderEditor(props: {
  tags?: TagLike[];
  selectedTags?: string[];
  onCreateTag?: (name: string, color: TagColorRole) => Promise<TagLike>;
  onSelectTag?: (tagId: string) => void;
  onDeselectTag?: (tagId: string) => void;
  lifecycleDisabled?: boolean;
  feedback?: ReactNode;
}) {
  const tag: TagLike = {
    id: "tag-1",
    name: "Existing",
    color: colors[0].value,
  };
  const onCreateTag =
    props.onCreateTag ??
    vi.fn(async (name: string, color: TagColorRole) => ({
      id: `created-${name.toLowerCase()}`,
      name,
      color,
    }));
  const onSelectTag = props.onSelectTag ?? vi.fn();
  const onDeselectTag = props.onDeselectTag ?? vi.fn();

  renderWithProvider(
    <TagsEditor
      tags={props.tags ?? [tag]}
      selectedTags={props.selectedTags ?? []}
      onCreateTag={onCreateTag}
      onSelectTag={onSelectTag}
      onDeselectTag={onDeselectTag}
      onTagArchive={vi.fn()}
      onTagUpdate={vi.fn(async () => true)}
      lifecycleDisabled={props.lifecycleDisabled}
      feedback={props.feedback}
      tagColors={colors}
      tagMode="inline-tag"
    />,
  );

  return { onCreateTag, onSelectTag, onDeselectTag };
}

describe("TagsEditor behavior", () => {
  beforeAll(() => {
    vi.stubGlobal("BUILD_CONFIG", { isMobileEdition: false });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test("returns focus to the same Database trigger after adding its first and removing its last tag", async () => {
    function Cell() {
      const [selectedTags, setSelectedTags] = useState<string[]>([]);
      return (
        <TagsInlineEditor
          block
          placeholder="Add tag"
          tags={[{ id: "a", name: "Project", color: "tag.blue" }]}
          selectedTags={selectedTags}
          onSelectTag={(id) => setSelectedTags([id])}
          onDeselectTag={() => setSelectedTags([])}
          onCreateTag={vi.fn()}
          onTagArchive={vi.fn()}
          onTagUpdate={vi.fn(async () => true)}
          tagColors={colors}
          tagMode="db-label"
        />
      );
    }
    renderWithProvider(<Cell />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Add tag" });
    for (const expectedName of ["Project", "Add tag"]) {
      trigger.focus();
      await user.keyboard("{Enter}");
      await user.click(await screen.findByTestId("tag-selector-item"));
      await user.click(
        screen.getByRole("menuitem", {
          name: "com.myoxus.m.explorer.tag.rename-confirm",
        }),
      );
      await waitFor(() => {
        expect(screen.getByRole("button", { name: expectedName })).toBe(
          trigger,
        );
        expect(document.activeElement).toBe(trigger);
      });
    }
  });

  test("renders selected active and archived chips in assignment order instead of catalog order", () => {
    renderEditor({
      tags: [
        { id: "a", name: "Alpha", color: "tag.blue" },
        { id: "b", name: "Archived", color: "tag.grey", archived: true },
        { id: "c", name: "Charlie", color: "tag.green" },
      ],
      selectedTags: ["c", "b", "a"],
    });
    const selected = document.querySelector(
      "[data-myoxus-ui-role=tags-editor-selected-tags]",
    )!;
    expect(
      [...selected.querySelectorAll("[data-tag-id]")].map((chip) =>
        chip.getAttribute("data-tag-id"),
      ),
    ).toEqual(["c", "b", "a"]);
  });

  test("creates and selects a filtered tag from the keyboard", async () => {
    const { onCreateTag, onSelectTag } = renderEditor({});
    const input = screen.getByPlaceholderText(
      "com.myoxus.search-tags.placeholder",
    );

    fireEvent.change(input, { target: { value: "Project" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCreateTag).toHaveBeenCalledWith(
      "Project",
      expect.stringMatching(/^tag\.(red|blue)$/),
    );
    await waitFor(() => {
      expect(onSelectTag).toHaveBeenCalledWith("created-project");
    });
  });

  test("toggles existing tags and removes the focused selected tag with Backspace", () => {
    const onSelectTag = vi.fn();
    const onDeselectTag = vi.fn();

    renderEditor({
      selectedTags: ["tag-1"],
      onSelectTag,
      onDeselectTag,
    });

    const selectedItem = screen.getByTestId("tag-selector-item");
    expect(selectedItem.dataset.selected).toBe("true");
    expect(
      screen.getByText("com.myoxus.m.explorer.tag.rename-confirm"),
    ).not.toBeNull();
    fireEvent.click(selectedItem);
    expect(onDeselectTag).toHaveBeenCalledWith("tag-1");

    const input = screen.getByPlaceholderText(
      "com.myoxus.search-tags.placeholder",
    );
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(onDeselectTag).toHaveBeenCalledWith("tag-1");
    expect(onSelectTag).not.toHaveBeenCalled();
  });

  test("leaves duplicate-name creation to the server", async () => {
    const { onCreateTag, onSelectTag } = renderEditor({});
    const input = screen.getByPlaceholderText(
      "com.myoxus.search-tags.placeholder",
    );

    fireEvent.change(input, { target: { value: "Existing" } });
    expect(screen.getAllByTestId("tag-selector-item")[0]?.dataset.tagId).toBe(
      "tag-1",
    );
    fireEvent.click(screen.getByText("Create"));

    await waitFor(() =>
      expect(onCreateTag).toHaveBeenCalledWith(
        "Existing",
        expect.stringMatching(/^tag\.(red|blue)$/),
      ),
    );
    expect(onSelectTag).toHaveBeenCalledWith("created-existing");
  });

  test("separates existing tags from the new-tag action", () => {
    renderEditor({});
    const input = screen.getByPlaceholderText(
      "com.myoxus.search-tags.placeholder",
    );

    fireEvent.change(input, { target: { value: "Existing" } });

    const panel = screen.getByTestId("tags-editor-popup");
    const createSection = panel.querySelector(
      '[data-myoxus-ui-role="tag-create-section"]',
    );
    const existingRow = panel.querySelector(
      '[data-myoxus-ui-role="tag-selector-row"]',
    );

    expect(createSection).not.toBeNull();
    expect(createSection?.textContent).toContain(
      "com.myoxus.tags.empty.new-tag-button",
    );
    expect(createSection?.contains(existingRow)).toBe(false);
    expect(
      panel.querySelector(
        '[data-myoxus-ui-role="tags-editor-selector"] [role="separator"]',
      ),
    ).not.toBeNull();
  });

  test("retains an archived confirmed tag as removable but never offers it for selection", () => {
    const onDeselectTag = vi.fn();
    renderEditor({
      tags: [
        {
          id: "tag-1",
          name: "Existing",
          color: "tag.red",
        },
        {
          id: "tag-archived",
          name: "Historical",
          color: "tag.blue",
          archived: true,
        },
      ],
      selectedTags: ["tag-archived"],
      onDeselectTag,
    });

    expect(
      screen.getByLabelText("Historical, com.myoxus.tags.status.archived"),
    ).toBeTruthy();
    expect(screen.queryByTestId("tag-selector-item")?.dataset.tagId).not.toBe(
      "tag-archived",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "com.myoxus.common.remove-item",
      }),
    );
    expect(onDeselectTag).toHaveBeenCalledWith("tag-archived");
  });

  test("keeps assignment available while lifecycle commands are disabled", () => {
    const onSelectTag = vi.fn();
    const { onCreateTag } = renderEditor({
      lifecycleDisabled: true,
      onSelectTag,
    });
    const input = screen.getByPlaceholderText(
      "com.myoxus.search-tags.placeholder",
    );

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    fireEvent.click(screen.getByTestId("tag-selector-item"));
    expect(onSelectTag).toHaveBeenCalledWith("tag-1");

    fireEvent.change(input, { target: { value: "New tag" } });
    expect(screen.queryByText("Create")).toBeNull();

    expect(onCreateTag).not.toHaveBeenCalled();
  });

  test("keeps assignment feedback inside the shared selector panel", () => {
    renderEditor({
      feedback: <div data-testid="assignment-feedback">Retry assignment</div>,
    });

    expect(
      screen
        .getByTestId("tags-editor-popup")
        .contains(screen.getByTestId("assignment-feedback")),
    ).toBe(true);
  });
});
