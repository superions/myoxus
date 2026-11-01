// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { ConfirmModalProvider } from "@myoxus/ui-facade";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { TagEditMenu } from "./tag-edit-menu";
import { workspaceTagErrorKind } from "./use-workspace-tag-commands";

vi.mock("@myoxus/i18n", () => ({
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  useI18n: () =>
    new Proxy(
      {},
      {
        get: (_target, key) => () => String(key),
      },
    ),
}));

function renderWithProvider(children: ReactNode) {
  return render(
    <MyoxusUIProvider env="test">
      <ConfirmModalProvider>{children}</ConfirmModalProvider>
    </MyoxusUIProvider>,
  );
}

describe("TagEditMenu", () => {
  beforeAll(() => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("submits complete normalized metadata through the shared modal", async () => {
    const onTagArchive = vi.fn();
    const onTagUpdate = vi.fn(async () => true);
    const jumpToTag = vi.fn();

    renderWithProvider(
      <TagEditMenu
        colors={[
          { id: "red", name: "Red", value: "tag.red" },
          {
            id: "blue",
            name: "Blue",
            value: "tag.blue",
          },
        ]}
        tag={{
          color: "tag.blue",
          id: "tag-1",
          name: "Project",
          description: "Original description",
        }}
        jumpToTag={jumpToTag}
        onTagUpdate={onTagUpdate}
        onTagArchive={onTagArchive}
      >
        <button type="button">Edit tag</button>
      </TagEditMenu>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit tag" }));

    expect(
      await screen.findByRole("menuitem", {
        hidden: true,
        name: "com.myoxus.tags.archive.action",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", {
        hidden: true,
        name: "com.myoxus.all-docs.quick-action.delete-permanently",
      }),
    ).toBeNull();

    fireEvent.click(
      await screen.findByRole("menuitem", { hidden: true, name: "Edit" }),
    );
    expect(
      await screen.findByRole("dialog", {
        name: "com.myoxus.tags.metadata.edit-title",
      }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("com.myoxus.tags.name"), {
      target: { value: "  Renamed  " },
    });
    fireEvent.change(
      screen.getByLabelText("com.myoxus.tags.metadata.description"),
      { target: { value: "  Full\n description  " } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Blue" }));
    const red = await screen.findByRole("menuitem", {
      hidden: true,
      name: "Red",
    });
    fireEvent.click(red);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onTagUpdate).toHaveBeenCalledWith("tag-1", {
      name: "Renamed",
      color: "tag.red",
      description: "Full\n description",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("tag-metadata-modal")).toBeNull(),
    );
  });

  test("retains the metadata draft and dialog when the server rejects it", async () => {
    renderWithProvider(
      <TagEditMenu
        colors={[{ id: "blue", name: "Blue", value: "tag.blue" }]}
        tag={{ color: "tag.blue", id: "tag-1", name: "Project" }}
        onTagArchive={vi.fn()}
        onTagUpdate={vi.fn(async () => false)}
      >
        <button type="button">Edit tag</button>
      </TagEditMenu>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit tag" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { hidden: true, name: "Edit" }),
    );
    const name = await screen.findByLabelText("com.myoxus.tags.name");
    fireEvent.change(name, { target: { value: "Retained" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("com.myoxus.common.operation-failed"),
    ).toBeTruthy();
    expect(await screen.findByDisplayValue("Retained")).toBeTruthy();
    expect(screen.getByTestId("tag-metadata-modal")).toBeTruthy();
  });

  test("offers restore and separated permanent deletion instead of active actions for an archived tag", async () => {
    const onTagArchive = vi.fn();
    const onTagDeletePermanently = vi.fn(async () => true);
    const onTagRestore = vi.fn();

    renderWithProvider(
      <TagEditMenu
        colors={[{ id: "blue", name: "Blue", value: "tag.blue" }]}
        tag={{
          archived: true,
          color: "tag.blue",
          id: "tag-1",
          name: "Historical",
        }}
        onTagUpdate={vi.fn(async () => true)}
        onTagArchive={onTagArchive}
        onTagDeletePermanently={onTagDeletePermanently}
        onTagRestore={onTagRestore}
        canDeletePermanently
      >
        <button type="button">Edit archived tag</button>
      </TagEditMenu>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit archived tag" }));
    fireEvent.click(
      await screen.findByRole("menuitem", {
        hidden: true,
        name: "com.myoxus.tags.restore.action",
      }),
    );

    expect(onTagRestore).toHaveBeenCalledWith("tag-1");
    expect(onTagArchive).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("menuitem", {
        hidden: true,
        name: "com.myoxus.tags.archive.action",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", { hidden: true, name: "Edit" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit archived tag" }));
    const permanent = await screen.findByRole("menuitem", {
      hidden: true,
      name: "com.myoxus.all-docs.quick-action.delete-permanently",
    });
    expect(permanent.previousElementSibling?.getAttribute("role")).toBe(
      "separator",
    );
    fireEvent.click(permanent);
    expect(
      await screen.findByRole("dialog", {
        name: "com.myoxus.delete-tags.confirm.title",
      }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "com.myoxus.all-docs.quick-action.delete-permanently",
      }),
    );
    await waitFor(() =>
      expect(onTagDeletePermanently).toHaveBeenCalledWith("tag-1"),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", {
          name: "com.myoxus.delete-tags.confirm.title",
        }),
      ).toBeNull(),
    );
  });

  test("classifies stable restore-conflict and forbidden server errors", () => {
    expect(
      workspaceTagErrorKind({
        extensions: { code: "MIX_WORKSPACE_TAG_DUPLICATE_SLUG" },
      }),
    ).toBe("conflict");
    expect(
      workspaceTagErrorKind({
        extensions: { code: "MIX_WORKSPACE_TAG_FORBIDDEN" },
      }),
    ).toBe("forbidden");
  });
});
