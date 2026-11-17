// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider, getOrCreateI18n } from "@myoxus/i18n";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  DefaultEditorI18nService,
  interpolateEditorMessage,
  presentToolbarActions,
  ToolbarContext,
} from "@virgultum/core/services";
import { createHighlightActionGroup } from "../../../../../../../../virgultum/editor/all/src/blocks/root/configs/toolbar";
import { signal } from "@preact/signals-core";
import { afterEach, expect, it, vi } from "vitest";
import de from "../../../../../../i18n/src/resources/de.json";
import fr from "../../../../../../i18n/src/resources/fr.json";
import { renderControl } from "./selection-toolbar";
import { SelectionActions } from "./selection-toolbar/block-actions";

vi.unmock("@myoxus/i18n");
afterEach(cleanup);

// The former Lit highlight test follows its actual native consuming renderer.
it("localizes mounted highlight choices without translating the saved CSS value", async () => {
  const locale$ = signal<"de" | "fr">("de");
  const locales = { de, fr };
  const i18n = new DefaultEditorI18nService({
    locale$,
    translate: ({ key, values }) =>
      interpolateEditorMessage(
        (locales[locale$.value] as Record<string, string>)[key] ?? key,
        values,
      ),
  });
  const styles: unknown[] = [];
  const chain = {
    pipe(_command: unknown, input?: { styles?: unknown }) {
      if (input?.styles) styles.push(input.styles);
      return chain;
    },
    try(build: (chain: unknown) => unknown) {
      build(chain);
      return chain;
    },
    run: () => [true, {}],
  };
  const context = Object.create(ToolbarContext.prototype) as ToolbarContext;
  Object.defineProperties(context, {
    std: { value: { getOptional: () => i18n } },
    chain: { value: chain },
  });
  const actions = () =>
    presentToolbarActions([createHighlightActionGroup().actions[0]], context);
  const view = () => (
    <MyoxusUIProvider>
      <I18nextProvider i18n={getOrCreateI18n()}>
        <SelectionActions actions={actions()} renderControl={renderControl} />
      </I18nextProvider>
    </MyoxusUIProvider>
  );
  const mounted = render(view());
  fireEvent.click(screen.getByRole("button"));
  expect(
    (
      await screen.findByRole("menuitem", {
        name: de["com.myoxus.editor.table.color.red"],
      })
    ).textContent,
  ).toContain(de["com.myoxus.editor.table.color.red"]);
  locale$.value = "fr";
  mounted.rerender(view());
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: fr["com.myoxus.editor.table.color.red"],
    }),
  );
  expect(styles.length).toBeGreaterThan(0);
  for (const value of styles)
    expect(value).toEqual({
      color: "var(--myoxus-text-highlight-foreground-red)",
    });
});
