/**
 * @vitest-environment happy-dom
 */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createPdfExportSupportDetails,
  formatPdfExportErrorTitle,
  getPdfExportErrorDescriptor,
  PdfExportErrorDisplay,
} from "../error-display";

describe("PDF export error display", () => {
  afterEach(cleanup);

  test("maps server error codes to stable descriptors and fallback titles", () => {
    expect(getPdfExportErrorDescriptor({ code: "MissingFont" }).titleKey).toBe(
      "com.myoxus.pdf-export.error.missing-font",
    );
    expect(
      getPdfExportErrorDescriptor({ code: "TemplateCompileFailed" }).titleKey,
    ).toBe("com.myoxus.pdf-export.error.template-compile-failed");
    expect(getPdfExportErrorDescriptor({ code: "UnknownFuture" }).code).toBe(
      "Unknown",
    );
    expect(formatPdfExportErrorTitle({ code: "Timeout" })).toContain(
      "timed out",
    );
  });

  test("formats support details without dropping job id or error code", () => {
    const details = createPdfExportSupportDetails({
      code: "TemplateCompileFailed",
      jobId: "job-123",
      file: "main.typ",
      line: 42,
      stackTrace: "typst stack",
    });

    expect(details).toContain("job_id: job-123");
    expect(details).toContain("error_code: TemplateCompileFailed");
    expect(details).toContain("file: main.typ");
  });

  test("renders recovery details with the real facade components", () => {
    const onCopy = vi.fn();
    render(
      <MyoxusUIProvider>
        <PdfExportErrorDisplay
          error={{ code: "MissingFont", jobId: "job-9", fontFamily: "Lato" }}
          onCopyDetails={onCopy}
        />
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("pdf-export-error").tagName).toBe("SECTION");
    expect(screen.getByText("Required font is missing: Lato").textContent).toBe(
      "Required font is missing: Lato",
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    expect(onCopy).toHaveBeenCalledWith(
      expect.stringContaining("job_id: job-9"),
    );
  });
});
