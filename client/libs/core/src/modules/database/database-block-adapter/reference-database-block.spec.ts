// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import {
  DatabaseReferenceBlockModel,
  DatabaseReferenceBlockSchema,
  DatabaseReferenceStoreExtension,
} from "@virgultum/block-database/reference-store";
import {
  DatabaseReferenceBlockComponent,
  DatabaseReferenceConfigExtension,
} from "@virgultum/editor/blocks/database/reference-view";
import { html, nothing, type TemplateResult } from "lit";
import { describe, expect, test, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { cssVar } from "@myoxus/theme";
import {
  PropertySymbol,
  type HTMLElement as HappyDOMHTMLElement,
} from "happy-dom";

import {
  defineDatabaseEmbedElement,
  resolveEmbeddedColorScheme,
} from "./server-database-block";

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});

function createBlock(
  props: Record<string, unknown>,
  renderServerDatabase = vi.fn(
    (_model: unknown) => html`<span>server view</span>`,
  ),
) {
  const model = { id: "block-1", props };
  const block = {
    model,
    std: {
      getOptional(identifier: unknown) {
        expect(identifier).toBe(DatabaseReferenceConfigExtension.identifier);
        return { renderServerDatabase, slashMenuItems: [] };
      },
    },
  };
  const renderBlock = () =>
    DatabaseReferenceBlockComponent.prototype.renderBlock.call(block as never);
  return { model, renderBlock, renderServerDatabase };
}

