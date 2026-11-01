// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { LiveData } from "@myoxus/infra";
import {
  createMyoxusHostService,
  NullMyoxusHostService,
} from "@virgultum/shared/services";
import { expect, test, vi } from "vitest";

import {
  createMyoxusHostServiceAdapter,
  type MyoxusHostAdapterDeps,
} from "./myoxus-host-adapter";

test("editor host reads the current document from the existing live template owner", () => {
  const state = new LiveData(false);
  const isTemplate$ = vi.fn(() => state);
  // Uncalled services deliberately have no fake implementations. This test
  // exercises only the template boundary, not unrelated host capabilities.
  const host = createMyoxusHostServiceAdapter({
    store: { id: "source" },
    templateDocService: { list: { isTemplate$ } },
  } as unknown as MyoxusHostAdapterDeps);
  expect(host.isTemplateDocument()).toBe(false);
  state.setValue(true);
  expect(host.isTemplateDocument()).toBe(true);
  state.setValue(false);
  expect(host.isTemplateDocument()).toBe(false);
  expect(isTemplate$).toHaveBeenCalledWith("source");
});

test("hosts without a catalogue default authoring off and retain explicit live methods", () => {
  const base = {
    capabilities: [],
    openEventEditDialog: async () => null,
    resolveEventData: async () => null,
    hasImageProxyUrl: () => false,
    isFeatureEnabled: () => false,
    getWorkspaceId: () => "workspace",
  };
  expect(createMyoxusHostService(base).isTemplateDocument()).toBe(false);

  expect(new NullMyoxusHostService().isTemplateDocument()).toBe(false);

  let template = false;
  const host = createMyoxusHostService({
    ...base,
    isTemplateDocument: () => template,
  });
  expect(host.isTemplateDocument()).toBe(false);
  template = true;
  expect(host.isTemplateDocument()).toBe(true);
  template = false;
  expect(host.isTemplateDocument()).toBe(false);
});
