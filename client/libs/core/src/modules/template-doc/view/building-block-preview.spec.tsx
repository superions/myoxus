// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { LiveData } from "@myoxus/infra";
import { Text, type Store } from "@virgultum/store";
import { Doc as YDoc } from "yjs";
import { afterEach, expect, test, vi } from "vitest";
import { createContext, useContext, type ReactNode } from "react";

import { DocsService } from "../../doc";
import { FeatureFlagService } from "../../feature-flag";
import { GuardService } from "../../permissions";
import { WorkbenchService } from "../../workbench/services/workbench";
import { WorkspaceService, WorkspacesService } from "../../workspace";
import { WorkspaceImpl } from "../../workspace/impls/workspace";
import { BuildingBlockPreview } from "./building-block-preview";
import { TemplateDocService } from "../services/template-doc";

const services = vi.hoisted(() => new Map<unknown, unknown>());
const PreviewScopes = createContext<unknown[]>([]);
vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  FrameworkScope: ({
    scope,
    children,
  }: {
    scope: unknown;
    children: ReactNode;
  }) => (
    <PreviewScopes.Provider value={[...useContext(PreviewScopes), scope]}>
      {children}
    </PreviewScopes.Provider>
  ),
  useService: (token: unknown) => {
    if (!services.has(token)) throw new Error("Unexpected preview service");
    return services.get(token);
  },
}));
vi.mock("../../../editor/virgultum/doc-editor", () => ({
  VirgultumEditor: ({
    page,
    snapshot,
    readonly,
    templateSourcePreview,
  }: {
    page: Store;
    snapshot?: boolean;
    readonly?: boolean;
    templateSourcePreview?: boolean;
  }) => {
    // Native view extensions require both scopes even in an isolated snapshot.
    if (useContext(PreviewScopes).length !== 2)
      throw new Error("Missing native host scopes");
    if (!snapshot || !readonly || !templateSourcePreview)
      throw new Error("Source preview must remain isolated and unresolved");
    return (
      <section aria-label="Native preview">
        {page
          .getAllModels()
          .filter((model) => model.flavour === "myoxus:paragraph")
          .map((model) => String((model.props as { text: Text }).text))
          .join("\n")}
      </section>
    );
  },
}));

const collections: WorkspaceImpl[] = [];
afterEach(() => {
  cleanup();
  for (const collection of collections.splice(0)) {
    collection.dispose();
    collection.doc.destroy();
  }
  services.clear();
  vi.unstubAllGlobals();
});

test("only the current authorized source remains visible and retained", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 200 })),
  );
  const collection = new WorkspaceImpl({
    id: "preview-workspace",
    rootDoc: new YDoc(),
  });
  collection.meta.initialize();
  collections.push(collection);
  let readySecond!: () => void;
  const pendingSecond = new Promise<void>((resolve) => {
    readySecond = resolve;
  });
  const allowed$ = new LiveData(true);
  const entries = new Map(
    ["first", "second"].map((id) => {
      const store = collection.createDoc(id).getStore();
      store.load();
      store.addBlock("myoxus:page", { title: new Text(id) });
      const note = store.addBlock("myoxus:note", {}, store.root!.id);
      store.addBlock(
        "myoxus:paragraph",
        { text: new Text(`${id} private body`) },
        note,
      );
      return [
        id,
        {
          release: vi.fn(),
          doc: {
            scope: {
              get: () => ({
                createEditor: () => ({
                  scope: { dispose: vi.fn() },
                  dispose: vi.fn(),
                }),
              }),
            },
            id,
            virgultumDoc: store,
            yDoc: store.spaceDoc,
            title$: new LiveData(id),
            trash$: new LiveData(false),
            getProperties: () => ({}),
            waitForSyncReady: () => Promise.resolve(),
          },
        },
      ] as const;
    }),
  );
  services.set(DocsService, {
    list: { doc$: (id: string) => new LiveData(entries.get(id)?.doc) },
    open: (id: string) => entries.get(id),
  });
  const lookupTemplateSource = vi.fn(async (templateDocId: string) => ({
    templateDocId,
    category: "building-blocks",
    available: true,
  }));
  services.set(TemplateDocService, {
    lookupTemplateSource,
  });
  services.set(GuardService, {
    can$: (action: string) => {
      if (action !== "Workspace_Read")
        throw new Error("Unexpected source grant query");
      return allowed$;
    },
  });
  services.set(FeatureFlagService, undefined);
  const waitForDocReady = vi.fn((id: string) =>
    id === "second" ? pendingSecond : Promise.resolve(),
  );
  services.set(WorkspaceService, {
    workspace: {
      id: collection.id,
      meta: { id: collection.id },
      engine: { doc: { waitForDocReady } },
    },
  });
  services.set(WorkspacesService, {
    getWorkspaceFlavourProvider: () => undefined,
  });
  services.set(WorkbenchService, { workbench: { openDoc: vi.fn() } });
  const view = (sourceDocId: string) => (
    <MyoxusUIProvider>
      <BuildingBlockPreview sourceDocId={sourceDocId} />
    </MyoxusUIProvider>
  );
  const mounted = render(view("first"));
  await screen.findByText("first private body");
  expect(lookupTemplateSource).toHaveBeenLastCalledWith(
    "first",
    expect.any(String),
  );

  mounted.rerender(view("second"));
  await waitFor(() =>
    expect(waitForDocReady).toHaveBeenCalledWith(
      "second",
      expect.any(AbortSignal),
    ),
  );
  expect(screen.queryByText("first private body")).toBeNull();
  expect(screen.queryByText("second private body")).toBeNull();
  await waitFor(() =>
    expect(entries.get("first")!.release).toHaveBeenCalledOnce(),
  );
  await act(async () => {
    readySecond();
  });
  await screen.findByText("second private body");

  act(() => {
    const store = entries.get("second")!.doc.virgultumDoc;
    const paragraph = store
      .getAllModels()
      .find((model) => model.flavour === "myoxus:paragraph")!;
    store.updateBlock(paragraph, { text: new Text("second updated body") });
  });
  expect(screen.queryByText("second private body")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await screen.findByText("second updated body");

  lookupTemplateSource.mockResolvedValueOnce({
    templateDocId: "second",
    category: "building-blocks",
    available: false,
  });
  mounted.rerender(view("first"));
  await screen.findByRole("button", { name: "Retry" });
  expect(screen.queryByText("first private body")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("first private body");

  act(() => allowed$.setValue(false));
  expect(screen.queryByText("first private body")).toBeNull();
  await waitFor(() =>
    expect(entries.get("first")!.release).toHaveBeenCalledTimes(2),
  );
});
