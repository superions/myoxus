// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// @vitest-environment happy-dom

import { signal } from "@preact/signals-core";
import { afterEach, expect, it, vi } from "vitest";
import type { LinkedDocContext, LinkedMenuGroup } from "../config";
import { DocumentPickerSession } from "../document-picker-session";

const sessions: DocumentPickerSession[] = [];
afterEach(() => {
  sessions.forEach((session) => session.cancel());
  sessions.length = 0;
  document.body.replaceChildren();
});
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function picker(getMenus: LinkedDocContext["config"]["getMenus"]) {
  const root = document.createElement("div");
  root.contentEditable = "true";
  document.body.append(root);
  const setQuery = (text: string) => {
    root.textContent = "@" + text;
    const range = document.createRange();
    range.setStart(root.firstChild!, root.textContent.length);
    range.collapse(true);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  };
  setQuery("first");
  const store = { readonly: false };
  const close = vi.fn();
  const session = new DocumentPickerSession({
    std: { store, host: root },
    startRange: { index: 1, length: 0 },
    triggerKey: "@",
    config: { getMenus },
    close,
    inlineEditor: {
      rootElement: root,
      eventSource: root,
      get yTextString() {
        return root.textContent;
      },
      yText: { toString: () => root.textContent },
      getInlineRange: () => ({ index: root.textContent!.length, length: 0 }),
      slots: {
        renderComplete: { subscribe: () => ({ unsubscribe: vi.fn() }) },
      },
    },
  } as unknown as LinkedDocContext);
  sessions.push(session);
  return { session, setQuery, store, close };
}

const group = (name: string, action = vi.fn()): LinkedMenuGroup => ({
  name,
  items: [{ key: name, name, icon: "LinkIcon", action }],
});

it("keeps the latest query when previous results arrive later", async () => {
  const pending = new Map<string, (groups: LinkedMenuGroup[]) => void>();
  const { session, setQuery } = picker(
    (query) => new Promise((resolve) => pending.set(query, resolve)),
  );
  await settle();
  setQuery("second");
  session.refresh();
  await settle();
  pending.get("second")!([group("second")]);
  await settle();
  pending.get("first")!([group("stale")]);
  await settle();
  expect(session.getSnapshot().query).toBe("second");
  expect(session.getSnapshot().groups.map((g) => g.name)).toEqual(["second"]);
});

it("cannot execute hidden, disabled or newly readonly results", async () => {
  const action = vi.fn();
  const hidden = signal(false);
  const items = signal([
    {
      key: "doc",
      name: "Doc",
      icon: "LinkIcon" as const,
      action,
      disabled: true,
    },
  ]);
  const { session, store } = picker(() => [{ name: "Docs", hidden, items }]);
  await settle();
  session.choose("0:doc");
  expect(action).not.toHaveBeenCalled();
  items.value = [{ ...items.value[0], disabled: false }];
  hidden.value = true;
  session.choose("0:doc");
  expect(action).not.toHaveBeenCalled();
  hidden.value = false;
  store.readonly = true;
  session.choose("0:doc");
  expect(action).not.toHaveBeenCalled();
  expect(session.getSnapshot().open).toBe(false);
});

it("aborts pending providers and never republishes after dismissal", async () => {
  let resolve!: (groups: LinkedMenuGroup[]) => void;
  let signal!: AbortSignal;
  const { session, close } = picker((_query, _close, _host, _editor, abort) => {
    signal = abort;
    return new Promise((done) => {
      resolve = done;
    });
  });
  await settle();
  session.cancel();
  expect(signal.aborted).toBe(true);
  resolve([group("late")]);
  await settle();
  expect(session.getSnapshot()).toMatchObject({ open: false, groups: [] });
  expect(close).toHaveBeenCalledOnce();
});
