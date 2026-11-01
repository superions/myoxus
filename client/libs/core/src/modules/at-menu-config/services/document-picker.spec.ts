// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { signal } from "@preact/signals-core";
import { describe, expect, it, vi } from "vitest";

import { AtMenuConfigService } from "./index";

function picker() {
  const allowed = signal(true);
  const action = vi.fn();
  const documents = { name: "Documents", items: [] };
  const members = { name: "Members", items: [] };
  const journals = { name: "Journals", items: [] };
  const create = () => ({
    name: "New",
    items: [
      { key: "create:page", action },
      { key: "create:edgeless", action: vi.fn() },
      { key: "import", action: vi.fn() },
    ],
  });
  const provider = {
    linkToDocGroup: vi.fn(() => documents),
    newDocMenuGroup: vi.fn(create),
    memberGroup: vi.fn(() => members),
    journalGroup: vi.fn(() => journals),
    guardService: { can$: vi.fn(() => ({ signal: allowed })) },
  };
  const getMenus = AtMenuConfigService.prototype["getMenusFn"].call(
    provider as unknown as AtMenuConfigService,
  );
  const invoke = (trigger: string) =>
    getMenus(
      "query",
      () => {},
      {} as never,
      {} as never,
      new AbortController().signal,
      trigger,
    );
  return { invoke, provider, documents, members, journals, allowed, action };
}

describe("document-only picker context", () => {
  it.each(["[[", "【【"])(
    "limits %s to documents and permission-checked page creation",
    async (trigger) => {
      const { invoke, provider, documents, allowed, action } = picker();
      const groups = await invoke(trigger);
      expect(groups).toHaveLength(2);
      expect(groups[0]).toBe(documents);
      expect(groups[0].emptyMessage).toBeTruthy();
      const items = groups[1].items;
      if (Array.isArray(items))
        throw new Error("Expected reactive permissions");
      expect(items.value.map((item) => item.key)).toEqual(["create:page"]);
      const create = items.value[0];
      create.action();
      expect(action).toHaveBeenCalledTimes(1);
      allowed.value = false;
      expect(items.value).toEqual([]);
      create.action();
      expect(action).toHaveBeenCalledTimes(1);
      expect(provider.memberGroup).not.toHaveBeenCalled();
      expect(provider.journalGroup).not.toHaveBeenCalled();
    },
  );
  it("retains the mixed @ menu", async () => {
    const { invoke, provider, members, journals } = picker();
    const groups = await invoke("@");
    expect(groups).toHaveLength(4);
    expect(groups).toContain(members);
    expect(groups).toContain(journals);
    expect(provider.guardService.can$).not.toHaveBeenCalled();
  });
});
