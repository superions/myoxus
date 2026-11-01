import { classNames } from "@myoxus/classnames";
import {
  type PDF,
  type PDFMeta,
  type PDFRendererState,
  PDFService,
  PDFStatus,
} from "@myoxus/core/modules/pdf";
import { cacheBitmap } from "@myoxus/core/modules/pdf/cache/bitmap-cache";
import {
  Item,
  List,
  ListPadding,
  ListWithSmallGap,
  LoadingSvg,
  PDFPageRenderer,
  type PDFVirtuosoContext,
  type PDFVirtuosoProps,
  Scroller,
  ScrollSeekPlaceholder,
} from "@myoxus/core/modules/pdf/views";
import {
  ArrowDownSmallIcon,
  ArrowUpSmallIcon,
  CloseIcon,
  CollapseIcon,
  ExpandIcon,
  FileSearchIcon,
  InformationIcon,
  MinusIcon,
  PlusIcon,
} from "@myoxus/icons/react";
import { LiveData, useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import {
  AttachmentViewerRoot,
  Button,
  IconButton,
  Menu,
  MenuPanel,
  observeResize,
  PDF_PREVIEW_CLASS_NAMES,
  PdfPreviewMeta,
  PdfPreviewPageCounter,
  PdfPreviewSearchField,
  PdfPreviewThumbnailRail,
  PdfPreviewToolbar,
  PdfPreviewViewport,
} from "@myoxus/ui-facade";
import { nanoid } from "nanoid";
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ScrollSeekConfiguration,
  Virtuoso,
  type VirtuosoHandle,
} from "react-virtuoso";
import { firstValueFrom, type Subscription } from "rxjs";

import type { AttachmentViewerProps } from "../types";
import { fitToPage } from "./utils";

// PDF.js and Virtuoso work in measured CSS-pixel viewports. Keep these
// renderer-space numbers named here; visible chrome spacing is owned by the
// Facade PDF preview roles and `pdf-preview.css`.
const THUMBNAIL_RENDER_WIDTH_PX = 94;
const THUMBNAIL_RAIL_CHROME_HEIGHT_PX = 60 + 24 + 24 + 2 + 8;
const THUMBNAIL_RENDER_GAP_PX = 12;
const PAGE_RENDER_VIEWPORT_GUTTER_PX = 40;
const PAGE_RENDER_OVERSCAN_MIN_PX = 800;
const SCROLL_SEEK_ENTER_VELOCITY_PX = 1024;
const SCROLL_SEEK_EXIT_VELOCITY_PX = 10;

// Zoom step values and fit-to-page sentinel
const ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
const ZOOM_FIT = 1.0; // zoom = 1.0 means "fit to viewport" (native behaviour)

function calculatePageNum(el: HTMLElement, pageCount: number) {
  const { scrollTop, scrollHeight } = el;
  const pageHeight = scrollHeight / pageCount;
  const n = scrollTop / pageHeight;
  const t = n / pageCount;
  const index = Math.floor(n + t);
  const cursor = Math.min(index, pageCount - 1);
  return cursor;
}

export interface PDFViewerInnerProps {
  pdf: PDF;
  meta: PDFMeta;
}

