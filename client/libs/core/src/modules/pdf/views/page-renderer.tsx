import { useI18n } from "@myoxus/i18n";
import { useLiveData } from "@myoxus/infra";
import {
  observeIntersection,
  PDF_PREVIEW_CLASS_NAMES,
  PdfPreviewError,
} from "@myoxus/ui-facade";
import { debounce } from "lodash-es";
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";

import { cacheBitmap, getReusableBitmap } from "../cache/bitmap-cache";
import type { PDF } from "../entities/pdf";
import type { PDFPage } from "../entities/pdf-page";
import type { ScreenAnnotation, TextItem, TextLayerContent } from "../renderer";
import type { PageSize } from "../renderer/types";
import { LoadingSvg, PDFPageCanvas } from "./components";

interface PDFPageProps {
  pdf: PDF;
  pageNum: number;
  actualSize: PageSize;
  maxSize: PageSize;
  viewportInfo: PageSize;
  resize: (
    viewportInfo: PageSize,
    actualSize: PageSize,
    maxSize: PageSize,
    isThumbnail?: boolean,
  ) => { aspectRatio: number } & PageSize;
  scale?: number;
  className?: string;
  onSelect?: (pageNum: number) => void;
  isThumbnail?: boolean;
  searchQuery?: string;
  caseSensitive?: boolean;
  currentMatchItemIndex?: number;
}

function usePDFPage({
  pdf,
  pageNum,
  width,
  height,
  scale,
  visibility,
}: {
  pdf: PDF;
  pageNum: number;
  width: number;
  height: number;
  scale: number;
  visibility: boolean;
}) {
  const [page, setPage] = useState<PDFPage | null>(null);
  const [cachedBitmap, setCachedBitmap] = useState<ImageBitmap | null>(null);
  const img = useLiveData(useMemo(() => (page ? page.bitmap$ : null), [page]));
  const error = useLiveData(page?.error$ ?? null);
  const textContent = useLiveData(
    useMemo(() => (page ? page.textContent$ : null), [page]),
  );
  const annotations = useLiveData(
    useMemo(() => (page ? page.annotations$ : null), [page]),
  );

  useEffect(() => {
    if (!visibility || width <= 0 || height <= 0) {
      setPage(null);
      return;
    }

    let active = true;
    let releasePage: (() => void) | undefined;

    const load = async () => {
      try {
        const compressed = await getReusableBitmap({
          blobId: pdf.id,
          pageNum,
          width,
          height,
          scale,
        });

        if (!active) return;

        if (compressed) {
          setCachedBitmap(compressed);
          setPage(null);
        } else {
          setCachedBitmap(null);

          const key = `${width}:${height}:${scale}`;
          const { page: newPage, release } = pdf.page(pageNum, key);
          releasePage = release;

          setPage(newPage);
          newPage.render({ width, height, scale });
          newPage.requestTextContent({ width, height, scale });
          newPage.requestAnnotations({ width, height, scale });
        }
      } catch (e) {
        console.error("Failed to load PDF page", e);
      }
    };

    load().catch(console.error);

    return () => {
      active = false;
      releasePage?.();
      setPage(null);
    };
  }, [visibility, pdf, pageNum, width, height, scale]);

  useEffect(() => {
    if (!img || !page) return;

    cacheBitmap({ blobId: pdf.id, pageNum, width, height, scale }, img).catch(
      (e) => console.error("Failed to cache bitmap", e),
    );
  }, [img, page, pdf.id, pageNum, width, height, scale]);

  return { displayImg: cachedBitmap ?? img, error, textContent, annotations };
}

export const PDFPageRenderer = ({
  pdf,
  pageNum,
  className,
  actualSize,
  maxSize,
  viewportInfo,
  onSelect,
  resize,
  isThumbnail,
  scale = window.devicePixelRatio,
  searchQuery,
  caseSensitive,
  currentMatchItemIndex,
}: PDFPageProps) => {
  const t = useI18n();
  const pageViewRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useMemo(
    () => resize(viewportInfo, actualSize, maxSize, isThumbnail),
    [resize, viewportInfo, actualSize, maxSize, isThumbnail],
  );
  const [visibility, setVisibility] = useState(false);

  const { displayImg, error, textContent, annotations } = usePDFPage({
    pdf,
    pageNum,
    width: size.width,
    height: size.height,
    scale,
    visibility,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!displayImg) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = displayImg.width;
    canvas.height = displayImg.height;
    ctx.drawImage(displayImg, 0, 0);
  }, [displayImg]);

  useEffect(() => {
    const pageView = pageViewRef.current;
    if (!pageView) return;

    return observeIntersection(
      pageView,
      debounce(
        (entry) => {
          setVisibility(entry.isIntersecting);
        },
        377,
        { trailing: true },
      ),
    );
  }, []);

  return (
    <div
      ref={pageViewRef}
      className={className}
      style={resize?.(viewportInfo, actualSize, maxSize, isThumbnail)}
      onClick={() => onSelect?.(pageNum)}
    >
      <PageRendererInner
        img={displayImg}
        ref={canvasRef}
        err={error ? t["com.myoxus.pdf.page.render.error"]() : null}
        scale={scale}
        textContent={isThumbnail ? null : textContent}
        annotations={isThumbnail ? null : annotations}
        cssWidth={size.width}
        cssHeight={size.height}
        searchQuery={searchQuery}
        caseSensitive={caseSensitive}
        currentMatchItemIndex={currentMatchItemIndex}
      />
    </div>
  );
};

