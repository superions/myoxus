// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { Framework } from "@myoxus/infra";
import { firstValueFrom, of } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import { WorkspaceDBService } from "../../db";
import { WorkspaceService } from "../../workspace";
import { TemplateDocListStore } from "./list";

function createStore(
  flavour: "local" | "cloud",
  docProperties: Record<string, unknown>,
) {
  const framework = new Framework();
  (framework as any).service(WorkspaceService, {
    workspace: { flavour },
  });
  (framework as any).service(WorkspaceDBService, {
    db: { docProperties },
  });
  framework.store(TemplateDocListStore, [WorkspaceDBService, WorkspaceService]);
  return framework.provider().get(TemplateDocListStore);
}

describe("TemplateDocListStore local ownership", () => {
  test("server-backed workspaces never touch the local docProperties table", async () => {
    const fail = () => {
      throw new Error("server-backed template list touched local storage");
    };
    const store = createStore("cloud", {
      find: fail,
      find$: fail,
    });

    expect(store.isTemplateDoc("doc-1")).toBe(false);
    expect(store.getTemplateDocIds()).toEqual([]);
    await expect(firstValueFrom(store.watchTemplateDoc("doc-1"))).resolves.toBe(
      false,
    );
    await expect(firstValueFrom(store.watchTemplateDocs())).resolves.toEqual(
      [],
    );
  });

  test("local workspaces retain the existing template table", async () => {
    const rows = [{ id: "template-1", isTemplate: true }];
    const find = vi.fn(() => rows);
    const find$ = vi.fn(() => of(rows));
    const store = createStore("local", { find, find$ });

    expect(store.isTemplateDoc("template-1")).toBe(true);
    expect(store.getTemplateDocIds()).toEqual(["template-1"]);
    await expect(
      firstValueFrom(store.watchTemplateDoc("template-1")),
    ).resolves.toBe(true);
    await expect(firstValueFrom(store.watchTemplateDocs())).resolves.toEqual(
      rows,
    );
    expect(find).toHaveBeenCalledWith({ isTemplate: true });
    expect(find$).toHaveBeenCalledWith({ isTemplate: true });
  });
});
