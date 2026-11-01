// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { LiveData } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

type TestTag = {
  id: string;
  name: string;
  color: string;
  archived: boolean;
};

type TestCatalogState = {
  status: "loading" | "ready";
  tags: TestTag[];
  error: null;
};

const serviceState = vi.hoisted(() => ({
  jumpToTag: vi.fn(),
  tagService: null as unknown as {
    tagList: {
      catalogState$: LiveData<TestCatalogState>;
      tagIdsByPageId$: (docId: string) => LiveData<string[]>;
      assignmentState$: (
        docId: string,
      ) => LiveData<{ status: "ready"; ids: string[]; error: null }>;
      tagMetas$: LiveData<TestTag[]>;
      setPageTags: ReturnType<typeof vi.fn>;
      retryCatalog: ReturnType<typeof vi.fn>;
    };
  },
  workspaceService: {
    workspace: { id: "workspace-1" },
  },
}));

vi.mock("@myoxus/core/components/hooks/use-navigate-helper", () => ({
  useNavigateHelper: () => ({
    jumpToTag: serviceState.jumpToTag,
  }),
}));

vi.mock("@myoxus/core/components/tags/color-options", () => ({
  useWorkspaceTagColorOptions: () => [
    { id: "red", name: "Red", value: "tag.red" },
  ],
}));

vi.mock("@myoxus/core/components/tags/use-workspace-tag-commands", () => ({
  useWorkspaceTagCommands: () => ({
    archiveTags: vi.fn(async () => undefined),
    createTag: vi.fn(async (name: string) => ({
      id: `created-${name}`,
      name,
      color: "tag.red",
    })),
    errorMessage: () => "tag assignment failed",
    recolorTag: vi.fn(async () => undefined),
    renameTag: vi.fn(async () => undefined),
    restoreTag: vi.fn(async () => undefined),
  }),
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    new Proxy(
      { language: "en" },
      {
        get(target, property) {
          if (property === "language") return target.language;
          return () => String(property);
        },
      },
    ),
}));

vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  return {
    ...actual,
    useService: (service: { name?: string }) =>
      service.name === "TagService"
        ? serviceState.tagService
        : serviceState.workspaceService,
  };
});

import { DocumentTagsSidecard } from "./document-tags-sidecard";

function configureTags({
  selected = [],
  archived = false,
  status = "ready",
  tags: configuredTags,
}: {
  selected?: string[];
  archived?: boolean;
  status?: TestCatalogState["status"];
  tags?: TestTag[];
} = {}) {
  const selectedTags$ = new LiveData(selected);
  const setPageTags = vi.fn(async (_docId: string, nextIds: string[]) => {
    selectedTags$.next(nextIds);
    return nextIds;
  });
  const tags =
    status === "loading"
      ? []
      : (configuredTags ?? [
          {
            id: archived ? "tag-archived" : "tag-active",
            name: archived ? "Historical" : "Active",
            color: "tag.red",
            archived,
          },
        ]);
  serviceState.tagService = {
    tagList: {
      catalogState$: new LiveData({
        status,
        tags,
        error: null,
      }),
      tagIdsByPageId$: () => selectedTags$,
      assignmentState$: () =>
        selectedTags$.map((ids) => ({
          status: "ready" as const,
          ids,
          error: null,
        })),
      tagMetas$: new LiveData(tags),
      setPageTags,
      retryCatalog: vi.fn(async () => undefined),
    },
  };
  return { setPageTags };
}

function renderSidecard(readonly = false) {
  return render(
    <MyoxusUIProvider>
      <DocumentTagsSidecard docId="doc-1" readonly={readonly} />
    </MyoxusUIProvider>,
  );
}