describe("DatabaseReferenceBlockComponent", () => {
  test("registers a reference-only schema without local Database defaults", () => {
    expect(DatabaseReferenceBlockSchema.model.flavour).toBe("myoxus:database");
    expect(DatabaseReferenceBlockSchema.model.props({} as never)).toEqual({
      serverDatabaseId: undefined,
      serverWorkspaceId: undefined,
      serverRowId: undefined,
      serverViewId: null,
      serverReferencePresentation: undefined,
      templateReference: undefined,
    });
    expect(new DatabaseReferenceBlockModel()).toBeInstanceOf(
      DatabaseReferenceBlockModel,
    );

    const register = vi.fn();
    const context = {
      scope: "store" as const,
      register(extension: unknown) {
        register(extension);
        return context;
      },
    };
    new DatabaseReferenceStoreExtension().setup(context);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ setup: expect.any(Function) }),
    );
    expect(register).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([
        expect.objectContaining({ setup: expect.any(Function) }),
      ]),
    );
    expect(register.mock.calls[1][0]).toHaveLength(3);
  });

  test("uses the nearest editor theme across renderer shadow roots", () => {
    document.documentElement.dataset.theme = "dark";
    const editorTheme = document.createElement("div");
    editorTheme.dataset.theme = "light";
    const rendererHost = document.createElement("div");
    editorTheme.append(rendererHost);
    document.body.append(editorTheme);
    const embed = document.createElement("myoxus-database-embed");
    rendererHost.attachShadow({ mode: "open" }).append(embed);

    expect(resolveEmbeddedColorScheme(embed)).toBe("light");

    editorTheme.dataset.theme = "dark";
    expect(resolveEmbeddedColorScheme(embed)).toBe("dark");
    editorTheme.remove();
    delete document.documentElement.dataset.theme;
  });

  test("materializes Facade text roles at the local light embed boundary while the application remains dark", async () => {
    const previousTheme = document.documentElement.getAttribute("data-theme");
    document.documentElement.dataset.theme = "dark";
    const editorTheme = document.createElement("div");
    editorTheme.dataset.theme = "light";
    const rendererHost = document.createElement("div");
    editorTheme.append(rendererHost);
    const renderer = rendererHost.attachShadow({ mode: "open" });
    // The repository Lit setup replaces only customElements with a no-op
    // registry. Restore its native lifecycle for this consuming boundary test.
    const setupRegistry = customElements;
    vi.unstubAllGlobals();
    defineDatabaseEmbedElement();
    const embed = document.createElement("myoxus-database-embed");
    embed.setAttribute("reference-mode", "unavailable");
    const nativeThemeDeliveries: unknown[] = [];
    try {
      await act(async () => {
        document.body.append(editorTheme);
        // Connect directly into the live shadow tree so HappyDOM invokes the
        // same custom-element lifecycle as the browser's renderer insertion.
        renderer.append(embed);
        // HappyDOM 20.11.1 retains these forwarding closures only through
        // WeakRef. Keep the actual native deliveries alive across React awaits;
        // GC otherwise silently removes the live production observer listener.
        nativeThemeDeliveries.push(
          ...(editorTheme as unknown as HappyDOMHTMLElement)[
            PropertySymbol.mutationListeners
          ].map((listener) => listener.callback.deref()),
        );
      });
      expect(embed.isConnected).toBe(true);
      expect(embed.getRootNode()).toBe(renderer);
      await waitFor(() =>
        expect(embed.getAttribute("data-mantine-color-scheme")).toBe("light"),
      );
      const rootId = embed.getAttribute("data-myoxus-database-react-root");
      expect(rootId).toMatch(/^\d+$/);
      const selector = `[data-myoxus-database-react-root="${rootId}"]`;
      const projection =
        embed
          .querySelector("style[data-mantine-styles]")
          ?.textContent?.replace(/\s+/g, "") ?? "";
      expect(projection).toContain(
        `${selector}[data-mantine-color-scheme="light"]`,
      );
      expect(projection).toContain(
        `--mantine-color-text:${cssVar("textPrimaryColor")}`,
      );
      expect(projection).toContain(
        `--mantine-color-myoxus-text-primary-text:${cssVar("textPrimaryColor")}`,
      );
      expect(projection).toContain(
        `--mantine-color-myoxus-text-secondary-text:${cssVar("textSecondaryColor")}`,
      );
      expect(document.documentElement.dataset.theme).toBe("dark");
      await act(async () => {
        editorTheme.setAttribute("data-theme", "dark");
      });
      await waitFor(() =>
        expect(embed.getAttribute("data-mantine-color-scheme")).toBe("dark"),
      );
      expect(embed.getAttribute("data-myoxus-database-react-root")).toBe(
        rootId,
      );
      expect(nativeThemeDeliveries).toHaveLength(1);
      expect(nativeThemeDeliveries[0]).toEqual(expect.any(Function));
    } finally {
      await act(async () => {
        embed.remove();
        editorTheme.remove();
      });
      nativeThemeDeliveries.length = 0;
      if (previousTheme === null)
        document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", previousTheme);
      vi.stubGlobal("customElements", setupRegistry);
    }
  });

  test.each(["document", "edgeless"])(
    "delegates the same reference-only host in %s mode",
    () => {
      const props = {
        serverDatabaseId: "database-1",
        serverViewId: "view-1",
      };
      for (const legacyKey of ["cells", "columns", "rows", "views"]) {
        Object.defineProperty(props, legacyKey, {
          get() {
            throw new Error(`reference shell read legacy ${legacyKey}`);
          },
        });
      }
      const { model, renderBlock, renderServerDatabase } = createBlock(props);

      const result = renderBlock() as TemplateResult;

      expect(renderServerDatabase).toHaveBeenCalledOnce();
      expect(renderServerDatabase.mock.calls[0]?.[0]).toBe(model);
      expect(result.values).toContain("database-1");
    },
  );

  test("does not render an editor-local payload without a server reference", () => {
    const { renderBlock, renderServerDatabase } = createBlock({
      cells: { row: { field: { value: "legacy" } } },
      columns: [{ id: "field" }],
      views: [{ id: "view" }],
    });

    expect(renderBlock()).toBe(nothing);
    expect(renderServerDatabase).not.toHaveBeenCalled();
  });
});
