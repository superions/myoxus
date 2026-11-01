/**
 * @vitest-environment happy-dom
 *
 * PDF viewer component contract — closes the component-test gap in
 * `todo/pdf-refactoring.md`.
 *
 * The heavy renderer/worker is mocked here on purpose: this spec validates the
 * React state surface (loading, error, opened document, find, zoom,
 * thumbnails) while renderer metadata/text extraction is locked separately by
 * `pdf-metadata.spec.ts` and `pdf-find-logic.spec.ts`.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useImperativeHandle,
} from "react";
import { of } from "rxjs";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const PDFStatus = {
    IDLE: 0,
    Opening: 1,
    Opened: 2,
    Error: 3,
  } as const;
  return {
    PDFStatus,
    viewerState: { status: PDFStatus.Opening } as unknown,
    pdfServiceGet: vi.fn(() => ({
      pdf: {
        id: "pdf-service-doc",
        state$: { __kind: "pdf-state" },
      },
      release: vi.fn(),
    })),
    pdfService: null as unknown,
    scrollToIndex: vi.fn(),
  };
});

const PDFStatus = mocks.PDFStatus;
mocks.pdfService = { get: mocks.pdfServiceGet };

vi.mock("@myoxus/ui-facade", () => ({
  AttachmentViewerRoot: forwardRef<
    HTMLDivElement,
    HTMLAttributes<HTMLDivElement> & { grid?: boolean; scrollable?: boolean }
  >(function AttachmentViewerRoot(
    { children, grid, scrollable, ...props },
    ref,
  ) {
    return (
      <div
        ref={ref}
        data-grid={grid ? "true" : undefined}
        data-scrollable={scrollable ? "true" : undefined}
        {...props}
      >
        {children}
      </div>
    );
  }),
  Button: ({
    children,
    onClick,
    variant: _variant,
    ...props
  }: {
    children: ReactNode;
    onClick?: () => void;
    variant?: string;
  }) => (
    <button onClick={onClick} type="button" {...props}>
      {children}
    </button>
  ),
  IconButton: ({
    "aria-label": ariaLabel,
    icon,
    onClick,
    tooltip: _tooltip,
    tooltipShortcut: _tooltipShortcut,
    variant: _variant,
    ...props
  }: {
    "aria-label"?: string;
    icon: ReactNode;
    onClick?: () => void;
    tooltip?: ReactNode;
    tooltipShortcut?: string[];
    variant?: string;
  }) => (
    <button
      aria-label={ariaLabel ?? "Toggle thumbnails"}
      onClick={onClick}
      type="button"
      {...props}
    >
      {icon}
    </button>
  ),
  Menu: ({ children, items }: { children: ReactNode; items: ReactNode }) => (
    <div>
      {children}
      <div data-testid="pdf-status-menu-items">{items}</div>
    </div>
  ),
  MenuPanel: ({ children }: { children: ReactNode }) => (
    <div data-testid="pdf-status-menu-panel">{children}</div>
  ),
  PdfPreviewMeta: ({
    children,
    truncate: _truncate,
    ...props
  }: {
    children: ReactNode;
    truncate?: boolean;
  }) => <span {...props}>{children}</span>,
  PdfPreviewPageCounter: ({
    current,
    total,
  }: {
    current: ReactNode;
    total: ReactNode;
  }) => (
    <span>
      <span className="page-cursor">{current}</span>/
      <span className="page-count">{total}</span>
    </span>
  ),
  PdfPreviewSearchField: ({
    onChange,
    preFix: _preFix,
    ...props
  }: {
    onChange?: (value: string) => void;
    preFix?: ReactNode;
  }) => (
    <input
      {...props}
      onChange={(event) => onChange?.(event.currentTarget.value)}
    />
  ),
  PdfPreviewThumbnailRail: ({
    children,
    footer,
  }: {
    children: ReactNode;
    footer?: ReactNode;
  }) => (
    <aside>
      {children}
      {footer}
    </aside>
  ),
  PdfPreviewToolbar: ({
    children,
    orientation: _orientation,
    placement: _placement,
    ...props
  }: {
    children: ReactNode;
    orientation?: string;
    placement?: string;
  }) => <div {...props}>{children}</div>,
  PdfPreviewViewport: ({
    children,
    variant: _variant,
    ...props
  }: {
    children: ReactNode;
    variant?: string;
  }) => <div {...props}>{children}</div>,
  PDF_PREVIEW_CLASS_NAMES: {
    page: "myoxus-pdf-preview-page",
    thumbnailPage: "myoxus-pdf-preview-thumbnail-page",
    virtuoso: "myoxus-pdf-preview-virtuoso",
  },
  observeResize: (
    _element: Element,
    cb: (entry: { contentRect: DOMRect }) => void,
  ) => {
    cb({
      contentRect: {
        width: 900,
        height: 700,
      } as DOMRect,
    });
    return () => {};
  },
}));

vi.mock("@myoxus/core/modules/pdf", () => ({
  PDFService: class PDFService {},
  PDFStatus: mocks.PDFStatus,
}));

vi.mock("@myoxus/core/modules/pdf/cache/bitmap-cache", () => ({
  cacheBitmap: vi.fn(),
}));

vi.mock("@myoxus/core/modules/pdf/views", () => ({
  Item: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  List: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ListPadding: () => <div data-testid="pdf-list-padding" />,
  ListWithSmallGap: ({ children }: { children: ReactNode }) => (
    <div data-testid="pdf-thumbnail-list-inner">{children}</div>
  ),
  LoadingSvg: () => <div data-testid="pdf-loading-svg" />,
  PDFPageRenderer: ({
    pageNum,
    isThumbnail,
    onSelect,
    searchQuery,
    currentMatchItemIndex,
  }: {
    pageNum: number;
    isThumbnail?: boolean;
    onSelect?: (pageNum: number) => void;
    searchQuery?: string;
    currentMatchItemIndex?: number;
  }) => (
    <button
      data-testid={isThumbnail ? "pdf-thumbnail-page" : "pdf-page"}
      onClick={() => onSelect?.(pageNum)}
      type="button"
    >
      {isThumbnail ? "thumbnail" : "page"}-{pageNum}
      {searchQuery ? ` query:${searchQuery}` : ""}
      {currentMatchItemIndex !== undefined
        ? ` current:${currentMatchItemIndex}`
        : ""}
    </button>
  ),
  Scroller: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollSeekPlaceholder: () => <div data-testid="pdf-scroll-placeholder" />,
}));

vi.mock("@myoxus/icons/react", () => ({
  ArrowDownSmallIcon: () => <span>arrow-down</span>,
  ArrowUpSmallIcon: () => <span>arrow-up</span>,
  CloseIcon: () => <span>close</span>,
  CollapseIcon: () => <span>collapse</span>,
  ExpandIcon: () => <span>expand</span>,
  FileSearchIcon: () => <span>find</span>,
  InformationIcon: () => <span>info</span>,
  MinusIcon: () => <span>minus</span>,
  PlusIcon: () => <span>plus</span>,
}));

vi.mock("@myoxus/infra", () => ({
  LiveData: class LiveData {
    constructor(public value: unknown) {}
    static fromSignal() {
      return { __kind: "blob-id" };
    }
  },
  useLiveData: (source: { __kind?: string } | null) => {
    if (source?.__kind === "blob-id") return "blob-key";
    return mocks.viewerState;
  },
  // Must be referentially stable: the real PDFViewer has `pdfService` in an
  // effect dependency list. Returning a new object here would create an
  // artificial render/effect loop and mask the component contract.
  useService: () => mocks.pdfService,
}));

vi.mock("@myoxus/theme", () => ({
  cssVar: () => "var(--mock)",
}));

vi.mock("@myoxus/track", () => ({
  default: {
    $: {
      attachment: {
        $: {
          openPDFRendererFail: vi.fn(),
        },
      },
    },
  },
}));

vi.mock("nanoid", () => ({
  nanoid: () => "refresh-key",
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(
    (
      {
        totalCount,
        itemContent,
        context,
        scrollerRef,
      }: {
        totalCount: number;
        itemContent: (
          index: number,
          item: unknown,
          context: unknown,
        ) => ReactNode;
        context: { isThumbnail?: boolean };
        scrollerRef?: (el: HTMLElement | null) => void;
      },
      ref,
    ) => {
      useImperativeHandle(ref, () => ({ scrollToIndex: mocks.scrollToIndex }));
      const host = document.createElement("div");
      Object.defineProperties(host, {
        scrollTop: { value: 0 },
        scrollHeight: { value: Math.max(totalCount, 1) * 100 },
      });
      scrollerRef?.(host);
      return (
        <div
          data-testid={
            context?.isThumbnail ? "pdf-thumbnail-list" : "pdf-page-list"
          }
        >
          {Array.from({ length: totalCount }, (_, index) =>
            itemContent(index, null, context),
          )}
        </div>
      );
    },
  ),
}));

import {
  PDFViewer,
  PDFViewerInner,
} from "../editor/attachment-viewer/pdf/pdf-viewer";

const meta = {
  pageCount: 3,
  maxSize: { width: 600, height: 800 },
  pageSizes: [
    { width: 600, height: 800 },
    { width: 600, height: 800 },
    { width: 600, height: 800 },
  ],
};

function fakePdf() {
  return {
    id: "pdf-doc",
    renderer: {
      ob$: vi.fn((_op: string, args: { pageNum: number }) => {
        const pageStrings = [
          ["Alpha section", "Beta"],
          ["alpha appendix"],
          ["Gamma"],
        ];
        return of(pageStrings[args.pageNum] ?? []);
      }),
    },
    page: vi.fn(() => ({
      page: {
        bitmap$: of(null),
        render: Object.assign(vi.fn(), { unsubscribe: vi.fn() }),
      },
      release: vi.fn(),
    })),
  };
}

describe("PDFViewer component states", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.viewerState = { status: PDFStatus.Opening };
  });

  test("renders loading and error states through the container", () => {
    mocks.viewerState = { status: PDFStatus.Opening };
    const model = { props: { sourceId$: {} } };
    render(<PDFViewer model={model as never} />);
    expect(screen.getByTestId("pdf-loading-svg")).toBeTruthy();

    cleanup();
    mocks.viewerState = {
      status: PDFStatus.Error,
      error: new Error("broken pdf"),
    };
    render(<PDFViewer model={model as never} />);
    expect(screen.getByTestId("pdf-viewer-status-wrapper")).toBeTruthy();
    expect(screen.getByText("broken pdf")).toBeTruthy();
    expect(screen.getByTestId("pdf-viewer-reload")).toBeTruthy();
  });

  test("renders opened document pages and thumbnails", () => {
    render(<PDFViewerInner pdf={fakePdf() as never} meta={meta} />);
    expect(screen.getByTestId("pdf-viewer")).toBeTruthy();
    expect(screen.getAllByTestId("pdf-page")).toHaveLength(3);
    expect(screen.getAllByTestId("pdf-thumbnail-page")).toHaveLength(3);
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  test("supports find indexing, next/previous navigation and case sensitivity", async () => {
    render(<PDFViewerInner pdf={fakePdf() as never} meta={meta} />);
    fireEvent.keyDown(screen.getByTestId("pdf-viewer"), {
      key: "f",
      ctrlKey: true,
    });

    const input = await screen.findByLabelText("Find in document");
    fireEvent.change(input, { target: { value: "alpha" } });

    await waitFor(() =>
      expect(
        screen.getByText((_, element) => element?.textContent === "1/2"),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(
      screen.getByText((_, element) => element?.textContent === "2/2"),
    ).toBeTruthy();
    expect(mocks.scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1 }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle case sensitive" }),
    );
    await waitFor(() =>
      expect(
        screen.getByText((_, element) => element?.textContent === "1/1"),
      ).toBeTruthy(),
    );
  });

  test("supports zoom controls", () => {
    render(<PDFViewerInner pdf={fakePdf() as never} meta={meta} />);
    expect(screen.getAllByText("Fit").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("125%")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getAllByText("Fit").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    expect(screen.getAllByText("Fit").length).toBeGreaterThanOrEqual(1);
  });
});