describe("DocumentTagsSidecard", () => {
  beforeAll(() => {
    vi.stubGlobal("BUILD_CONFIG", { isMobileEdition: false });
  });

  beforeEach(() => {
    serviceState.jumpToTag.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test("waits for an explicit selector action before focusing tag search", async () => {
    const { setPageTags } = configureTags();
    renderSidecard();

    expect(screen.getByTestId("document-tags-sidecard")).toBeTruthy();
    expect(
      screen.queryByPlaceholderText("com.myoxus.search-tags.placeholder"),
    ).toBeNull();
    expect(document.activeElement?.tagName).not.toBe("INPUT");

    const addButton = screen.getByTestId("document-tags-add");
    expect(addButton.getAttribute("aria-haspopup")).toBe("menu");
    expect(addButton.dataset.myoxusUiRole).toBe("document-tags-add-action");
    fireEvent.click(addButton);
    const input = await screen.findByPlaceholderText(
      "com.myoxus.search-tags.placeholder",
    );
    expect(screen.getByTestId("tags-editor-popup").contains(input)).toBe(true);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(setPageTags).toHaveBeenCalledWith("doc-1", ["tag-active"]),
    );
  });

  test("keeps an archived assignment removable through the shared selector", async () => {
    const { setPageTags } = configureTags({
      selected: ["tag-archived"],
      archived: true,
    });
    renderSidecard();

    expect(
      screen.getByLabelText("Historical, com.myoxus.tags.status.archived"),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("document-tags-add"));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "com.myoxus.common.remove-item",
      }),
    );

    await waitFor(() => expect(setPageTags).toHaveBeenCalledWith("doc-1", []));
  });

  test("separates the selected inventory from the add action", () => {
    configureTags({ selected: ["tag-active"] });
    renderSidecard();

    const sidecard = screen.getByTestId("document-tags-sidecard");
    const addButton = screen.getByTestId("document-tags-add");
    const actions = sidecard.querySelector(
      '[data-myoxus-ui-role="document-tags-actions"]',
    );
    const separator = sidecard.querySelector('[role="separator"]');
    const relativePosition = separator?.compareDocumentPosition(addButton) ?? 0;

    expect(actions?.contains(addButton)).toBe(true);
    expect(separator).not.toBeNull();
    expect(relativePosition & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  test("keeps multiple selected tags in one shared wrapping inventory", () => {
    const tags = [
      {
        id: "tag-critical",
        name: "Critical",
        color: "tag.red",
        archived: false,
      },
      {
        id: "tag-priority",
        name: "Priority",
        color: "tag.red",
        archived: false,
      },
      {
        id: "tag-release",
        name: "Release planning and validation",
        color: "tag.red",
        archived: false,
      },
    ];
    configureTags({
      selected: tags.map((tag) => tag.id),
      tags,
    });
    renderSidecard();

    const sidecard = screen.getByTestId("document-tags-sidecard");
    const inventory = screen.getByTestId("inline-tags-list");

    expect(sidecard.contains(inventory)).toBe(true);
    expect(inventory.querySelectorAll("[data-tag-id]")).toHaveLength(3);
    for (const tag of tags) {
      expect(
        inventory.querySelector(`[data-tag-id="${tag.id}"]`),
      ).not.toBeNull();
    }
  });

  test("renders an explanatory empty state without assignment actions when read-only", () => {
    configureTags();
    renderSidecard(true);

    expect(
      screen.getByText("com.myoxus.tags.assignment.readonly-empty"),
    ).toBeTruthy();
    expect(screen.queryByTestId("document-tags-add")).toBeNull();
    expect(
      screen.queryByPlaceholderText("com.myoxus.search-tags.placeholder"),
    ).toBeNull();
  });

  test("exposes loading as a distinct state instead of an empty catalog", () => {
    configureTags({ status: "loading" });
    renderSidecard();

    expect(screen.getByTestId("workspace-tags-loading")).toBeTruthy();
    expect(screen.queryByTestId("document-tags-empty")).toBeNull();
    expect(screen.queryByTestId("document-tags-add")).toBeNull();
  });
});
