// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { WorkspaceService } from "@myoxus/core/modules/workspace/services/workspace";
import { WorkspacesService } from "@myoxus/core/modules/workspace/services/workspaces";
import {
  DatabaseFieldKind,
  DatabaseFileMimeCategory,
  DatabaseFilesPreviewPolicy,
} from "@myoxus/graphql";
import { type FrameworkProvider, FrameworkRoot } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { field } from "../test-fixtures";
import { DatabaseFilesCell } from "./files-cell";

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});

function fixture(onChange = vi.fn().mockResolvedValue(undefined)) {
  const upload = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockResolvedValue("blob-new");
  const deleteBlob = vi.fn().mockResolvedValue(undefined);
  const workspace = {
    id: "workspace-1",
    meta: { flavour: "cloud", id: "workspace-1" },
    docCollection: { blobSync: { set } },
    engine: { blob: { upload } },
  };
  const workspaceService = { workspace };
  const workspacesService = {
    getWorkspaceFlavourProvider: () => ({ deleteBlob }),
  };
  const framework = {
    getOptional(token: unknown) {
      if (token === WorkspaceService) return workspaceService;
      if (token === WorkspacesService) return workspacesService;
      return undefined;
    },
  } as unknown as FrameworkProvider;
  const filesField = {
    ...field("field-files", DatabaseFieldKind.Files, "Attachments", 1),
    config: {
      ...field("field-files", DatabaseFieldKind.Files, "Attachments", 1).config,
      files: {
        allowedMimeCategories: [DatabaseFileMimeCategory.Image],
        maxItemCount: 3,
        maxItemSize: 1024,
        previewPolicy: DatabaseFilesPreviewPolicy.Auto,
      },
    },
  };
  return { deleteBlob, filesField, framework, onChange, set, upload };
}

function renderCell(
  fixtureValue: ReturnType<typeof fixture>,
  files: Array<{
    blobKey: string;
    caption: string | null;
    cover: boolean;
    mime: string | null;
    name: string | null;
    size: number | null;
  }> = [],
) {
  const result = render(
    <FrameworkRoot framework={fixtureValue.framework}>
      <MyoxusUIProvider>
        <DatabaseFilesCell
          field={fixtureValue.filesField}
          files={files}
          workspaceId="workspace-1"
          onChange={fixtureValue.onChange}
        />
      </MyoxusUIProvider>
    </FrameworkRoot>,
  );
  return result.container.querySelector<HTMLInputElement>(
    'input[type="file"]',
  )!;
}

afterEach(cleanup);

describe("DatabaseFilesCell", () => {
  test("uploads through the workspace blob engine before committing metadata", async () => {
    const value = fixture();
    const input = renderCell(value);
    const file = new File([new Uint8Array(512)], "cover.png", {
      type: "image/png",
    });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(value.onChange).toHaveBeenCalledTimes(1));
    expect(value.set).toHaveBeenCalledWith(file);
    expect(value.upload).toHaveBeenCalledWith("blob-new");
    expect(value.onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        blobKey: "blob-new",
        cover: false,
        mime: "image/png",
        name: "cover.png",
        size: 512,
      }),
    ]);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("soft-deletes an interaction upload when the cell commit fails", async () => {
    const value = fixture(vi.fn().mockRejectedValue(new Error("conflict")));
    const input = renderCell(value);
    const file = new File([new Uint8Array(64)], "cover.png", {
      type: "image/png",
    });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(value.deleteBlob).toHaveBeenCalledWith(
        "workspace-1",
        "blob-new",
        false,
      ),
    );
    expect(
      screen.getByText("The attachment changes could not be saved."),
    ).not.toBeNull();
  });

  test("compensates a blob key when remote upload fails after local storage accepted it", async () => {
    const value = fixture();
    value.upload.mockRejectedValue(new Error("remote unavailable"));
    const input = renderCell(value);
    const file = new File([new Uint8Array(64)], "cover.png", {
      type: "image/png",
    });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(value.deleteBlob).toHaveBeenCalledWith(
        "workspace-1",
        "blob-new",
        false,
      ),
    );
    expect(screen.getByText("The file could not be uploaded.")).not.toBeNull();
    expect(value.onChange).not.toHaveBeenCalled();
  });

  test("rejects known local size and MIME violations before upload", async () => {
    const value = fixture();
    const input = renderCell(value);
    const file = new File([new Uint8Array(2048)], "archive.zip", {
      type: "application/zip",
    });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(screen.getByText(/exceed this field/)).not.toBeNull(),
    );
    expect(value.set).not.toHaveBeenCalled();
    expect(value.onChange).not.toHaveBeenCalled();
  });

  test("renders a non-destructive unavailable state without workspace blob access", () => {
    const value = fixture();
    value.framework = {
      getOptional: () => undefined,
    } as unknown as FrameworkProvider;
    renderCell(value);

    expect(
      screen.getByText("Attachments are unavailable in this workspace."),
    ).not.toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Add files" })
        .disabled,
    ).toBe(true);
    expect(value.onChange).not.toHaveBeenCalled();
  });

  test("commits reorder, cover, caption and remove actions as ordered references", async () => {
    const value = fixture();
    const files = [
      {
        blobKey: "first.png",
        caption: null,
        cover: false,
        mime: "image/png",
        name: "First",
        size: 32,
      },
      {
        blobKey: "second.png",
        caption: null,
        cover: false,
        mime: "image/png",
        name: "Second",
        size: 64,
      },
    ];
    renderCell(value, files);

    fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0]!);
    await waitFor(() =>
      expect(value.onChange).toHaveBeenLastCalledWith([files[1], files[0]]),
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Use as cover" })[0]!,
    );
    await waitFor(() =>
      expect(value.onChange).toHaveBeenLastCalledWith([
        { ...files[0], cover: true },
        files[1],
      ]),
    );

    fireEvent.doubleClick(screen.getAllByText("Caption")[0]!);
    const caption = screen.getByRole("textbox");
    fireEvent.change(caption, { target: { value: "Primary cover" } });
    fireEvent.blur(caption);
    await waitFor(() =>
      expect(value.onChange).toHaveBeenLastCalledWith([
        { ...files[0], caption: "Primary cover" },
        files[1],
      ]),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Remove file" })[1]!);
    await waitFor(() =>
      expect(value.onChange).toHaveBeenLastCalledWith([files[0]]),
    );
  });
});
