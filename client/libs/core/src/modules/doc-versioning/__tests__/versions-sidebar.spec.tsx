/**
 * @vitest-environment happy-dom
 */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { atom, getDefaultStore, useAtom } from "jotai";
import type { HistorySelection } from "../history-selection";
const navigationState = atom<{
  open: boolean;
  pageId: string;
  initialSelection?: HistorySelection;
  returnFocusRef?: { current: HTMLElement | null };
}>({ open: false, pageId: "" });
vi.mock("../history-navigation", () => ({
  useHistoryNavigation: () => {
    const [state, setState] = useAtom(navigationState);
    return {
      state,
      open: (
        initialSelection?: HistorySelection,
        opener?: HTMLElement | null,
      ) =>
        setState({
          open: true,
          pageId: "doc-1",
          initialSelection,
          returnFocusRef: { current: opener ?? null },
        }),
    };
  },
}));
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const historyRead = vi.hoisted(() => ({
  empty: false,
  loading: false,
  error: undefined as Error | undefined,
}));

vi.mock("@myoxus/core/components/guard", () => ({
  useGuard: () => true,
}));

vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useService: () => ({ open: vi.fn() }),
}));

vi.mock(
  "@myoxus/core/modules/doc-versioning/history-data",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@myoxus/core/modules/doc-versioning/history-data")
    >()),
    historySourceI18nKey: () => "com.myoxus.history.source.manual",
    useDocumentHistory: () => [
      historyRead.empty
        ? []
        : [
            {
              id: "doc-1",
              snapshotId: "102",
              cursor: "2026-01-02T00:00:00Z|102",
              timestamp: "2026-01-02T00:00:00Z",
              origin: "manual",
              editor: null,
            },
            {
              id: "doc-1",
              snapshotId: "901",
              cursor: "2026-01-01T00:00:00Z|901",
              timestamp: "2026-01-01T00:00:00Z",
              origin: "manual",
              editor: null,
            },
            {
              id: "doc-1",
              snapshotId: "101",
              cursor: "2025-12-31T00:00:00Z|101",
              timestamp: "2025-12-31T00:00:00Z",
              origin: "manual",
              editor: null,
            },
          ],
      false,
      false,
      {
        error: historyRead.error,
        loading: historyRead.loading,
        refresh: vi.fn().mockResolvedValue(undefined),
        retry: vi.fn().mockResolvedValue(undefined),
      },
    ],
  }),
);

