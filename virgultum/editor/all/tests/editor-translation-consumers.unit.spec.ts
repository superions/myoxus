// SPDX-License-Identifier: AGPL-3.0-or-later

import { SurfaceRefPlaceHolder } from "../../../canvas/src/blocks/surface-ref/components/placeholder";
import { DocTitle } from "../../../content/src/doc-title/doc-title";
import { defaultSlashMenuConfig } from "../src/widgets/slash-menu/config";
import { myoxus } from "../../../core/src/test-utils/myoxus-template";
import { Text } from "@virgultum/core/store";
import type { RootBlockModel } from "@virgultum/core/models";

import { signal } from "@preact/signals-core";
import { LitElement } from "lit";
import { afterEach, expect, it, vi } from "vitest";

import de from "../../../../client/libs/i18n/src/resources/de.json";
import en from "../../../../client/libs/i18n/src/resources/en.json";
import es from "../../../../client/libs/i18n/src/resources/es.json";
import fr from "../../../../client/libs/i18n/src/resources/fr.json";
import {
  DefaultEditorI18nService,
  interpolateEditorMessage,
} from "../../../core/src/services";

const locales = { en, de, fr, es };
const mounted: LitElement[] = [];
afterEach(() => mounted.splice(0).forEach((element) => element.remove()));

function translator(language: keyof typeof locales = "de") {
  const locale$ = signal<string>(language);
  const service = new DefaultEditorI18nService({
    locale$,
    translate: ({ key, values }) => {
      const dict = locales[locale$.value as keyof typeof locales];
      return interpolateEditorMessage(
        (dict as Record<string, string>)[key] ?? key,
        values,
      );
    },
  });
  return { locale$, service };
}

customElements.define("test-i18n-doc-title", class extends DocTitle {});

it("updates the title placeholder while leaving the persisted document and workspace untouched", async () => {
  const { locale$, service } = translator();
  const host = myoxus`<myoxus-page><myoxus-note><myoxus-paragraph>Contenu rédigé</myoxus-paragraph></myoxus-note></myoxus-page>`;
  const store = host.store;
  const root = store.root as RootBlockModel;
  root.props.title = new Text("Titre rédigé");
  const docBefore = JSON.stringify(store.spaceDoc.toJSON());
  const workspaceBefore = JSON.stringify(store.workspace.doc.toJSON());
  const viewport = document.createElement("div");
  viewport.className = "myoxus-page-viewport";
  const editorHost = document.createElement("editor-host");
  Object.defineProperty(editorHost, "std", {
    value: { getOptional: () => service },
  });
  viewport.append(editorHost);
  const title = document.createElement("test-i18n-doc-title") as DocTitle;
  title.doc = store;
  viewport.append(title);
  document.body.append(viewport);
  mounted.push(title);
  try {
    await title.updateComplete;
    const container = title.querySelector(".doc-title-container")!;
    expect(container.getAttribute("data-placeholder")).toBe(de.Title);
    locale$.value = "es";
    await title.updateComplete;
    expect(container.getAttribute("data-placeholder")).toBe(es.Title);
    expect(root.props.title.toString()).toBe("Titre rédigé");
    expect(JSON.stringify(store.spaceDoc.toJSON())).toBe(docBefore);
    expect(JSON.stringify(store.workspace.doc.toJSON())).toBe(workspaceBefore);
  } finally {
    viewport.remove();
    store.workspace.dispose();
  }
});

it("inserts ISO date/time content independently of the translated slash label", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 3, 12, 30));
  const host = myoxus`<myoxus-page><myoxus-note><myoxus-paragraph>Préfixe </myoxus-paragraph></myoxus-note></myoxus-page>`;
  const model = host.store.getModelsByFlavour("myoxus:paragraph")[0];
  const { locale$, service } = translator("fr");
  const std = {
    getOptional: () => service,
    view: {
      getBlock: () => ({
        querySelector: () => ({
          inlineEditor: { getInlineRange: () => null, setInlineRange: vi.fn() },
        }),
      }),
    },
  };
  try {
    const items =
      typeof defaultSlashMenuConfig.items === "function"
        ? defaultSlashMenuConfig.items({ std, model } as never)
        : defaultSlashMenuConfig.items;
    for (const [id, expected] of [
      ["action-today", "2026-10-03"],
      ["action-now", "2026-10-03 12:30"],
    ]) {
      const item = items.find((item) => item.id === id)!;
      expect("action" in item).toBe(true);
      locale$.value = "de";
      if ("action" in item) item.action({ std, model } as never);
      expect(model.text?.toString()).toContain(expected);
    }
  } finally {
    host.store.workspace.dispose();
    vi.useRealTimers();
  }
});

customElements.define(
  "test-i18n-surface-placeholder",
  class extends SurfaceRefPlaceHolder {},
);
it("localizes unavailable surface references without changing their flavour", async () => {
  const { locale$, service } = translator();
  const placeholder = document.createElement(
    "test-i18n-surface-placeholder",
  ) as SurfaceRefPlaceHolder;
  placeholder.i18n = service;
  placeholder.refFlavour = "myoxus:frame";
  mounted.push(placeholder);
  document.body.append(placeholder);
  await placeholder.updateComplete;
  expect(placeholder.textContent).toContain(
    de["com.myoxus.editor.slash.frame"],
  );
  expect(placeholder.textContent).toContain(
    de["com.myoxus.editor.surface-ref.deleted"],
  );
  locale$.value = "fr";
  await placeholder.updateComplete;
  expect(placeholder.textContent).toContain(
    fr["com.myoxus.editor.surface-ref.deleted"],
  );
  expect(placeholder.refFlavour).toBe("myoxus:frame");
});
