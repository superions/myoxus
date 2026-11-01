import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Button,
  MyoxusText,
  TerminalPanel,
} from "@myoxus/ui-facade";
import type { ReactElement } from "react";

export type PdfExportErrorCode =
  | "CapabilityViolation"
  | "MissingFont"
  | "TemplateCompileFailed"
  | "LinkValidationFailed"
  | "Timeout"
  | "OomKilled"
  | "PdfaValidationFailed"
  | "PdfuaValidationFailed"
  | "UnsupportedComplianceProfile"
  | "Unknown";

export interface PdfExportRenderError {
  code: PdfExportErrorCode | string;
  jobId?: string;
  message?: string;
  fontFamily?: string;
  file?: string;
  line?: number;
  url?: string;
  detail?: string;
  stackTrace?: string;
}

export interface PdfExportErrorDescriptor {
  code: PdfExportErrorCode;
  titleKey: string;
  recoveryKey: string;
  titleFallback: string;
  recoveryFallback: string;
}

const DESCRIPTORS: Record<PdfExportErrorCode, PdfExportErrorDescriptor> = {
  CapabilityViolation: {
    code: "CapabilityViolation",
    titleKey: "com.myoxus.pdf-export.dialog.validation.summary",
    recoveryKey: "com.myoxus.pdf-export.error.capability-violation.recovery",
    titleFallback: "Review export inputs",
    recoveryFallback:
      "Return to export inputs, correct the reported values, and try again.",
  },
  MissingFont: {
    code: "MissingFont",
    titleKey: "com.myoxus.pdf-export.error.missing-font",
    recoveryKey: "com.myoxus.pdf-export.error.missing-font.recovery",
    titleFallback: "Required font is missing: {font_family}",
    recoveryFallback:
      "Choose another template or ask an admin to approve the required font.",
  },
  TemplateCompileFailed: {
    code: "TemplateCompileFailed",
    titleKey: "com.myoxus.pdf-export.error.template-compile-failed",
    recoveryKey: "com.myoxus.pdf-export.error.template-compile-failed.recovery",
    titleFallback: "Template error in {file}:{line}",
    recoveryFallback:
      "Try a different template and send the details to template maintainers.",
  },
  LinkValidationFailed: {
    code: "LinkValidationFailed",
    titleKey: "com.myoxus.pdf-export.error.link-validation-failed",
    recoveryKey: "com.myoxus.pdf-export.error.link-validation-failed.recovery",
    titleFallback: "Invalid link: {url}",
    recoveryFallback:
      "Fix or remove the invalid link, then start the export again.",
  },
  Timeout: {
    code: "Timeout",
    titleKey: "com.myoxus.pdf-export.error.timeout",
    recoveryKey: "com.myoxus.pdf-export.error.timeout.recovery",
    titleFallback: "Render timed out; the document may be too large.",
    recoveryFallback:
      "Reduce image quality, split the document, or retry with a simpler template.",
  },
  OomKilled: {
    code: "OomKilled",
    titleKey: "com.myoxus.pdf-export.error.oom-killed",
    recoveryKey: "com.myoxus.pdf-export.error.oom-killed.recovery",
    titleFallback: "Renderer ran out of memory; the document may be too large.",
    recoveryFallback:
      "Reduce large images or export the document in smaller parts.",
  },
  PdfaValidationFailed: {
    code: "PdfaValidationFailed",
    titleKey: "com.myoxus.pdf-export.error.pdfa-validation-failed",
    recoveryKey: "com.myoxus.pdf-export.error.pdfa-validation-failed.recovery",
    titleFallback: "PDF/A validation failed: {detail}",
    recoveryFallback:
      "Disable PDF/A for this export or fix the reported validation issue.",
  },
  PdfuaValidationFailed: {
    code: "PdfuaValidationFailed",
    titleKey: "com.myoxus.pdf-export.error.pdfua-validation-failed",
    recoveryKey: "com.myoxus.pdf-export.error.pdfua-validation-failed.recovery",
    titleFallback: "PDF/UA validation failed: {detail}",
    recoveryFallback:
      "Disable PDF/UA for this export or fix the reported accessibility issue.",
  },
  UnsupportedComplianceProfile: {
    code: "UnsupportedComplianceProfile",
    titleKey: "com.myoxus.pdf-export.error.unsupported-compliance-profile",
    recoveryKey:
      "com.myoxus.pdf-export.error.unsupported-compliance-profile.recovery",
    titleFallback: "This PDF compliance profile is not available.",
    recoveryFallback:
      "Choose Standard, PDF/A, or PDF/UA and start the export again.",
  },
  Unknown: {
    code: "Unknown",
    titleKey: "com.myoxus.pdf-export.error.unknown",
    recoveryKey: "com.myoxus.pdf-export.error.unknown.recovery",
    titleFallback: "PDF export failed.",
    recoveryFallback: "Copy the details and send them to support.",
  },
};

