import {
  PdfPreviewCanvas,
  PdfPreviewNotice,
  PdfPreviewShell,
  PdfPreviewSkeleton,
  PdfPreviewViewport,
} from "@myoxus/ui-facade";
import { getPdfResourceOptions } from "@myoxus/env/worker";
import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import { useCallback, useEffect, useRef, useState } from "react";

type ThumbnailState = "idle" | "loading" | "ready" | "failed";

export type LoadPdfTemplatePreview = () => Promise<string | null>;

function decodeBase64Pdf(pdfBase64: string): Uint8Array {
  const binary = atob(pdfBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function PdfTemplatePreviewThumbnail({
  templateId,
  templateName,
  loadPreviewPdf,
}: {
  templateId: string;
  templateName: string;
  loadPreviewPdf?: LoadPdfTemplatePreview;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const requestedRef = useRef(false);
  const [state, setState] = useState<ThumbnailState>("idle");
  const [pdfBase64, setPdfBase64] = useState<string | null>(null);

  const requestPreview = useCallback(() => {
    if (!loadPreviewPdf || requestedRef.current) return;
    requestedRef.current = true;
    setState("loading");
    void loadPreviewPdf()
      .then((next) => {
        if (next) setPdfBase64(next);
        else setState("failed");
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("pdf export template thumbnail load failed", {
          templateId,
          message,
        });
        setState("failed");
      });
  }, [loadPreviewPdf, templateId]);

  useEffect(() => {
    if (!pdfBase64) return;
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;

    async function renderThumbnail() {
      setState("loading");
      try {
        const pdfjs = await import("pdfjs-dist");
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        loadingTask = pdfjs.getDocument({
          ...getPdfResourceOptions(pdfjs.version),
          data: decodeBase64Pdf(pdfBase64 as string),
        });
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 0.28 });
        if (cancelled) return;

        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) {
          throw new Error("Canvas 2D context is unavailable");
        }

        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport }).promise;
        await loadingTask.destroy();
        loadingTask = undefined;
        if (!cancelled) setState("ready");
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.warn("pdf export template thumbnail render failed", {
          templateId,
          message,
        });
        if (!cancelled) setState("failed");
      }
    }

    void renderThumbnail();
    return () => {
      cancelled = true;
      void loadingTask?.destroy();
    };
  }, [pdfBase64, templateId]);

  return (
    <PdfPreviewShell
      aria-hidden="true"
      data-testid={`pdf-template-thumbnail-${templateId}`}
      onFocus={requestPreview}
      onPointerEnter={requestPreview}
      variant="thumbnail"
    >
      {state === "loading" ? <PdfPreviewSkeleton variant="thumbnail" /> : null}
      <PdfPreviewViewport variant="thumbnail">
        <PdfPreviewCanvas
          ref={canvasRef}
          data-render-state={state === "ready" ? "ready" : "hidden"}
          variant="thumbnail"
        />
      </PdfPreviewViewport>
      {state === "failed" ? (
        <PdfPreviewNotice variant="thumbnail">{templateName}</PdfPreviewNotice>
      ) : null}
    </PdfPreviewShell>
  );
}
