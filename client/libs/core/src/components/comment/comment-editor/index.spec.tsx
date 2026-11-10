// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import type { CommentAttachment } from "@myoxus/core/modules/comment/types";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { Store } from "@virgultum/editor/store";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { CommentEditor } from "./index";

vi.mock("@myoxus/core/editor/editors", () => ({ LitDocEditor: () => <div /> }));
// The attachment lifecycle uses a stub editor, not its full chrome/services.
vi.mock(
  "@myoxus/core/editor/view-extensions/editor-view/editor-chrome",
  () => ({
    patchEditorChromeHost: () => ({}),
  }),
);
vi.mock("@myoxus/core/modules/comment/services/snapshot-helper", () => ({
  SnapshotHelper: class {},
}));
vi.mock("@myoxus/core/modules/peek-view", () => ({
  PeekViewService: class {},
}));
vi.mock("@myoxus/infra", () => ({
  useFramework: () => ({}),
  useService: () => ({ isDocEmpty: () => true, peekView: { open: vi.fn() } }),
}));
vi.mock("./specs", () => ({
  getCommentEditorViewManager: () => ({ get: () => [] }),
}));
vi.mock("@virgultum/editor/store", () => ({
  Store: class {
    id = "comment-draft";
    slots = { blockUpdated: { subscribe: () => ({ unsubscribe() {} }) } };
  },
  nanoid: (() => {
    let id = 0;
    return () => `attachment-${++id}`;
  })(),
}));
vi.mock("@virgultum/editor/components/icons", () => ({
  getAttachmentFileIconRC: () => undefined,
}));
vi.mock("@virgultum/editor/rich-text", () => ({ selectTextModel: vi.fn() }));
vi.mock("@virgultum/editor/shared/services", () => ({
  ViewportElementExtension: () => ({}),
  EditorChromeHostExtension: () => ({}),
}));
vi.mock("@virgultum/editor/shared/utils", () => ({ openFilesWith: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("comment attachment preview lifecycle", () => {
  test("keeps pending previews alive across uploads and replaces them with remote URLs", async () => {
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    const first = Promise.withResolvers<string>();
    const second = Promise.withResolvers<string>();
    const upload = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const doc = new Store({} as never);
    function Draft() {
      const [attachments, setAttachments] = useState<CommentAttachment[]>([]);
      return (
        <CommentEditor
          doc={doc}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          uploadCommentAttachment={upload}
        />
      );
    }
    const view = render(
      <MyoxusUIProvider>
        <Draft />
      </MyoxusUIProvider>,
    );
    const editor = view.container.querySelector('[data-readonly="false"]')!;
    fireEvent.drop(editor, {
      dataTransfer: {
        files: [
          new File(["one"], "one.png", { type: "image/png" }),
          new File(["two"], "two.png", { type: "image/png" }),
        ],
      },
    });
    expect(
      screen.getByRole("img", { name: "one.png" }).getAttribute("src"),
    ).toBe("blob:first");
    expect(
      screen.getByRole("img", { name: "two.png" }).getAttribute("src"),
    ).toBe("blob:second");
    expect(
      screen.getByRole("button", { name: "Submit comment" }),
    ).toHaveProperty("disabled", true);
    expect(revoke).not.toHaveBeenCalled();
    await act(async () => first.resolve("https://server.test/one.png"));
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "one.png" }).getAttribute("src"),
      ).toBe("https://server.test/one.png"),
    );
    expect(
      screen.getByRole("img", { name: "two.png" }).getAttribute("src"),
    ).toBe("blob:second");
    expect(revoke.mock.calls).toEqual([["blob:first"]]);
    expect(
      screen.getByRole("button", { name: "Submit comment" }),
    ).toHaveProperty("disabled", true);
    await act(async () => second.resolve("https://server.test/two.png"));
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "two.png" }).getAttribute("src"),
      ).toBe("https://server.test/two.png"),
    );
    expect(
      screen.getByRole("button", { name: "Submit comment" }),
    ).toHaveProperty("disabled", false);
    expect(revoke.mock.calls).toEqual([["blob:first"], ["blob:second"]]);
    view.unmount();
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