export function normalizePdfExportErrorCode(code: string): PdfExportErrorCode {
  return code in DESCRIPTORS ? (code as PdfExportErrorCode) : "Unknown";
}

export function getPdfExportErrorDescriptor(
  error: Pick<PdfExportRenderError, "code">,
): PdfExportErrorDescriptor {
  return DESCRIPTORS[normalizePdfExportErrorCode(error.code)];
}

function interpolate(template: string, error: PdfExportRenderError): string {
  return template
    .replace("{font_family}", error.fontFamily ?? "unknown")
    .replace("{file}", error.file ?? "unknown")
    .replace("{line}", error.line == null ? "?" : String(error.line))
    .replace("{url}", error.url ?? "unknown")
    .replace("{detail}", error.detail ?? error.message ?? "unknown");
}

function translationParams(error: PdfExportRenderError) {
  return {
    fontFamily: error.fontFamily ?? "unknown",
    file: error.file ?? "unknown",
    line: error.line == null ? "?" : String(error.line),
    url: error.url ?? "unknown",
    detail: error.detail ?? error.message ?? "unknown",
  };
}

export function formatPdfExportErrorTitle(error: PdfExportRenderError): string {
  return interpolate(getPdfExportErrorDescriptor(error).titleFallback, error);
}

export function formatPdfExportRecovery(error: PdfExportRenderError): string {
  return interpolate(
    getPdfExportErrorDescriptor(error).recoveryFallback,
    error,
  );
}

export function createPdfExportSupportDetails(
  error: PdfExportRenderError,
): string {
  const entries: Array<[string, string | undefined]> = [
    ["job_id", error.jobId],
    ["error_code", error.code],
    ["message", error.message],
    ["font_family", error.fontFamily],
    ["file", error.file],
    ["line", error.line == null ? undefined : String(error.line)],
    ["url", error.url],
    ["detail", error.detail],
    ["stack_trace", error.stackTrace],
  ];
  return entries
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

export function PdfExportErrorDisplay({
  error,
  onCopyDetails,
}: {
  error: PdfExportRenderError;
  onCopyDetails?: (details: string) => void;
}): ReactElement {
  const t = useI18n();
  const descriptor = getPdfExportErrorDescriptor(error);
  const details = createPdfExportSupportDetails(error);

  return (
    <section
      aria-label={t.t("com.myoxus.pdf-export.error.aria-label")}
      data-testid="pdf-export-error"
    >
      <MyoxusText
        component="p"
        data-i18n-key={descriptor.titleKey}
        tone="primary"
        typographySlot="body-small"
      >
        {t.t(descriptor.titleKey, translationParams(error))}
      </MyoxusText>
      <MyoxusText
        component="p"
        data-i18n-key={descriptor.recoveryKey}
        tone="secondary"
        typographySlot="body-small"
      >
        {t.t(descriptor.recoveryKey, translationParams(error))}
      </MyoxusText>
      {descriptor.code === "CapabilityViolation" && error.message ? (
        <MyoxusText component="p">{error.message}</MyoxusText>
      ) : null}
      {details ? (
        <Accordion>
          <AccordionItem value="details">
            <AccordionControl>
              {t.t("com.myoxus.common.technical-details")}
            </AccordionControl>
            <AccordionPanel>
              <TerminalPanel data-myoxus-ui-role="pdf-export-error-details">
                {details}
              </TerminalPanel>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      ) : null}
      {onCopyDetails ? (
        <Button
          data-myoxus-ui-role="button:compact"
          type="button"
          onClick={() => onCopyDetails(details)}
          variant="secondary"
        >
          {t.t("com.myoxus.pdf-export.error.copy-details")}
        </Button>
      ) : null}
    </section>
  );
}