vi.mock("@myoxus/core/components/hooks/myoxus/use-user-preferences", () => ({
  useRegionalFormatters: () => ({
    formatDateTime: (value: string) => value,
  }),
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/ui-facade")>();
  type FacadeWrapperProps = {
    children?: ReactNode;
    component?: "article" | "div" | "header" | "section";
    [key: string]: unknown;
  };

  const stripLayoutProps = ({
    alignItems: _alignItems,
    appearance: _appearance,
    block: _block,
    density: _density,
    fallbackSlot: _fallbackSlot,
    flex: _flex,
    fullWidth: _fullWidth,
    gap: _gap,
    justifyContent: _justifyContent,
    layout: _layout,
    maxHeight: _maxHeight,
    m: _margin,
    minWidth: _minWidth,
    paddingBlock: _paddingBlock,
    paddingInline: _paddingInline,
    tone: _tone,
    truncate: _truncate,
    tt: _textTransform,
    typographySlot: _typographySlot,
    wrap: _wrap,
    ...props
  }: Record<string, unknown>) => props;

  const FacadeBox = ({
    children,
    component = "div",
    ...props
  }: FacadeWrapperProps) => {
    const domProps = stripLayoutProps(props);
    if (component === "article") {
      return (
        <article {...(domProps as HTMLAttributes<HTMLElement>)}>
          {children}
        </article>
      );
    }
    if (component === "header") {
      return (
        <header {...(domProps as HTMLAttributes<HTMLElement>)}>
          {children}
        </header>
      );
    }
    if (component === "section") {
      return (
        <section {...(domProps as HTMLAttributes<HTMLElement>)}>
          {children}
        </section>
      );
    }
    return (
      <div {...(domProps as HTMLAttributes<HTMLDivElement>)}>{children}</div>
    );
  };

  const TextMock = ({
    children,
    component = "span",
    ...props
  }: {
    children?: ReactNode;
    component?: "h3" | "p" | "span" | "strong";
    [key: string]: unknown;
  }) => {
    const domProps = stripLayoutProps(props);
    if (component === "h3") {
      return (
        <h3 {...(domProps as HTMLAttributes<HTMLHeadingElement>)}>
          {children}
        </h3>
      );
    }
    if (component === "p") {
      return (
        <p {...(domProps as HTMLAttributes<HTMLParagraphElement>)}>
          {children}
        </p>
      );
    }
    if (component === "strong") {
      return (
        <strong {...(domProps as HTMLAttributes<HTMLElement>)}>
          {children}
        </strong>
      );
    }
    return (
      <span {...(domProps as HTMLAttributes<HTMLSpanElement>)}>{children}</span>
    );
  };

  const SelectMock = ({
    block: _block,
    controlMaxWidth: _controlMaxWidth,
    data,
    label,
    onChange,
    value,
    ...props
  }: {
    controlMaxWidth?: string;
    data: Array<{ value: string; label: string }>;
    label?: ReactNode;
    onChange: (value: string) => void;
    value?: string;
    [key: string]: unknown;
  }) => (
    <label>
      {label}
      <select
        {...(props as SelectHTMLAttributes<HTMLSelectElement>)}
        onChange={(event) => onChange(event.currentTarget.value)}
        value={value ?? ""}
      >
        {data.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );

  return {
    ...actual,
    Badge: ({ children, ...props }: { children?: ReactNode }) => (
      <span {...(props as HTMLAttributes<HTMLSpanElement>)}>{children}</span>
    ),
    Button: ({
      children,
      disabled,
      onClick,
      variant,
      ...props
    }: {
      children: ReactNode;
      disabled?: boolean;
      onClick?: () => void;
      variant?: string;
      [key: string]: unknown;
    }) => (
      <button
        {...(props as ButtonHTMLAttributes<HTMLButtonElement>)}
        data-variant={variant}
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        {children}
      </button>
    ),
    EmptyState: ({
      cta,
      title,
      ...props
    }: {
      cta?: ReactNode;
      title?: ReactNode;
      [key: string]: unknown;
    }) => (
      <div {...(props as HTMLAttributes<HTMLDivElement>)}>
        {title}
        {cta}
      </div>
    ),
    FormSelect: SelectMock,
    Group: FacadeBox,
    Input: ({
      label,
      onChange,
      value,
      ...props
    }: {
      label?: ReactNode;
      onChange?: (value: string) => void;
      value?: string;
      [key: string]: unknown;
    }) => (
      <label>
        {label}
        <input
          {...(props as InputHTMLAttributes<HTMLInputElement>)}
          onChange={(event) => onChange?.(event.currentTarget.value)}
          value={value ?? ""}
        />
      </label>
    ),
    Modal: ({ children, open }: { children: ReactNode; open?: boolean }) =>
      open === false ? null : <div data-testid="modal">{children}</div>,
    Loading: (props: HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>loading</div>
    ),
    MyoxusText: TextMock,
    MyoxusSelect: SelectMock,
    MyoxusTitle: ({
      children,
      order = 2,
      ...props
    }: {
      children?: ReactNode;
      order?: 1 | 2 | 3 | 4 | 5 | 6;
      [key: string]: unknown;
    }) => {
      const domProps = stripLayoutProps(props);
      return order === 2 ? (
        <h2 {...(domProps as HTMLAttributes<HTMLHeadingElement>)}>
          {children}
        </h2>
      ) : (
        <h3 {...(domProps as HTMLAttributes<HTMLHeadingElement>)}>
          {children}
        </h3>
      );
    },
    Select: SelectMock,
    SettingsNotice: ({ children, ...props }: { children?: ReactNode }) => (
      <div role="alert" {...(props as HTMLAttributes<HTMLDivElement>)}>
        {children}
      </div>
    ),
    Stack: FacadeBox,
    SurfaceListCardHeader: FacadeBox,
    SurfaceListItem: FacadeBox,
    SurfaceListMeta: FacadeBox,
    TerminalPanel: ({ children, ...props }: { children?: ReactNode }) => (
      <pre {...(stripLayoutProps(props) as HTMLAttributes<HTMLPreElement>)}>
        {children}
      </pre>
    ),
    Textarea: ({
      autosize: _autosize,
      label,
      minRows: _minRows,
      onChange,
      value,
      ...props
    }: {
      autosize?: boolean;
      label?: ReactNode;
      minRows?: number;
      onChange?: (value: string) => void;
      value?: string;
      [key: string]: unknown;
    }) => (
      <label>
        {label}
        <textarea
          {...(props as TextareaHTMLAttributes<HTMLTextAreaElement>)}
          onChange={(event) => onChange?.(event.currentTarget.value)}
          value={value ?? ""}
        />
      </label>
    ),
  };
});

vi.mock("@myoxus/i18n", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const en = JSON.parse(
    readFileSync(
      join(process.cwd(), "client/libs/i18n/src/resources/en.json"),
      "utf8",
    ),
  ) as Record<string, string>;
  const translate = (
    key: string,
    args?: Record<string, string | number>,
  ): string =>
    (en[key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_match, name) =>
      String(args?.[name] ?? ""),
    );

  const i18n = new Proxy(
    {
      t: (key: string, args?: Record<string, string | number>) =>
        translate(key, args),
      language: "en",
    },
    {
      get(target, key: string) {
        if (key in target) {
          return target[key as keyof typeof target];
        }
        return (args?: Record<string, string | number>) => translate(key, args);
      },
    },
  );

  return { useI18n: () => i18n, I18n: { t: translate } };
});

import { waitForDocumentVersionSync } from "../document-sync";
import { __test__, DocumentVersionsSidebar } from "../versions-sidebar";

const versions = [
  {
    id: "ver-1",
    docId: "doc-1",
    workspaceId: "ws-1",
    docHistoryId: "101",
    label: "reviewed-v1",
    description: "Reviewed",
    createdBy: "11111111-1111-1111-1111-111111111111",
    createdAt: "2026-05-01T12:00:00.000Z",
    isPinned: false,
    versionNo: 1,
    event: "manual",
    kind: "manual",
    isProtected: false,
    policyId: "policy-1",
    contentHash: "sha256:abc",
  },
  {
    id: "ver-2",
    docId: "doc-1",
    workspaceId: "ws-1",
    docHistoryId: "102",
    label: "release",
    description: null,
    createdBy: "22222222-2222-2222-2222-222222222222",
    createdAt: "2026-05-01T13:00:00.000Z",
    isPinned: true,
    versionNo: 2,
    event: "manual",
    kind: "manual",
    isProtected: false,
    policyId: null,
    contentHash: null,
  },
];

const documentMetadata = {
  docId: "doc-1",
  workspaceId: "ws-1",
  projectionMode: "MYOXUS_NATIVE",
  projectionVersion: "1",
  metadataRevision: 1,
  metadataUpdatedAt: null,
  metadataUpdatedBy: null,
  system: {
    createdAt: "2026-05-01T12:00:00.000Z",
    updatedAt: "2026-05-01T12:00:00.000Z",
    createdBy: "11111111-1111-1111-1111-111111111111",
    updatedBy: null,
    metadataUpdatedAt: null,
    metadataUpdatedBy: null,
  },
  fields: [
    {
      key: "version",
      source: "DOCUMENT",
      reference: {
        id: "ver-1",
        key: "ver-1",
        label: "reviewed-v1",
        isActive: true,
      },
      textValue: "dirty",
      timestampValue: "2026-05-01T12:00:00.000Z",
      dateValue: null,
      userId: null,
    },
  ],
  audience: [],
  template: null,
  journal: { journalDate: null },
  presentation: null,
  integration: null,
  policy: { locks: [] },
  legacy: null,
};

const documentMetadataValidation = {
  valid: true,
  missingRequiredMetadataFields: [],
  blockedActions: [],
  errors: [],
  warnings: [],
};

function renderSidebar(
  gql = vi.fn(),
  beforeCapture = async () => {},
  onCaptured = vi.fn().mockResolvedValue(undefined),
) {
  let captured = false;
  gql.mockImplementation(
    ({
      query,
      variables,
    }: {
      query: { op: string };
      variables?: { name?: string | null };
    }) => {
      switch (query.op) {
        case "documentVersioningOverview":
          return Promise.resolve({
            documentMetadata: captured
              ? {
                  ...documentMetadata,
                  fields: [
                    {
                      ...documentMetadata.fields[0],
                      textValue: "show",
                      reference: {
                        ...documentMetadata.fields[0].reference,
                        id: "ver-3",
                      },
                    },
                  ],
                }
              : documentMetadata,
            documentMetadataValidation,
            documentVersions: captured
              ? [
                  {
                    ...versions[0],
                    id: "ver-3",
                    label: "new-label",
                    isPinned: false,
                  },
                  ...versions,
                ]
              : versions,
          });
        case "captureDocumentHistory":
          captured = true;
          return Promise.resolve({
            captureDocumentHistory: {
              historyId: "103",
              version: variables?.name
                ? {
                    ...versions[0],
                    id: "ver-3",
                    docHistoryId: "103",
                    label: variables.name,
                    isPinned: false,
                  }
                : null,
            },
          });
        case "documentHistoryRevision":
          return Promise.resolve({
            documentHistoryRevision: captured ? "8" : "7",
          });
        case "restoreDocumentVersion":
          captured = true;
          return Promise.resolve({
            restoreDocumentVersion: {
              ...versions[0],
              id: "ver-3",
              label: "new-label",
              isPinned: false,
            },
          });
        case "pinDocumentVersion":
          return Promise.resolve({
            pinDocumentVersion: { ...versions[0], isPinned: true },
          });
        default:
          return Promise.resolve({});
      }
    },
  );
  render(
    <MyoxusUIProvider>
      <DocumentVersionsSidebar
        beforeCapture={beforeCapture}
        refreshMetadata={onCaptured}
        docId="doc-1"
        graphqlService={{ gql } as never}
        workspaceId="workspace-1"
      />
    </MyoxusUIProvider>,
  );
  return gql;
}

describe("DocumentVersionsSidebar", () => {
  beforeEach(() => {
    Object.assign(historyRead, {
      empty: false,
      loading: false,
      error: undefined,
    });
    getDefaultStore().set(navigationState, { open: false, pageId: "" });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  test("loads and renders versions with pinned-first ordering", async () => {
    const gql = renderSidebar();

    expect(await screen.findByText("release")).not.toBeNull();
    expect(screen.getAllByText("reviewed-v1").length).toBeGreaterThan(0);
    expect(gql).toHaveBeenCalledWith({
      query: expect.objectContaining({ op: "documentVersioningOverview" }),
      variables: { workspaceId: "workspace-1", docId: "doc-1" },
    });
    expect(__test__.sortVersions(versions)[0].id).toBe("ver-2");
  });

  test("opens an unnamed recent row by its exact history identity", async () => {
    renderSidebar();
    const recent = await screen.findAllByTestId("document-history-recent-item");
    fireEvent.click(recent[1]);
    expect(getDefaultStore().get(navigationState)).toMatchObject({
      open: true,
      pageId: "doc-1",
      initialSelection: { snapshotId: "901" },
    });
  });

  test("waits for upload acknowledgement before a named capture and selects the exact history entry", async () => {
    let acknowledge!: () => void;
    const pendingSync = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const onCaptured = vi.fn().mockResolvedValue(undefined);
    const waitForSynced = vi.fn((id: string) =>
      id === "workspace-1" ? Promise.resolve() : pendingSync,
    );
    const workspace = {
      id: "workspace-1",
      engine: { doc: { waitForSynced } },
    } as unknown as Parameters<typeof waitForDocumentVersionSync>[0];
    const gql = renderSidebar(
      vi.fn(),
      () => waitForDocumentVersionSync(workspace, "doc-1"),
      onCaptured,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Save current state" }),
    );
    fireEvent.change(screen.getByLabelText("Name (optional)"), {
      target: { value: "new-label" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Created before release" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(waitForSynced).toHaveBeenCalledTimes(2));
    expect(waitForSynced.mock.calls.map(([id]) => id)).toEqual([
      "workspace-1",
      "doc-1",
    ]);

    expect(
      gql.mock.calls.filter(
        ([{ query }]) => query.op === "captureDocumentHistory",
      ),
    ).toHaveLength(0);
    expect(
      screen
        .getByTestId("document-version-modal-create-save")
        .hasAttribute("disabled"),
    ).toBe(true);
    acknowledge();

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith({
        query: expect.objectContaining({ op: "captureDocumentHistory" }),
        variables: {
          workspaceId: "workspace-1",
          docId: "doc-1",
          requestKey: expect.any(String),
          name: "new-label",
          description: "Created before release",
        },
      }),
    );
    expect(screen.queryByTestId("document-version-modal-create")).toBeNull();
    expect(onCaptured).toHaveBeenCalledOnce();
    expect(getDefaultStore().get(navigationState)).toMatchObject({
      open: true,
      pageId: "doc-1",
      initialSelection: { snapshotId: "103", versionId: "ver-3" },
    });
  });

  test("saves whitespace-only input as an unnamed state without metadata refresh", async () => {
    const onCaptured = vi.fn().mockResolvedValue(undefined);
    const gql = renderSidebar(vi.fn(), undefined, onCaptured);
    fireEvent.click(
      await screen.findByRole("button", { name: "Save current state" }),
    );
    expect(screen.queryByLabelText("Description")).toBeNull();
    fireEvent.change(screen.getByLabelText("Name (optional)"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith({
        query: expect.objectContaining({ op: "captureDocumentHistory" }),
        variables: {
          workspaceId: "workspace-1",
          docId: "doc-1",
          requestKey: expect.any(String),
          name: null,
          description: null,
        },
      }),
    );
    expect(onCaptured).not.toHaveBeenCalled();
    expect(getDefaultStore().get(navigationState)).toMatchObject({
      open: true,
      pageId: "doc-1",
      initialSelection: { snapshotId: "103" },
    });
  });

  test("reuses the request key after a lost response and resolves to one exact capture", async () => {
    const gql = renderSidebar();
    await screen.findByText("release");
    let captureAttempts = 0;
    gql.mockImplementation(
      ({
        query,
        variables,
      }: {
        query: { op: string };
        variables: Record<string, unknown>;
      }) => {
        if (query.op === "captureDocumentHistory") {
          captureAttempts += 1;
          if (captureAttempts === 1) {
            return Promise.reject(new Error("Response lost"));
          }
          return Promise.resolve({
            captureDocumentHistory: {
              historyId: "104",
              version: {
                ...versions[0],
                id: "ver-4",
                docHistoryId: "104",
                label: variables.name,
              },
            },
          });
        }
        if (query.op === "documentVersioningOverview") {
          return Promise.resolve({
            documentMetadata,
            documentMetadataValidation,
            documentVersions: versions,
          });
        }
        return Promise.resolve({});
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Save current state" }));
    fireEvent.change(screen.getByLabelText("Name (optional)"), {
      target: { value: "retry checkpoint" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Failed to create document version"),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(captureAttempts).toBe(2));
    const requests = gql.mock.calls.filter(
      ([{ query }]) => query.op === "captureDocumentHistory",
    );
    expect(requests[0][0].variables.requestKey).toBe(
      requests[1][0].variables.requestKey,
    );
    expect(getDefaultStore().get(navigationState)).toMatchObject({
      open: true,
      initialSelection: { snapshotId: "104", versionId: "ver-4" },
    });
  });

  test("prevents a double click from starting a second capture", async () => {
    let finishCapture!: (value: unknown) => void;
    const pendingCapture = new Promise((resolve) => {
      finishCapture = resolve;
    });
    const gql = renderSidebar();
    await screen.findByText("release");
    gql.mockImplementation(({ query }: { query: { op: string } }) => {
      if (query.op === "captureDocumentHistory") return pendingCapture;
      if (query.op === "documentVersioningOverview") {
        return Promise.resolve({
          documentMetadata,
          documentMetadataValidation,
          documentVersions: versions,
        });
      }
      return Promise.resolve({});
    });
    fireEvent.click(screen.getByRole("button", { name: "Save current state" }));
    fireEvent.change(screen.getByLabelText("Name (optional)"), {
      target: { value: "single checkpoint" },
    });
    const save = screen.getByRole("button", { name: "Save" });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() =>
      expect(
        gql.mock.calls.filter(
          ([{ query }]) => query.op === "captureDocumentHistory",
        ),
      ).toHaveLength(1),
    );
    finishCapture({
      captureDocumentHistory: {
        historyId: "105",
        version: { ...versions[0], id: "ver-5", docHistoryId: "105" },
      },
    });
    await waitFor(() =>
      expect(screen.queryByTestId("document-version-modal-create")).toBeNull(),
    );
  });

  test("returning from the shared preview refreshes the sidebar without a mutation", async () => {
    const gql = renderSidebar();
    const title = await screen.findByText("release");
    fireEvent.click(title.closest("button")!);
    await act(async () => {
      getDefaultStore().set(navigationState, {
        open: false,
        pageId: "doc-1",
      });
    });
    await waitFor(() =>
      expect(
        gql.mock.calls.filter(
          ([{ query }]) => query.op === "documentVersioningOverview",
        ),
      ).toHaveLength(2),
    );
    expect(gql.mock.calls.map(([{ query }]) => query.op)).toEqual([
      "documentVersioningOverview",
      "documentVersioningOverview",
    ]);
  });

  test("a failed upload acknowledgement leaves save open and never captures", async () => {
    const workspace = {
      id: "workspace-1",
      engine: {
        doc: {
          waitForSynced: async () => {
            throw new Error("Document is offline");
          },
        },
      },
    } as unknown as Parameters<typeof waitForDocumentVersionSync>[0];
    const gql = renderSidebar(vi.fn(), () =>
      waitForDocumentVersionSync(workspace, "doc-1"),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Save current state" }),
    );
    fireEvent.change(screen.getByLabelText("Name (optional)"), {
      target: { value: "checkpoint" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(
        "The document has not finished syncing. Check your connection and try again; no snapshot action was started.",
      ),
    ).not.toBeNull();
    expect(screen.getByTestId("document-version-modal-create")).not.toBeNull();
    expect(
      gql.mock.calls.filter(
        ([{ query }]) => query.op === "captureDocumentHistory",
      ),
    ).toHaveLength(0);
  });

  test("retries a metadata refresh without repeating a committed capture", async () => {
    const refreshMetadata = vi
      .fn()
      .mockRejectedValueOnce(new Error("Metadata refresh unavailable"))
      .mockResolvedValue(undefined);
    const gql = renderSidebar(vi.fn(), undefined, refreshMetadata);
    fireEvent.click(
      await screen.findByRole("button", { name: "Save current state" }),
    );
    fireEvent.change(screen.getByLabelText("Name (optional)"), {
      target: { value: "checkpoint" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Metadata refresh unavailable"),
    ).not.toBeNull();
    expect(screen.queryByTestId("document-version-modal-create")).toBeNull();
    fireEvent.click(screen.getByTestId("document-version-refresh"));
    await waitFor(() => expect(refreshMetadata).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Metadata refresh unavailable")).toBeNull();
    expect(
      gql.mock.calls.filter(
        ([{ query }]) => query.op === "captureDocumentHistory",
      ),
    ).toHaveLength(1);
  });

  test("keeps named-version management in the full history surface", async () => {
    renderSidebar();
    await screen.findByText("reviewed-v1");
    expect(screen.queryByTestId("document-version-card")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All states" }));
    expect(getDefaultStore().get(navigationState)).toMatchObject({
      open: true,
      pageId: "doc-1",
    });
  });

  test("keeps failed loads visible and retries rather than reporting an empty history", async () => {
    historyRead.empty = true;
    const gql = vi
      .fn()
      .mockRejectedValueOnce(new Error("document not found"))
      .mockResolvedValue({
        documentMetadata,
        documentMetadataValidation: {
          valid: true,
          issues: [],
          blockedActions: [],
        },
        documentVersions: versions,
      });

    render(
      <MyoxusUIProvider>
        <DocumentVersionsSidebar
          beforeCapture={async () => {}}
          refreshMetadata={async () => {}}
          docId="doc-1"
          graphqlService={{ gql } as never}
          workspaceId="workspace-1"
        />
      </MyoxusUIProvider>,
    );

    expect(
      await screen.findByText("Failed to load document versions"),
    ).not.toBeNull();
    expect(screen.queryByTestId("document-versions-empty")).toBeNull();
    expect(
      screen
        .getByTestId("document-versions-sidebar")
        .hasAttribute("data-empty"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("document-versions-empty");
    expect(screen.queryByText("Failed to load document versions")).toBeNull();
    expect(gql).toHaveBeenLastCalledWith({
      query: expect.objectContaining({ op: "documentVersioningOverview" }),
      variables: { workspaceId: "workspace-1", docId: "doc-1" },
    });
  });
});