export const PDFViewerInner = ({ pdf, meta }: PDFViewerInnerProps) => {
  const [cursor, setCursor] = useState(0);
  const [collapsed, setCollapsed] = useState(true);
  const [viewportInfo, setViewportInfo] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(ZOOM_FIT);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [textStrings, setTextStrings] = useState<Map<number, string[]>>(
    new Map(),
  );
  const [matchList, setMatchList] = useState<
    Array<{ pageNum: number; itemIndex: number }>
  >([]);
  const [matchCursor, setMatchCursor] = useState(0);
  const [isIndexing, setIsIndexing] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);

  const viewerRef = useRef<HTMLDivElement>(null);
  const pagesScrollerRef = useRef<HTMLElement | null>(null);
  const pagesScrollerHandleRef = useRef<VirtuosoHandle>(null);
  const thumbnailsScrollerHandleRef = useRef<VirtuosoHandle>(null);
  const prefetching = useRef<Map<string, () => void>>(new Map());

  const updateScrollerRef = useCallback(
    (scroller: HTMLElement | Window | null) => {
      pagesScrollerRef.current = scroller as HTMLElement;
    },
    [],
  );

  const onScroll = useCallback(() => {
    const el = pagesScrollerRef.current;
    if (!el) return;

    const { pageCount } = meta;
    if (!pageCount) return;

    const cursor = calculatePageNum(el, pageCount);
    setCursor(cursor);
  }, [pagesScrollerRef, meta]);

  const onPageSelect = useCallback(
    (index: number) => {
      const scroller = pagesScrollerHandleRef.current;
      if (!scroller) return;

      scroller.scrollToIndex({
        index,
        align: "center",
        behavior: "smooth",
      });
    },
    [pagesScrollerHandleRef],
  );

  // Fetch text strings for all pages when find bar opens (for full-document indexing)
  const pageCount = meta.pageCount;

  useEffect(() => {
    if (!findOpen) {
      setTextStrings(new Map());
      setMatchList([]);
      setMatchCursor(0);
      return;
    }

    let cancelled = false;
    setIsIndexing(true);

    (async () => {
      const map = new Map<number, string[]>();
      for (let i = 0; i < pageCount; i++) {
        if (cancelled) return;
        try {
          const strs = await firstValueFrom(
            pdf.renderer.ob$("getTextStrings", { pageNum: i }),
          );
          map.set(i, strs ?? []);
        } catch {
          map.set(i, []);
        }
      }
      if (!cancelled) {
        setTextStrings(map);
        setIsIndexing(false);
      }
    })().catch(console.error);

    return () => {
      cancelled = true;
    };
  }, [findOpen, pageCount, pdf]);

  // Rebuild match list whenever query, text strings, or case sensitivity changes
  useEffect(() => {
    if (!findQuery) {
      setMatchList([]);
      setMatchCursor(0);
      return;
    }

    const needle = caseSensitive ? findQuery : findQuery.toLowerCase();
    const matches: Array<{ pageNum: number; itemIndex: number }> = [];

    for (let p = 0; p < meta.pageCount; p++) {
      const strs = textStrings.get(p) ?? [];
      strs.forEach((str, idx) => {
        const hay = caseSensitive ? str : str.toLowerCase();
        if (hay.includes(needle)) {
          matches.push({ pageNum: p, itemIndex: idx });
        }
      });
    }

    setMatchList(matches);
    setMatchCursor(0);

    // Auto-scroll to first match
    if (matches.length > 0) {
      pagesScrollerHandleRef.current?.scrollToIndex({
        index: matches[0].pageNum,
        align: "start",
        behavior: "smooth",
      });
    }
  }, [findQuery, textStrings, caseSensitive, meta.pageCount]);

  const navigateToMatch = useCallback(
    (newCursor: number) => {
      if (!matchList.length) return;
      const next =
        ((newCursor % matchList.length) + matchList.length) % matchList.length;
      setMatchCursor(next);
      pagesScrollerHandleRef.current?.scrollToIndex({
        index: matchList[next].pageNum,
        align: "start",
        behavior: "smooth",
      });
    },
    [matchList],
  );

  const findNext = useCallback(
    () => navigateToMatch(matchCursor + 1),
    [matchCursor, navigateToMatch],
  );
  const findPrev = useCallback(
    () => navigateToMatch(matchCursor - 1),
    [matchCursor, navigateToMatch],
  );

  // Keyboard shortcuts for find (Ctrl/Cmd+F) and zoom (Ctrl/Cmd ±/0)
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        setFindOpen(true);
        setTimeout(() => findInputRef.current?.focus(), 0);
        return;
      }

      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoom((z) => {
          const idx = ZOOM_LEVELS.findIndex((l) => l > z);
          return idx !== -1 ? ZOOM_LEVELS[idx] : z;
        });
        return;
      }

      if (e.key === "-") {
        e.preventDefault();
        setZoom((z) => {
          const idx = [...ZOOM_LEVELS].reverse().findIndex((l) => l < z);
          const arr = [...ZOOM_LEVELS].reverse();
          return idx !== -1 ? arr[idx] : z;
        });
        return;
      }

      if (e.key === "0") {
        e.preventDefault();
        setZoom(ZOOM_FIT);
        return;
      }
    };

    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.addEventListener("keydown", handler);
    return () => viewer.removeEventListener("keydown", handler);
  }, []);

  const closeFindBar = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
    setCaseSensitive(false);
  }, []);

  const handleFindKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        closeFindBar();
      } else if (e.key === "Enter") {
        if (e.shiftKey) findPrev();
        else findNext();
      }
    },
    [closeFindBar, findNext, findPrev],
  );

  const pageContent = useCallback(
    (
      index: number,
      _: unknown,
      {
        viewportInfo,
        meta,
        onPageSelect,
        pageClassName,
        resize,
        isThumbnail,
      }: PDFVirtuosoContext,
    ) => {
      const currentMatch = matchList[matchCursor];
      const currentMatchItemIndex =
        !isThumbnail && currentMatch?.pageNum === index
          ? currentMatch.itemIndex
          : undefined;
      const className = isThumbnail
        ? classNames(pageClassName, { selected: index === cursor })
        : pageClassName;

      return (
        <PDFPageRenderer
          key={`${pageClassName}-${index}`}
          pdf={pdf}
          pageNum={index}
          className={className}
          viewportInfo={viewportInfo}
          actualSize={meta.pageSizes[index]}
          maxSize={meta.maxSize}
          onSelect={onPageSelect}
          resize={resize}
          isThumbnail={isThumbnail}
          searchQuery={isThumbnail ? undefined : findQuery || undefined}
          caseSensitive={caseSensitive}
          currentMatchItemIndex={currentMatchItemIndex}
        />
      );
    },
    [pdf, findQuery, caseSensitive, matchList, matchCursor, cursor],
  );

  const zoomedResize = useCallback(
    (
      vp: { width: number; height: number },
      actual: { width: number; height: number },
      max: { width: number; height: number },
      isThumbnail?: boolean,
    ) => {
      const base = fitToPage(vp, actual, max, isThumbnail);
      if (isThumbnail || zoom === ZOOM_FIT) return base;
      return {
        ...base,
        width: Math.ceil(base.width * zoom),
        height: Math.ceil(base.height * zoom),
      };
    },
    [zoom],
  );

  const thumbnailsConfig = useMemo(() => {
    const { height: vh } = viewportInfo;
    const { pageCount, pageSizes, maxSize } = meta;
    const t = Math.min(maxSize.width / maxSize.height, 1);
    const pw = THUMBNAIL_RENDER_WIDTH_PX / t;
    const newMaxSize = {
      width: pw,
      height: pw * (maxSize.height / maxSize.width),
    };
    const newPageSizes = pageSizes.map(({ width, height }) => {
      const w = newMaxSize.width * (width / maxSize.width);
      return {
        width: w,
        height: w * (height / width),
      };
    });
    const height = Math.min(
      vh - THUMBNAIL_RAIL_CHROME_HEIGHT_PX,
      newPageSizes.reduce((h, { height }) => h + height * t, 0) +
        (pageCount - 1) * THUMBNAIL_RENDER_GAP_PX,
    );
    return {
      context: {
        onPageSelect,
        viewportInfo: {
          width: pw,
          height,
        },
        meta: {
          pageCount,
          maxSize: newMaxSize,
          pageSizes: newPageSizes,
        },
        resize: fitToPage,
        isThumbnail: true,
        pageClassName: PDF_PREVIEW_CLASS_NAMES.thumbnailPage,
      },
      style: { height },
    };
  }, [meta, viewportInfo, onPageSelect]);

  const overscan = useMemo(() => {
    const h = meta.maxSize.height || 0;
    return Math.max(Math.ceil(h * 1.2), PAGE_RENDER_OVERSCAN_MIN_PX);
  }, [meta.maxSize.height]);

  const scrollSeekConfig = useMemo<ScrollSeekConfiguration>(() => {
    return {
      enter: (velocity) => Math.abs(velocity) > SCROLL_SEEK_ENTER_VELOCITY_PX,
      exit: (velocity) => Math.abs(velocity) < SCROLL_SEEK_EXIT_VELOCITY_PX,
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    return observeResize(viewer, ({ contentRect: { width, height } }) =>
      setViewportInfo({ width, height }),
    );
  }, []);

  const prefetchPage = useCallback(
    (index: number) => {
      if (index < 0 || index >= meta.pageCount) return;
      const renderViewport = {
        width: viewportInfo.width - PAGE_RENDER_VIEWPORT_GUTTER_PX,
        height: viewportInfo.height - PAGE_RENDER_VIEWPORT_GUTTER_PX,
      };
      if (renderViewport.width <= 0 || renderViewport.height <= 0) return;

      const actualSize = meta.pageSizes[index];
      const renderSize = fitToPage(renderViewport, actualSize, meta.maxSize);
      const scale = window.devicePixelRatio;
      const key = `${index}:${renderSize.width}:${renderSize.height}:${scale}`;
      if (prefetching.current.has(key)) return;

      const { page, release } = pdf.page(
        index,
        `${renderSize.width}:${renderSize.height}:${scale}`,
      );
      let stopped = false;
      let subscription: Subscription | undefined;

      const stop = () => {
        if (stopped) return;
        stopped = true;
        prefetching.current.delete(key);
        page.render.unsubscribe();
        release();
        subscription?.unsubscribe();
      };

      subscription = page.bitmap$.subscribe((bitmap) => {
        if (!bitmap) return;
        cacheBitmap(
          {
            blobId: pdf.id,
            pageNum: index,
            width: renderSize.width,
            height: renderSize.height,
            scale,
          },
          bitmap,
        )
          .catch((e) => console.error("Failed to cache bitmap", e))
          .finally(stop);
      });

      prefetching.current.set(key, stop);
      page.render({
        width: renderSize.width,
        height: renderSize.height,
        scale,
      });
    },
    [meta, pdf, viewportInfo],
  );

  useEffect(() => {
    prefetchPage(cursor - 1);
    prefetchPage(cursor + 1);

    const map = prefetching.current;
    return () => {
      map.forEach((stop) => stop());
      map.clear();
    };
  }, [cursor, prefetchPage]);

  return (
    <AttachmentViewerRoot
      ref={viewerRef}
      tabIndex={-1}
      data-testid="pdf-viewer"
      grid
      scrollable
    >
      <PdfPreviewViewport variant="attachment">
        {findOpen && (
          <PdfPreviewToolbar placement="top-end" data-testid="pdf-find-bar">
            <PdfPreviewSearchField
              ref={findInputRef}
              type="text"
              placeholder="Find in document…"
              value={findQuery}
              onChange={setFindQuery}
              onKeyDown={handleFindKeyDown}
              aria-label="Find in document"
              preFix={<FileSearchIcon />}
            />
            {findQuery &&
              (isIndexing ? (
                <PdfPreviewMeta data-myoxus-ui-role="pdf-preview-find-counter">
                  …
                </PdfPreviewMeta>
              ) : (
                <PdfPreviewPageCounter
                  current={matchList.length === 0 ? 0 : matchCursor + 1}
                  total={matchList.length}
                />
              ))}
            <IconButton
              icon={<ArrowUpSmallIcon />}
              onClick={findPrev}
              aria-label="Previous match"
              tooltip="Previous match"
              tooltipShortcut={["Shift", "Enter"]}
              disabled={matchList.length === 0}
            />
            <IconButton
              icon={<ArrowDownSmallIcon />}
              onClick={findNext}
              aria-label="Next match"
              tooltip="Next match"
              tooltipShortcut={["Enter"]}
              disabled={matchList.length === 0}
            />
            <Button
              variant={caseSensitive ? "secondary" : "plain"}
              onClick={() => setCaseSensitive((v) => !v)}
              aria-label="Toggle case sensitive"
              title="Case sensitive"
              aria-pressed={caseSensitive}
            >
              Aa
            </Button>
            <IconButton
              icon={<CloseIcon />}
              onClick={closeFindBar}
              aria-label="Close find bar"
              tooltip="Close find bar"
            />
          </PdfPreviewToolbar>
        )}
        <PdfPreviewToolbar
          placement="bottom-center"
          data-testid="pdf-zoom-toolbar"
        >
          <IconButton
            icon={<MinusIcon />}
            onClick={() =>
              setZoom((z) => {
                const arr = [...ZOOM_LEVELS].reverse();
                const idx = arr.findIndex((l) => l < z);
                return idx !== -1 ? arr[idx] : z;
              })
            }
            aria-label="Zoom out"
            tooltip="Zoom out"
            tooltipShortcut={["Ctrl/Cmd", "-"]}
          />
          <PdfPreviewMeta data-myoxus-ui-role="pdf-preview-zoom-level" truncate>
            {zoom === ZOOM_FIT ? "Fit" : `${Math.round(zoom * 100)}%`}
          </PdfPreviewMeta>
          <IconButton
            icon={<PlusIcon />}
            onClick={() =>
              setZoom((z) => {
                const idx = ZOOM_LEVELS.findIndex((l) => l > z);
                return idx !== -1 ? ZOOM_LEVELS[idx] : z;
              })
            }
            aria-label="Zoom in"
            tooltip="Zoom in"
            tooltipShortcut={["Ctrl/Cmd", "+"]}
          />
          <Button
            variant="plain"
            onClick={() => setZoom(ZOOM_FIT)}
            aria-label="Reset zoom"
            title="Reset zoom (Ctrl/Cmd 0)"
          >
            Fit
          </Button>
        </PdfPreviewToolbar>
        <Virtuoso<PDFVirtuosoProps>
          key={pdf.id}
          ref={pagesScrollerHandleRef}
          scrollerRef={updateScrollerRef}
          onScroll={onScroll}
          className={PDF_PREVIEW_CLASS_NAMES.virtuoso}
          totalCount={meta.pageCount}
          itemContent={pageContent}
          components={{
            Item,
            List,
            Scroller,
            Header: ListPadding,
            Footer: ListPadding,
            ScrollSeekPlaceholder,
          }}
          increaseViewportBy={{ top: overscan, bottom: overscan }}
          context={{
            viewportInfo: {
              width: viewportInfo.width - PAGE_RENDER_VIEWPORT_GUTTER_PX,
              height: viewportInfo.height - PAGE_RENDER_VIEWPORT_GUTTER_PX,
            },
            meta,
            resize: zoomedResize,
            pageClassName: PDF_PREVIEW_CLASS_NAMES.page,
          }}
          scrollSeekConfiguration={scrollSeekConfig}
        />
        <PdfPreviewThumbnailRail
          collapsed={collapsed}
          footer={
            <>
              <PdfPreviewPageCounter
                current={meta.pageCount > 0 ? cursor + 1 : 0}
                total={meta.pageCount}
              />
              <IconButton
                icon={collapsed ? <CollapseIcon /> : <ExpandIcon />}
                onClick={() => setCollapsed(!collapsed)}
                aria-label={
                  collapsed ? "Expand thumbnails" : "Collapse thumbnails"
                }
              />
            </>
          }
        >
          <Virtuoso<PDFVirtuosoProps>
            key={`${pdf.id}-thumbnail`}
            ref={thumbnailsScrollerHandleRef}
            className={PDF_PREVIEW_CLASS_NAMES.virtuoso}
            totalCount={meta.pageCount}
            itemContent={pageContent}
            components={{
              Item,
              List: ListWithSmallGap,
              Scroller,
              ScrollSeekPlaceholder,
            }}
            style={thumbnailsConfig.style}
            context={thumbnailsConfig.context}
            scrollSeekConfiguration={scrollSeekConfig}
          />
        </PdfPreviewThumbnailRail>
      </PdfPreviewViewport>
    </AttachmentViewerRoot>
  );
};

