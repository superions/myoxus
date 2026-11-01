// SPDX-License-Identifier: AGPL-3.0-or-later

import { SurfaceRefPlaceHolder } from "../../blocks/surface-ref/src/components/placeholder";
import { DocTitle } from "../../fragments/doc-title/src/doc-title";
import { defaultSlashMenuConfig } from "../../widgets/slash-menu/src/config";
import { myoxus } from "../src/test-utils";
import { Text } from "@virgultum/store";
import type { RootBlockModel } from "@virgultum/model";
import { EditorMenuButton } from "../../components/src/toolbar/menu-button";
import {
  Menu,
  menu,
  MenuComponent,
  MenuButton,
} from "../../components/src/context-menu";

import { signal } from "@preact/signals-core";
import { LitElement } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";

import de from "../../../../client/libs/i18n/src/resources/de.json";
import en from "../../../../client/libs/i18n/src/resources/en.json";
import es from "../../../../client/libs/i18n/src/resources/es.json";
import fr from "../../../../client/libs/i18n/src/resources/fr.json";
import { FilterableListComponent } from "../../components/src/filterable-list";
import { HighlightDropdownMenu } from "../../components/src/highlight-dropdown-menu/dropdown-menu";
import { NoteDisplayModePanel } from "../../gfx/note/src/components/note-display-mode-panel";
import { NoteDisplayMode } from "../../model/src";
import {
  DefaultEditorI18nService,
  editorMessage,
  interpolateEditorMessage,
  ToolbarContext,
} from "../src/services";

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
  const context = Object.create(ToolbarContext.prototype) as ToolbarContext;
  Object.defineProperty(context, "std", {
    value: { getOptional: () => service },
  });
  Object.defineProperty(context, "theme", {
    value: { theme$: signal("light") },
  });
  return { locale$, service, context };
}

async function mount<T extends LitElement>(element: T) {
  mounted.push(element);
  document.body.append(element);
  await element.updateComplete;
  return element.shadowRoot!;
}

customElements.define(
  "test-i18n-filter-list",
  class extends FilterableListComponent {},
);

customElements.define(
  "test-i18n-highlight-menu",
  class extends HighlightDropdownMenu {},
);
customElements.define(
  "test-i18n-mode-panel",
  class extends NoteDisplayModePanel {},
);

describe("mounted editor translation consumers", () => {
  it("recomputes translated search without changing its query or selection identity", async () => {
    const { locale$, service } = translator();
    const list = document.createElement(
      "test-i18n-filter-list",
    ) as FilterableListComponent;
    const selected = vi.fn();
    const item = { name: "copy-command", label: editorMessage("Copy", "Copy") };
    list.options = { i18n: service, items: [item], onSelect: selected };
    const root = await mount(list);
    const input = root.querySelector("input")!;
    expect(input.placeholder).toBe(de["Quick search"]);
    input.value = "kop";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await list.updateComplete;
    expect(root.querySelector(".filterable-item")?.textContent).toContain(
      de.Copy,
    );
    locale$.value = "en";
    await list.updateComplete;
    expect(input.value).toBe("kop");
    expect(root.querySelector(".filterable-item")).toBeNull();
    locale$.value = "de";
    await list.updateComplete;
    (root.querySelector(".filterable-item") as HTMLElement).click();
    expect(selected).toHaveBeenCalledWith(item);
    expect(item.name).toBe("copy-command");
    list.remove();
    const updates = vi.spyOn(list, "requestUpdate");
    locale$.value = "fr";
    expect(updates).not.toHaveBeenCalled();
  });

  it("keeps standalone English fallback and technical language names", async () => {
    const list = document.createElement(
      "test-i18n-filter-list",
    ) as FilterableListComponent;
    list.options = {
      items: [{ name: "typescript", label: "TypeScript" }],
      onSelect: vi.fn(),
    };
    const root = await mount(list);
    expect(root.querySelector("input")?.placeholder).toBe("Search");
    expect(root.querySelector(".filterable-item")?.textContent).toContain(
      "TypeScript",
    );
  });

  it("localizes mode labels and colors without translating saved enum/CSS values", async () => {
    const { locale$, service } = translator();
    const mode = document.createElement(
      "test-i18n-mode-panel",
    ) as NoteDisplayModePanel;
    mode.i18n = service;
    mode.displayMode = NoteDisplayMode.DocOnly;
    mode.onSelect = vi.fn();
    const modeRoot = await mount(mode);
    const highlight = document.createElement(
      "test-i18n-highlight-menu",
    ) as HighlightDropdownMenu;
    highlight.i18n = service;
    highlight.updateHighlight = vi.fn();
    const colorRoot = await mount(highlight);
    locale$.value = "fr";
    await Promise.all([mode.updateComplete, highlight.updateComplete]);
    expect(modeRoot.querySelector(".selected")?.textContent).toContain(
      fr["com.myoxus.editor.note.mode-page-only"],
    );
    (modeRoot.querySelector(".selected") as HTMLElement).click();
    expect(mode.onSelect).toHaveBeenCalledWith(NoteDisplayMode.DocOnly);
    const red = colorRoot.querySelector(
      '[data-testid="foreground-red"]',
    ) as HTMLElement;
    expect(red.textContent).toContain(fr["com.myoxus.editor.table.color.red"]);
    red.click();
    expect(highlight.updateHighlight).toHaveBeenCalledWith({
      color: "var(--myoxus-text-highlight-foreground-red)",
    });
  });
});

if (!customElements.get("editor-menu-button"))
  customElements.define(
    "editor-menu-button",
    class extends EditorMenuButton {},
  );

if (!customElements.get("myoxus-menu"))
  customElements.define("myoxus-menu", class extends MenuComponent {});
if (!customElements.get("myoxus-menu-button"))
  customElements.define("myoxus-menu-button", class extends MenuButton {});

it("re-filters an open context menu in the account language without changing action identity", async () => {
  const { locale$, service } = translator();
  const selected = vi.fn();
  const contextMenu = new Menu({
    i18n: service,
    items: [
      menu.action({
        name: "copy-stable",
        label: editorMessage("Copy", "Copy"),
        select: selected,
      }),
    ],
  });
  const element = contextMenu.menuElement as MenuComponent;
  mounted.push(element);
  document.body.append(element);
  contextMenu.searchName$.value = "kop";
  await element.updateComplete;
  expect(element.textContent).toContain(de.Copy);
  locale$.value = "en";
  await element.updateComplete;
  expect(contextMenu.searchName$.value).toBe("kop");
  expect(element.querySelector("myoxus-menu-button")).toBeNull();
  locale$.value = "de";
  await element.updateComplete;
  const action = element.querySelector("myoxus-menu-button") as MenuButton;
  await action.updateComplete;
  action.onPressEnter();
  expect(selected).toHaveBeenCalledTimes(1);
  expect(contextMenu.search("copy-stable")).toBe(false);
  contextMenu.searchName$.value = "copy-stable";
  expect(contextMenu.search("copy-stable", editorMessage("Copy", "Copy"))).toBe(
    true,
  );
  contextMenu.close();
});

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
