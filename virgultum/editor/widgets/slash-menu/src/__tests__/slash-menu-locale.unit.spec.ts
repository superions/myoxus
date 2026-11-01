// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { SlashSession } from "../slash-session";
import type { SlashMenuContext } from "../types";
import type { MyoxusInlineEditor } from "@virgultum/shared/types";
import { signal } from "@preact/signals-core";
import {
  DefaultEditorI18nService,
  editorMessage,
  EditorI18nProvider,
} from "@virgultum/shared/services";
import { expect, it, vi } from "vitest";
vi.mock("@virgultum/rich-text", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@virgultum/rich-text")>()),
  getTextContentFromInlineRange: () => "kop",
}));
it("recomputes an existing slash query when the account locale changes", async () => {
  const locale$ = signal("de");
  const service = new DefaultEditorI18nService({
    locale$,
    translate: () => (locale$.value === "de" ? "Kopieren" : "Copy"),
  });
  const source = document.createElement("div");
  document.body.append(source);
  const session = new SlashSession(
    {
      std: {
        store: { readonly: false },
        getOptional: (id: unknown) =>
          id === EditorI18nProvider ? service : undefined,
        get: () => ({ getEditorMode: () => "page" }),
      },
    } as unknown as SlashMenuContext,
    {
      eventSource: source,
      getInlineRange: () => ({ index: 1, length: 0 }),
      yText: { toString: () => "/kop" },
      slots: {
        renderComplete: { subscribe: () => ({ unsubscribe: () => {} }) },
      },
    } as unknown as MyoxusInlineEditor,
    "/",
    {
      items: [
        {
          id: "action-copy",
          label: editorMessage("Copy", "Copy"),
          action: vi.fn(),
        },
      ],
    },
    (item) => item,
  );
  expect(session.getSnapshot().options.map((item) => item.id)).toEqual([
    "action-copy",
  ]);
  locale$.value = "en";
  expect(session.getSnapshot().options).toEqual([]);
  locale$.value = "de";
  expect(session.getSnapshot().options.map((item) => item.id)).toEqual([
    "action-copy",
  ]);
  session.cancel();
  source.remove();
});