type PDFViewerStatusProps = {
  message: string;
  reload: () => void;
};

function PDFViewerStatusMenuItems({ message, reload }: PDFViewerStatusProps) {
  const onClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      reload();
    },
    [reload],
  );

  return (
    <MenuPanel panelWidth="wide" panelPadding="comfortable">
      <PdfPreviewMeta>{message}</PdfPreviewMeta>
      <PdfPreviewToolbar
        placement="inline"
        data-myoxus-ui-role="pdf-preview-status-actions"
      >
        <Button
          data-testid="pdf-viewer-reload"
          variant="primary"
          onClick={onClick}
        >
          Reload
        </Button>
      </PdfPreviewToolbar>
    </MenuPanel>
  );
}

function PDFViewerStatus(props: PDFViewerStatusProps) {
  return (
    <PdfPreviewToolbar
      placement="side-end"
      data-testid="pdf-viewer-status-wrapper"
      data-myoxus-ui-role="pdf-preview-status"
    >
      <Menu
        items={<PDFViewerStatusMenuItems {...props} />}
        contentOptions={{
          sideOffset: 8,
          panelPadding: "comfortable",
          panelWidth: "wide",
        }}
      >
        <IconButton
          icon={<InformationIcon />}
          data-testid="pdf-viewer-status"
          variant="error"
          aria-label="PDF renderer status"
        />
      </Menu>
    </PdfPreviewToolbar>
  );
}

