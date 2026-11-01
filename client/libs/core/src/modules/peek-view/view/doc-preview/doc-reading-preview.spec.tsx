// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { DocsService } from "@myoxus/core/modules/doc";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { GuardService } from "@myoxus/core/modules/permissions";
import { FetchService, ServerService } from "@myoxus/core/modules/server";
import {
  WorkspaceService,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import { WorkspaceImpl } from "@myoxus/core/modules/workspace/impls/workspace";
import { toArrayBuffer } from "@myoxus/core/utils/array-buffer";
import { LiveData } from "@myoxus/infra";
import type { RootBlockModel } from "@virgultum/editor/model";
import { Text } from "@virgultum/editor/store";
import { afterEach, expect, test, vi } from "vitest";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";

const services = vi.hoisted(() => new Map<unknown, unknown>());
vi.mock("@myoxus/infra", async (original) => ({
  ...(await original<typeof import("@myoxus/infra")>()),
  useService: (token: unknown) => services.get(token),
}));

import { useDocReadingPreview } from "./doc-reading-preview";

const collections: WorkspaceImpl[] = [];
function snapshot(docId: string, title: string) {
  const collection = new WorkspaceImpl({
    id: "workspace-1",
    rootDoc: new YDoc(),
  });
  collection.meta.initialize();
  const page = collection.createDoc(docId).getStore();
  page.load();
  page.addBlock("myoxus:page", { title: new Text(title) });
  collections.push(collection);
  return toArrayBuffer(encodeStateAsUpdate(page.spaceDoc));
}

function harness(fetch: ReturnType<typeof vi.fn>) {
  const account$ = new LiveData<{ id: string } | null>({ id: "actor" });
  const ready$ = new LiveData(true);
  const index$ = new LiveData({ phase: "ready" });
  const records = new Map([
    [
      "doc-a",
      new LiveData<{ trash$: LiveData<boolean> } | undefined>({
        trash$: new LiveData(false),
      }),
    ],
    [
      "doc-b",
      new LiveData<{ trash$: LiveData<boolean> } | undefined>({
        trash$: new LiveData(false),
      }),
    ],
  ]);
  const modes = new Map([
    ["doc-a", new LiveData<"page" | "edgeless" | undefined>("page")],
    ["doc-b", new LiveData<"page" | "edgeless" | undefined>("page")],
  ]);
  const grants = new Map([
    ["doc-a", new LiveData<boolean | undefined>(true)],
    ["doc-b", new LiveData<boolean | undefined>(true)],
  ]);
  const list = {
    isReady$: ready$,
    doc$: (id: string) => records.get(id),
    primaryMode$: (id: string) => modes.get(id),
    getPrimaryMode: (id: string) => modes.get(id)?.value,
  };
  const can = vi.fn(
    async (_action: string, id: string) => grants.get(id)?.value === true,
  );
  services.set(DocsService, { list });
  services.set(DocumentMetadataCacheService, {
    watchIndexState: () => index$,
    getIndexRowByExternalId: (id: string) =>
      records.get(id)?.value
        ? { primaryMode: modes.get(id)?.value ?? null }
        : undefined,
  });
  services.set(GuardService, {
    can$: (_action: string, id: string) => grants.get(id),
    can,
  });
  services.set(FetchService, { fetch });
  services.set(ServerService, { server: { id: "server-1", account$ } });
  services.set(WorkspaceService, {
    workspace: { id: "workspace-1", meta: {} },
  });
  services.set(WorkspacesService, {
    getWorkspaceFlavourProvider: () => undefined,
  });
  services.set(FeatureFlagService, undefined);
  return { account$, records, modes, grants, index$, can };
}

afterEach(() => {
  cleanup();
  services.clear();
  for (const collection of collections.splice(0)) {
    collection.dispose();
    collection.doc.destroy();
  }
});

test("a superseded read cannot display its bytes; admitted pages are detached and readonly", async () => {
  const bytesA = snapshot("doc-a", "A");
  const bytesB = snapshot("doc-b", "B");
  let resolveA!: (response: Response) => void;
  const fetch = vi.fn((url: string) =>
    url.endsWith("doc-a")
      ? new Promise<Response>((resolve) => {
          resolveA = resolve;
        })
      : Promise.resolve(new Response(bytesB)),
  );
  harness(fetch);
  const { result, rerender } = renderHook(
    ({ docId }) => useDocReadingPreview(docId),
    { initialProps: { docId: "doc-a" } },
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  rerender({ docId: "doc-b" });
  await waitFor(() => expect(result.current.state.kind).toBe("ready"));
  if (result.current.state.kind !== "ready") throw new Error("Missing page");
  const page = result.current.state.page;
  expect(page.id).toBe("doc-b");
  expect(page.readonly).toBe(true);
  expect(String((page.root as RootBlockModel).props.title)).toBe("B");
  await act(async () => resolveA(new Response(bytesA)));
  expect(result.current.state).toEqual({ kind: "ready", page });
});

test("revocation, trash, removed records and modes hide the store without waiting for a fetch", async () => {
  const bytes = snapshot("doc-a", "Current");
  const fetch = vi.fn(async () => new Response(bytes.slice(0)));
  const { grants, records, modes, account$, can } = harness(fetch);
  const { result, rerender } = renderHook(() => useDocReadingPreview("doc-a"));
  await waitFor(() => expect(result.current.state.kind).toBe("ready"));
  act(() => grants.get("doc-a")!.next(false));
  expect(result.current.state.kind).toBe("denied");
  act(() => grants.get("doc-a")!.next(true));
  await waitFor(() => expect(result.current.state.kind).toBe("ready"));
  act(() => records.get("doc-a")!.value!.trash$.next(true));
  expect(result.current.state.kind).toBe("unavailable");
  act(() => records.get("doc-a")!.value!.trash$.next(false));
  await waitFor(() => expect(result.current.state.kind).toBe("ready"));
  act(() => modes.get("doc-a")!.next("edgeless"));
  expect(result.current.state.kind).toBe("unsupported");
  act(() => modes.get("doc-a")!.next("page"));
  act(() => records.get("doc-a")!.next(undefined));
  expect(result.current.state.kind).toBe("unavailable");
  act(() => account$.next({ id: "other-actor" }));
  rerender();
  expect(result.current.state.kind).toBe("unavailable");
  expect(can).toHaveBeenCalledWith("Doc_Read", "doc-a");
});

test("a missing mode only becomes the Page default after its index row is confirmed", async () => {
  const bytes = snapshot("doc-a", "Legacy Page");
  const fetch = vi.fn(async () => new Response(bytes.slice(0)));
  const { modes, index$ } = harness(fetch);
  modes.get("doc-a")!.next(undefined);
  index$.next({ phase: "unloaded" });
  const { result } = renderHook(() => useDocReadingPreview("doc-a"));
  expect(result.current.state.kind).toBe("loading");
  expect(fetch).not.toHaveBeenCalled();
  act(() => index$.next({ phase: "ready" }));
  await waitFor(() => expect(result.current.state.kind).toBe("ready"));
});