interface PageRendererInnerProps {
  img: ImageBitmap | null;
  err: string | null;
  scale: number;
  textContent: TextLayerContent | null;
  annotations: ScreenAnnotation[] | null;
  cssWidth: number;
  cssHeight: number;
  searchQuery?: string;
  caseSensitive?: boolean;
  currentMatchItemIndex?: number;
}

const PageRendererInner = forwardRef<HTMLCanvasElement, PageRendererInnerProps>(
  (
    {
      img,
      err,
      scale,
      textContent,
      annotations,
      cssWidth,
      cssHeight,
      searchQuery,
      caseSensitive,
      currentMatchItemIndex,
    },
    ref,
  ) => {
    if (err) {
      return (
        <PdfPreviewError data-myoxus-ui-role="pdf-preview-page-error">
          {err}
        </PdfPreviewError>
      );
    }

    if (!img) {
      return <LoadingSvg />;
    }

    const { width, height } = img;

    return (
      <div
        className={PDF_PREVIEW_CLASS_NAMES.rendererPage}
        style={{ width: width / scale, height: height / scale }}
      >
        <PDFPageCanvas
          ref={ref}
          style={{
            height: height / scale,
            aspectRatio: `${width} / ${height}`,
          }}
        />
        {textContent && (
          <TextLayer
            content={textContent}
            scale={scale}
            cssWidth={cssWidth}
            cssHeight={cssHeight}
            searchQuery={searchQuery}
            caseSensitive={caseSensitive}
            currentMatchItemIndex={currentMatchItemIndex}
          />
        )}
        {annotations && annotations.length > 0 && (
          <AnnotationLayer
            annotations={annotations}
            cssWidth={cssWidth}
            cssHeight={cssHeight}
          />
        )}
      </div>
    );
  },
);

PageRendererInner.displayName = "pdf-page-renderer-inner";

function TextLayer({
  content,
  scale,
  cssWidth,
  cssHeight,
  searchQuery,
  caseSensitive,
  currentMatchItemIndex,
}: {
  content: TextLayerContent;
  scale: number;
  cssWidth: number;
  cssHeight: number;
  searchQuery?: string;
  caseSensitive?: boolean;
  currentMatchItemIndex?: number;
}) {
  const query = caseSensitive
    ? (searchQuery ?? "")
    : (searchQuery?.toLowerCase() ?? "");

  return (
    <div
      className={PDF_PREVIEW_CLASS_NAMES.textLayer}
      style={{ width: cssWidth, height: cssHeight }}
    >
      {content.items.map((item: TextItem, i: number) => {
        const cssX = item.x / scale;
        const cssY = item.y / scale;
        const cssW = item.width / scale;
        const cssH = item.height / scale;

        let highlightClass: string | undefined;
        if (i === currentMatchItemIndex) {
          highlightClass = PDF_PREVIEW_CLASS_NAMES.textCurrentMatch;
        } else if (query) {
          const hay = caseSensitive ? item.str : item.str.toLowerCase();
          if (hay.includes(query)) {
            highlightClass = PDF_PREVIEW_CLASS_NAMES.textHighlight;
          }
        }

        return (
          <span
            key={i}
            className={highlightClass}
            style={{
              left: cssX,
              top: cssY,
              width: cssW,
              height: cssH,
              fontSize: cssH,
            }}
          >
            {item.str}
          </span>
        );
      })}
    </div>
  );
}

function AnnotationLayer({
  annotations,
  cssWidth,
  cssHeight,
}: {
  annotations: ScreenAnnotation[];
  cssWidth: number;
  cssHeight: number;
}) {
  return (
    <div
      className={PDF_PREVIEW_CLASS_NAMES.annotationLayer}
      style={{ width: cssWidth, height: cssHeight }}
    >
      {annotations.map((annot, i) => (
        <a
          key={i}
          href={annot.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            left: annot.x,
            top: annot.y,
            width: annot.width,
            height: annot.height,
          }}
          aria-label={annot.url}
        />
      ))}
    </div>
  );
}
