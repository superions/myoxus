import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

const workerSource = readFileSync(
  new URL("../modules/pdf/renderer/pdf.worker.ts", import.meta.url),
  "utf8",
);

describe("PDF renderer worker runtime contract", () => {
  test("registers the pdfjs in-thread backend instead of an unresolved nested worker", () => {
    expect(workerSource).toContain(
      'import { WorkerMessageHandler } from "pdfjs-dist/build/pdf.worker.mjs"',
    );
    expect(workerSource).toContain(".pdfjsWorker = { WorkerMessageHandler }");
    expect(workerSource).not.toContain("GlobalWorkerOptions.workerSrc");
    expect(workerSource).toContain("disableFontFace: true");
    expect(workerSource).toContain("useSystemFonts: false");
  });
});
