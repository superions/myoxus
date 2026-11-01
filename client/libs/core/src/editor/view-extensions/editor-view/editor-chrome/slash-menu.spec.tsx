// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { act, cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider, getOrCreateI18n } from "@myoxus/i18n";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import type {
  EditorSlashControls,
  EditorSlashState,
} from "@virgultum/editor/shared/services";
import { afterEach, expect, it, vi } from "vitest";
import { EditorSlashMenu } from "./slash-menu";

vi.unmock("@myoxus/i18n");
afterEach(cleanup);

// Retains the previous mounted-locale contract at the new production renderer.
it("updates mounted labels from its session and releases the subscription on unmount", () => {
  const listeners = new Set<() => void>();
  let snapshot: EditorSlashState = {
    open: true,
    query: "",
    depth: 0,
    options: [
      { id: "action-copy", label: "Kopieren", group: "", submenu: false },
    ],
  };
  const input = document.createElement("div");
  const controls: EditorSlashControls = {
    input,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeKeys: () => () => {},
    setAnchor: () => {},
    choose: () => {},
    back: () => {},
    cancel: () => {},
  };
  const view = render(
    <MyoxusUIProvider>
      <I18nextProvider i18n={getOrCreateI18n()}>
        <EditorSlashMenu controls={controls} />
      </I18nextProvider>
    </MyoxusUIProvider>,
  );
  expect(screen.getByRole("option").textContent).toBe("Kopieren");
  act(() => {
    snapshot = {
      ...snapshot,
      options: [{ ...snapshot.options[0], label: "Copy" }],
    };
    listeners.forEach((listener) => listener());
  });
  expect(screen.getByRole("option").textContent).toBe("Copy");
  expect(screen.getByTestId("slash-menu-item-action-copy")).toBeTruthy();
  view.unmount();
  expect(listeners.size).toBe(0);
});
