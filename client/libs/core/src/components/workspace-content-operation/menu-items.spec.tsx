// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import {
  WorkspaceContentOperationKindType,
  WorkspaceContentResourceKindType,
} from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  WorkspaceContentOperationMenuItems,
  WorkspaceContentOperationSelectionMenu,
} from "./menu-items";

const state = vi.hoisted(() => ({
  availability: {
    status: "unavailable",
    targets: [],
  } as {
    status: "available" | "unavailable";
    targets: Array<{ id: string; flavour: string }>;
  },
  open: vi.fn(),
  refresh: vi.fn(async () => undefined),
  allowed: new Set<WorkspaceContentOperationKindType>(),
}));

vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  return {
    ...actual,
    useLiveData: () => state.availability,
    useServices: () => ({
      workspaceContentOperationService: {
        availability$: state.availability,
        canStart: (kind: WorkspaceContentOperationKindType) =>
          state.allowed.has(kind),
        refreshAvailability: state.refresh,
      },
      workspaceDialogService: { open: state.open },
    }),
  };
});

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    new Proxy(
      {},
      {
        get: (_, key) => () => String(key),
      },
    ),
}));

describe("WorkspaceContentOperationMenuItems", () => {
  afterEach(() => {
    cleanup();
    state.availability = { status: "unavailable", targets: [] };
    state.allowed.clear();
    vi.clearAllMocks();
  });

  test("keeps commands out of the DOM until fresh server availability exists", () => {
    const { container } = render(
      <MyoxusUIProvider>
        <WorkspaceContentOperationMenuItems
          selection={{
            type: "resources",
            resources: [
              {
                id: "doc-1",
                kind: WorkspaceContentResourceKindType.Document,
              },
            ],
          }}
        />
      </MyoxusUIProvider>,
    );

    expect(container.querySelector("[data-testid^='workspace-content']")).toBe(
      null,
    );
    expect(state.refresh).toHaveBeenCalledOnce();
  });

  test("offers only supported single-resource operations and opens the shared wizard", () => {
    state.availability = {
      status: "available",
      targets: [{ id: "target", flavour: "server-a" }],
    };
    state.allowed = new Set([
      WorkspaceContentOperationKindType.Move,
      WorkspaceContentOperationKindType.Copy,
      WorkspaceContentOperationKindType.Link,
    ]);

    render(
      <MyoxusUIProvider>
        <WorkspaceContentOperationMenuItems
          selection={{
            type: "resources",
            resources: [
              {
                id: "doc-1",
                kind: WorkspaceContentResourceKindType.Document,
              },
            ],
          }}
        />
      </MyoxusUIProvider>,
    );

    fireEvent.click(screen.getByTestId("workspace-content-operation-link"));
    expect(state.open).toHaveBeenCalledWith("workspace-content-operation", {
      kind: WorkspaceContentOperationKindType.Link,
      selection: {
        type: "resources",
        resources: [
          {
            id: "doc-1",
            kind: WorkspaceContentResourceKindType.Document,
          },
        ],
      },
    });
    expect(
      screen.queryByTestId("workspace-content-operation-extract"),
    ).toBeNull();
  });

  test.each([false, true])(
    "suppresses direct and mixed Collection selections (mixed=%s)",
    (mixed) => {
      state.availability = {
        status: "available",
        targets: [{ id: "target", flavour: "server-a" }],
      };
      state.allowed = new Set([
        WorkspaceContentOperationKindType.Move,
        WorkspaceContentOperationKindType.Copy,
        WorkspaceContentOperationKindType.Link,
      ]);
      const selection = {
        type: "resources" as const,
        resources: [
          {
            id: "collection",
            kind: WorkspaceContentResourceKindType.Collection,
          },
          ...(mixed
            ? [{ id: "doc", kind: WorkspaceContentResourceKindType.Document }]
            : []),
        ],
      };
      const { container } = render(
        <MyoxusUIProvider>
          <WorkspaceContentOperationMenuItems selection={selection} />
          <WorkspaceContentOperationSelectionMenu selection={selection} />
        </MyoxusUIProvider>,
      );
      expect(
        container.querySelector(
          "[data-testid^='workspace-content-operation-']",
        ),
      ).toBeNull();
      expect(
        screen.queryByLabelText(
          "com.myoxus.workspace-content-operation.selection-menu",
        ),
      ).toBeNull();
      expect(state.open).not.toHaveBeenCalled();
    },
  );

  test("exposes Extract only for a folder selection", () => {
    state.availability = {
      status: "available",
      targets: [{ id: "target", flavour: "server-a" }],
    };
    state.allowed = new Set([
      WorkspaceContentOperationKindType.Copy,
      WorkspaceContentOperationKindType.ExtractFolder,
      WorkspaceContentOperationKindType.Link,
    ]);

    render(
      <MyoxusUIProvider>
        <WorkspaceContentOperationMenuItems
          selection={{ type: "folder", folderId: "folder-1" }}
        />
      </MyoxusUIProvider>,
    );

    expect(
      screen.getByTestId("workspace-content-operation-extract"),
    ).not.toBeNull();
    expect(screen.queryByTestId("workspace-content-operation-link")).toBeNull();
  });

  test("labels the multiselection command menu and keeps it absent offline", () => {
    const selection = {
      type: "resources" as const,
      resources: [
        {
          id: "doc-1",
          kind: WorkspaceContentResourceKindType.Document,
        },
      ],
    };
    const { rerender } = render(
      <MyoxusUIProvider>
        <WorkspaceContentOperationSelectionMenu selection={selection} />
      </MyoxusUIProvider>,
    );

    expect(
      screen.queryByLabelText(
        "com.myoxus.workspace-content-operation.selection-menu",
      ),
    ).toBeNull();

    state.availability = {
      status: "available",
      targets: [{ id: "target", flavour: "server-a" }],
    };
    state.allowed.add(WorkspaceContentOperationKindType.Move);
    rerender(
      <MyoxusUIProvider>
        <WorkspaceContentOperationSelectionMenu selection={selection} />
      </MyoxusUIProvider>,
    );

    expect(
      screen.getByLabelText(
        "com.myoxus.workspace-content-operation.selection-menu",
      ),
    ).not.toBeNull();
  });
});
