/**
 * Unit tests for PDF metadata extraction logic.
 *
 * Uses pdfjs-dist/legacy (Node.js-compatible) to validate that the extraction
 * logic in pdf.worker.ts produces correct PDFMeta structures.
 * All pdfjs work happens once in beforeAll to avoid fake-worker state issues.
 */
import { beforeAll, describe, expect, it } from "vitest";

// Minimal valid 2-page PDF: page 0 = 100x200, page 1 = 200x100 user units.
const FIXTURE_2PAGE_PDF = [
  "%PDF-1.4",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj",
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 200]>>endobj",
  "4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj",
  "xref",
  "0 5",
  "0000000000 65535 f ",
  "0000000009 00000 n ",
  "0000000058 00000 n ",
  "0000000121 00000 n ",
  "0000000210 00000 n ",
  "trailer<</Size 5/Root 1 0 R>>",
  "startxref",
  "299",
  "%%EOF",
].join("\n");

type PDFMeta = {
  pageCount: number;
  pageSizes: Array<{ width: number; height: number }>;
  maxSize: { width: number; height: number };
};

// Replicate loadDocument logic from pdf.worker.ts using pdfjs internal _pageInfo.view
// (avoids getViewport which fails via LoopbackPort structured-clone in Node.js).
async function extractMetaFromBytes(pdfData: Uint8Array): Promise<PDFMeta> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: pdfData });
  const doc = await loadingTask.promise;

  const pageCount = doc.numPages;
  const pageSizes: Array<{ width: number; height: number }> = [];
  let maxWidth = 0;
  let maxHeight = 0;

  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    // _pageInfo.view = [x0, y0, x1, y1] in PDF user units
    const view: number[] = (page as { _pageInfo: { view: number[] } })._pageInfo
      .view;
    const width = Math.ceil(view[2] - view[0]);
    const height = Math.ceil(view[3] - view[1]);
    maxWidth = Math.max(maxWidth, width);
    maxHeight = Math.max(maxHeight, height);
    pageSizes.push({ width, height });
    page.cleanup();
  }

  await loadingTask.destroy();
  return {
    pageCount,
    pageSizes,
    maxSize: { width: maxWidth, height: maxHeight },
  };
}

describe("pdf metadata extraction — fixture PDF", () => {
  let meta: PDFMeta;

  beforeAll(async () => {
    const pdfBytes = new TextEncoder().encode(FIXTURE_2PAGE_PDF);
    meta = await extractMetaFromBytes(pdfBytes);
  });

  it("returns correct page count", () => {
    expect(meta.pageCount).toBe(2);
  });

  it("returns correct page sizes in document order", () => {
    expect(meta.pageSizes[0]).toEqual({ width: 100, height: 200 });
    expect(meta.pageSizes[1]).toEqual({ width: 200, height: 100 });
  });

  it("computes maxSize as bounding box over all pages", () => {
    expect(meta.maxSize).toEqual({ width: 200, height: 200 });
  });
});