function PDFViewerContainer({
  model,
  reload,
  ...props
}: AttachmentViewerProps & { reload: () => void }) {
  const pdfService = useService(PDFService);
  const [pdf, setPdf] = useState<PDF | null>(null);
  const state = useLiveData(
    useMemo(
      () =>
        pdf?.state$ ??
        new LiveData<PDFRendererState>({ status: PDFStatus.IDLE }),
      [pdf],
    ),
  );
  const blobId = useLiveData(
    useMemo(() => LiveData.fromSignal(model.props.sourceId$), [model]),
  );

  useEffect(() => {
    if (state.status !== PDFStatus.Error) return;
    track.$.attachment.$.openPDFRendererFail();
  }, [state]);

  useEffect(() => {
    if (!blobId) return;

    const { pdf, release } = pdfService.get(blobId);
    setPdf(pdf);

    return () => {
      release();
    };
  }, [blobId, pdfService, setPdf]);

  if (pdf && state.status === PDFStatus.Opened) {
    return <PDFViewerInner {...props} pdf={pdf} meta={state.meta} />;
  }

  return (
    <AttachmentViewerRoot grid scrollable>
      <PdfPreviewViewport variant="attachment">
        <PDFLoading />
        {state.status === PDFStatus.Error && (
          <PDFViewerStatus message={state.error.message} reload={reload} />
        )}
      </PdfPreviewViewport>
    </AttachmentViewerRoot>
  );
}

const PDFLoading = () => (
  <PdfPreviewToolbar
    placement="inline"
    data-myoxus-ui-role="pdf-preview-loading"
  >
    <LoadingSvg />
  </PdfPreviewToolbar>
);

export function PDFViewer(props: AttachmentViewerProps) {
  const [refreshKey, setRefreshKey] = useState<string | null>(null);
  const reload = useCallback(() => setRefreshKey(nanoid()), []);
  return <PDFViewerContainer key={refreshKey} reload={reload} {...props} />;
}
