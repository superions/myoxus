// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";
import { signal } from "@preact/signals-core";
vi.mock("@virgultum/shared/adapters", () => ({ ImageProxyService: "image" }));
vi.mock("@virgultum/shared/services", () => ({
  DocDisplayMetaProvider: "meta",
  DocEmbedProvider: "doc",
  EditorChromeHostIdentifier: "chrome",
  LinkPreviewServiceIdentifier: "preview",
}));
import { renderCitationPreview } from "../footnote-node/citation-preview-session";
function fixture(reference: any) {
  let controls: any,
    current: any = { label: "1", reference },
    resolve: any;
  const footnote = current,
    abort = new AbortController(),
    target = { isConnected: true },
    update = vi.fn(),
    navigate = vi.fn();
  const permission = signal<boolean | undefined>(undefined),
    title = signal("Guarded title"),
    dispose = vi.fn();
  const resolved = signal<any>(undefined);
  const provider = {
    openReference: vi.fn(() => ({ target: resolved, dispose })),
    readable: () => permission,
    referenceTitleSignal: () => title,
  };
  const query = vi.fn(
      (_url: string, _signal?: AbortSignal) =>
        new Promise<any>((r) => (resolve = r)),
    ),
    meta = vi.fn(() => title);
  const services: any = {
    chrome: {
      renderCitationPreview: (c: any) => {
        controls = c;
        return "rendered";
      },
    },
    doc: provider,
    meta: { title: meta },
    preview: { query },
    image: { buildUrl: (url: string) => "PROXY:" + url },
  };
  const store = { readonly: false };
  const std: any = {
    workspace: { id: "local" },
    store,
    getOptional: (id: any) => services[id],
    get: (id: any) => {
      if (!services[id]) throw new Error("Missing " + id);
      return services[id];
    },
  };
  renderCitationPreview(
    std,
    target as HTMLElement,
    footnote,
    () => current,
    abort,
    navigate,
    update,
  );
  return {
    controls,
    abort,
    target,
    update,
    navigate,
    permission,
    title,
    dispose,
    resolved,
    provider,
    query,
    meta,
    store,
    resolve: (v: any) => resolve(v),
    replace: () => (current = { ...current }),
    replaceSource: () =>
      (current = {
        ...current,
        reference: { ...current.reference, url: "https://other.invalid" },
      }),
    set: (id: string, v: any) => (services[id] = v),
  };
}
test("URL enrichment retains proxy-only images and guarded navigation", async () => {
  const f = fixture({ type: "url", url: "https://source.invalid" });
  expect(f.controls.getSnapshot().loading).toBe(true);
  expect(f.query.mock.calls[0][1]).toBe(f.abort.signal);
  f.resolve({
    title: "Resolved",
    description: "Description",
    icon: "https://source.invalid/icon",
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(f.controls.getSnapshot()).toMatchObject({
    title: "Resolved",
    description: "Description",
    image: "PROXY:https://source.invalid/icon",
    loading: false,
  });
  expect(f.update).toHaveBeenCalledOnce();
  f.controls.activate();
  expect(f.navigate).toHaveBeenCalledOnce();
  expect(f.abort.signal.aborted).toBe(true);
});
for (const fence of ["abort", "readonly", "replace", "detach"])
  test("metadata write fence: " + fence, async () => {
    const f = fixture({ type: "url", url: "https://source.invalid" });
    if (fence === "abort") f.abort.abort();
    if (fence === "readonly") f.store.readonly = true;
    if (fence === "replace") f.replace();
    if (fence === "detach") f.target.isConnected = false;
    f.resolve({ title: "Late result" });
    await new Promise((r) => setTimeout(r, 0));
    expect(f.update).not.toHaveBeenCalled();
  });
test("redirected document access stays reactive, guarded and disposed", () => {
  const f = fixture({ type: "doc", docId: "old", workspaceId: "other" });
  expect(f.meta).not.toHaveBeenCalled();
  expect(f.controls.getSnapshot()).toMatchObject({
    title: "",
    available: false,
    loading: true,
  });
  f.resolved.value = {
    access: f.provider,
    collection: { id: "local" },
    docId: "redirected",
  };
  f.permission.value = true;
  expect(f.controls.getSnapshot()).toMatchObject({
    title: "Guarded title",
    available: true,
    docId: "redirected",
  });
  expect(f.meta).toHaveBeenCalledWith("redirected");
  f.permission.value = false;
  expect(f.controls.getSnapshot()).toMatchObject({
    title: "",
    available: false,
  });
  f.controls.activate();
  expect(f.navigate).not.toHaveBeenCalled();
  f.permission.value = true;
  f.controls.activate();
  expect(f.navigate.mock.calls[0][0].reference).toMatchObject({
    workspaceId: "local",
    docId: "redirected",
  });
  expect(f.dispose).toHaveBeenCalledOnce();
});
test("cross-workspace titles do not consume local document metadata", () => {
  const f = fixture({ type: "doc", docId: "foreign", workspaceId: "other" });
  f.resolved.value = {
    access: f.provider,
    collection: { id: "other" },
    docId: "foreign",
  };
  f.permission.value = true;
  expect(f.controls.getSnapshot()).toMatchObject({
    title: "Guarded title",
    available: true,
    docId: undefined,
  });
  expect(f.meta).not.toHaveBeenCalled();
  f.abort.abort();
  expect(f.dispose).toHaveBeenCalledOnce();
});

test("replaced source cannot activate old navigation", () => {
  const f = fixture({
    type: "url",
    url: "https://source.invalid",
    title: "Original",
  });
  f.replaceSource();
  f.controls.activate();
  expect(f.navigate).not.toHaveBeenCalled();
  f.abort.abort();
});
test("unavailable reference is terminal and cannot disclose stored metadata", () => {
  const f = fixture({
    type: "doc",
    docId: "missing",
    description: "Private metadata",
  });
  f.resolved.value = null;
  expect(f.controls.getSnapshot()).toMatchObject({
    title: "",
    description: undefined,
    loading: false,
    available: false,
  });
  f.controls.activate();
  expect(f.navigate).not.toHaveBeenCalled();
  f.abort.abort();
  expect(f.dispose).toHaveBeenCalledOnce();
});
