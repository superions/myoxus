/**
 * @vitest-environment happy-dom
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { LiveData, useLiveData } from "@myoxus/infra";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tokens = {
    mermaidDiagrams: Symbol("MermaidDiagramsService"),
    workbench: Symbol("WorkbenchService"),
    docs: Symbol("DocsService"),
    lifecycle: Symbol("DocumentLifecycleStore"),
  };

  return {
    tokens,
    diagrams: [] as Array<{
      id: string;
      meta$: {
        value: {
          id?: string;
          trash?: boolean;
          createDate?: number;
          diagramFormat?: string;
          diagramType?: string;
          title?: string;
          updatedDate?: number;
        };
      };
    }>,
    openDoc: vi.fn(),
    open: vi.fn(),
    createDiagram: vi.fn(async () => ({
      status: "ready" as const,
      docId: "created-diagram",
    })),
  };
});

vi.mock("@myoxus/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/i18n")>()),
  useI18n: () => {
    const translations = {
      Documents: () => "Documents",
      Trash: () => "Trash",
      "com.myoxus.diagrams.catalog.category.popular": () => "Popular",
      "com.myoxus.diagrams.catalog.create": ({ type }: { type: string }) =>
        `Create ${type}`,
      "com.myoxus.diagrams.catalog.new-description": () =>
        "Choose a diagram type",
      "com.myoxus.diagrams.catalog.new-title": () => "New diagram",
      "com.myoxus.diagrams.catalog.recent": () => "Recently edited",
      "com.myoxus.diagrams.catalog.recent-empty": () => "No recent diagrams",
      "com.myoxus.diagrams.catalog.selection-label": () =>
        "Choose a diagram type",
      "com.myoxus.trashOperation.itemCount": ({ count }: { count: string }) =>
        `${count} in trash`,
      "com.myoxus.trashOperation.emptyTrash": () => "Empty trash",
      "com.myoxus.workspaceSubPath.trash": () => "Trash",
      "com.myoxus.workspaceSubPath.trash.empty-description": () =>
        "Deleted docs will appear here.",
      "com.myoxus.common.open-menu": () => "Open menu",
      "com.myoxus.workspaceSubPath.diagrams": () => "Diagrams",
    };
    return new Proxy(
      { ...translations, language: "en" },
      {
        get(target, property) {
          if (property in target) {
            return target[property as keyof typeof target];
          }
          return () => String(property);
        },
      },
    ) as any;
  },
}));

vi.mock("@myoxus/core/modules/mermaid-diagrams", () => ({
  DEFAULT_MERMAID_DIAGRAM_TITLE: "Mermaid diagram",
  MermaidDiagramsService: mocks.tokens.mermaidDiagrams,
}));

vi.mock("@myoxus/core/modules/doc", () => ({ DocsService: mocks.tokens.docs }));
vi.mock("@myoxus/core/modules/doc/stores/document-lifecycle", () => ({
  DocumentLifecycleStore: mocks.tokens.lifecycle,
}));
vi.mock("@myoxus/core/components/guard/use-guard", () => ({
  useGuard: () => useLiveData(readPermission$),
}));

vi.mock("@myoxus/core/modules/workbench", () => ({
  ViewBody: ({ children }: { children: ReactNode }) => (
    <section data-testid="view-body">{children}</section>
  ),
  ViewHeader: ({ children }: { children: ReactNode }) => (
    <header data-testid="view-header">{children}</header>
  ),
  ViewIcon: () => null,
  ViewTitle: () => null,
  WorkbenchService: mocks.tokens.workbench,
}));

vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();

  return {
    ...actual,
    useLiveData: (stream: unknown) =>
      stream instanceof actual.LiveData ? actual.useLiveData(stream) : stream,
    useService: (token: unknown) => {
      if (token === mocks.tokens.mermaidDiagrams) {
        return {
          createDiagram: mocks.createDiagram,
          diagramDocs$: mocks.diagrams,
          diagramDoc$: (docId: string) =>
            docId === "created-diagram"
              ? { value: { meta$: { value: { diagramFormat: "bpmn" } } } }
              : { value: undefined },
          creation$,
          restoreCreation: () => {},
        };
      }
      if (token === mocks.tokens.workbench) {
        return {
          workbench: {
            openDoc: mocks.openDoc,
            open: mocks.open,
            location$,
          },
        };
      }
      if (token === mocks.tokens.docs)
        return { list: { isReady$: listReady$ } };
      if (token === mocks.tokens.lifecycle)
        return { state$: () => lifecycleState$ };
      return {};
    },
  };
});

import { DiagramsPage } from "./diagrams";
import { EmptyTrashState, TrashHeader } from "./trash-page";

const repoRoot = process.cwd();
const creation$ = new LiveData<{
  docId: string;
  busy: boolean;
  failed: boolean;
  stage: "classification";
} | null>(null);
const location$ = new LiveData({ search: "" });
const readPermission$ = new LiveData<boolean | undefined>(true);
const lifecycleState$ = new LiveData<"available" | "creating" | "not-found">(
  "available",
);
const listReady$ = new LiveData(true);

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

const renderWithFacadeProvider = (ui: ReactNode) =>
  render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);

describe("workspace navigation surfaces", () => {
  afterEach(() => {
    cleanup();
    mocks.diagrams = [];
    mocks.openDoc.mockClear();
    mocks.open.mockReset();
    mocks.createDiagram.mockClear();
    creation$.next(null);
    location$.next({ search: "" });
    readPermission$.next(true);
    lifecycleState$.next("available");
    listReady$.next(true);
  });

  test("trash header and empty state expose the shared facade surface roles", () => {
    renderWithFacadeProvider(
      <>
        <TrashHeader
          canEmptyTrash={false}
          itemCount={0}
          onEmptyTrash={() => {}}
        />
        <EmptyTrashState />
      </>,
    );

    expect(
      document.querySelector('[data-myoxus-ui-role="trash-header-frame"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-myoxus-ui-role="trash-title-cluster"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-myoxus-ui-role="trash-toolbar-surface"]'),
    ).toBeNull();
    expect(screen.queryByTestId("trash-header-menu-trigger")).toBeNull();
    expect(
      document
        .querySelector('[data-myoxus-ui-role="trash-empty-state-rail"]')
        ?.getAttribute("data-fill"),
    ).toBe("true");
    expect(
      document
        .querySelector('[data-myoxus-ui-role="trash-empty-state-rail"]')
        ?.getAttribute("data-center-content"),
    ).toBe("true");
    expect(
      document.querySelector('[data-myoxus-ui-role="trash-count-badge"]')
        ?.textContent,
    ).toContain("0 in trash");
    expect(screen.getByTestId("trash-empty-state").textContent).toContain(
      "Deleted docs will appear here.",
    );
  });

  test("trash header exposes destructive empty action as a visible header action", () => {
    const onEmptyTrash = vi.fn();
    renderWithFacadeProvider(
      <TrashHeader canEmptyTrash itemCount={3} onEmptyTrash={onEmptyTrash} />,
    );

    expect(
      document.querySelector('[data-myoxus-ui-role="trash-header-frame"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-myoxus-ui-role="trash-toolbar-surface"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-myoxus-ui-role="trash-count-badge"]')
        ?.textContent,
    ).toContain("3 in trash");
    expect(
      document.querySelector('[data-myoxus-ui-role="trash-empty-button"]'),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("empty-trash-button"));
    expect(onEmptyTrash).toHaveBeenCalledTimes(1);
  });

  test("diagram overview exposes the visual catalog as the primary creation surface", () => {
    mocks.diagrams = [];

    renderWithFacadeProvider(<DiagramsPage />);

    expect(
      document.querySelector('[data-myoxus-ui-role="diagrams-header-frame"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-myoxus-ui-role="diagram-catalog"]'),
    ).toBeTruthy();
    expect(screen.getByTestId("diagram-type-flowchart")).toBeTruthy();
    expect(screen.getByTestId("diagram-type-bpmn")).toBeTruthy();
    expect(screen.getByTestId("create-selected-diagram-button")).toBeTruthy();
    expect(
      screen.queryByTestId("mermaid-diagrams-header-menu-trigger"),
    ).toBeNull();
  });

  test("diagram overview dispatches BPMN creation through the first-class diagram document path", async () => {
    mocks.diagrams = [];
    mocks.open.mockImplementation((to: string) =>
      location$.next({
        search: to.includes("?") ? to.slice(to.indexOf("?")) : "",
      }),
    );
    mocks.createDiagram.mockImplementationOnce(async () => {
      const state = {
        docId: "created-diagram",
        busy: true,
        failed: false,
        stage: "classification" as const,
      };
      creation$.next(state);
      await Promise.resolve();
      creation$.next({ ...state, busy: false });
      return { status: "ready", docId: state.docId };
    });

    renderWithFacadeProvider(<DiagramsPage />);
    fireEvent.click(screen.getByTestId("diagram-type-bpmn"));
    fireEvent.click(screen.getByTestId("create-selected-diagram-button"));

    await waitFor(() =>
      expect(mocks.createDiagram).toHaveBeenCalledWith({
        format: "bpmn",
        title: "BPMN",
        type: "bpmn",
      }),
    );
    await waitFor(() =>
      expect(mocks.open).toHaveBeenCalledWith("/created-diagram?editBpmn=1", {
        at: "active",
        replaceHistory: true,
      }),
    );
  });

  test("Recent does not guess format or open an unconfirmed, denied, deleted or unavailable target", async () => {
    const meta$ = new LiveData<{
      id: string;
      title: string;
      trash?: boolean;
      diagramFormat?: string;
    }>({ id: "recent-qa", title: "Private diagram title" });
    mocks.diagrams = [{ id: "recent-qa", meta$ }];
    renderWithFacadeProvider(<DiagramsPage />);
    const row = screen.getByTestId("recent-diagram-item") as HTMLButtonElement;
    expect(row.textContent).toContain(
      "com.myoxus.diagrams.catalog.format-unavailable",
    );
    expect(row.textContent).not.toContain("Mermaid");
    act(() => lifecycleState$.next("creating"));
    await waitFor(() => expect(row.disabled).toBe(false));
    fireEvent.click(row);
    expect(mocks.openDoc).toHaveBeenCalledWith("recent-qa", { at: "active" });
    mocks.openDoc.mockClear();
    act(() => {
      lifecycleState$.next("available");
      readPermission$.next(undefined);
    });
    await waitFor(() => expect(row.disabled).toBe(true));
    expect(row.textContent).not.toContain("Private diagram title");
    fireEvent.click(row);
    act(() => readPermission$.next(false));
    await waitFor(() =>
      expect(row.textContent).toContain("com.myoxus.no-permission"),
    );
    fireEvent.click(row);
    act(() => {
      readPermission$.next(true);
      lifecycleState$.next("not-found");
    });
    await waitFor(() =>
      expect(row.textContent).toContain(
        "com.myoxus.reference.target-unavailable",
      ),
    );
    fireEvent.click(row);
    act(() => {
      lifecycleState$.next("available");
      meta$.next({ ...meta$.value, trash: true });
    });
    await waitFor(() => expect(row.textContent).toContain("Deleted"));
    fireEvent.click(row);
    expect(mocks.openDoc).not.toHaveBeenCalled();
    act(() =>
      meta$.next({ ...meta$.value, trash: false, diagramFormat: "bpmn" }),
    );
    await waitFor(() => expect(row.disabled).toBe(false));
    expect(row.textContent).toContain("BPMN");
  });

  test("workspace list utility routes do not keep local diagram/trash CSS modules", () => {
    const diagramsSource = readRepoFile(
      "client/libs/core/src/desktop/pages/workspace/diagrams/index.tsx",
    );
    const trashSource = readRepoFile(
      "client/libs/core/src/desktop/pages/workspace/trash-page.tsx",
    );

    for (const removedPath of [
      "client/libs/core/src/desktop/pages/workspace/diagrams/index.css",
      "client/libs/core/src/desktop/pages/workspace/diagrams/index.styles.ts",
      "client/libs/core/src/desktop/pages/workspace/trash-page.css",
      "client/libs/core/src/desktop/pages/workspace/trash-page.styles.ts",
    ]) {
      expect(existsSync(join(repoRoot, removedPath)), removedPath).toBe(false);
    }

    for (const source of [diagramsSource, trashSource]) {
      expect(source).not.toContain(".styles");
      expect(source).not.toContain("className={styles.");
      expect(source).toContain("PageContentRail");
    }
    expect(trashSource).toContain("EmptyStateTitle");
    expect(diagramsSource).not.toContain("WorkbenchPageHeader");
    expect(diagramsSource).toContain("WorkbenchHeaderFrame");
    expect(diagramsSource).not.toContain("WorkbenchHeaderMenuSection");
    expect(diagramsSource).not.toContain("CardTitle");
    expect(diagramsSource).not.toContain("HeaderActionGroup");
    expect(diagramsSource).not.toContain("DataPageHeaderRail");
    expect(diagramsSource).not.toContain("HeaderActionBar");
    expect(trashSource).not.toContain("WorkbenchPageHeader");
    expect(trashSource).toContain("WorkbenchHeaderFrame");
    expect(trashSource).not.toContain("WorkbenchHeaderMenuSection");
    expect(trashSource).not.toContain("CardTitle");
    expect(trashSource).not.toContain("HeaderActionGroup");
    expect(trashSource).not.toContain("DataPageHeaderRail");
  });
});
