import type {
  EventSourceService,
  GraphQLService,
  FetchService,
} from "@myoxus/core/modules/server";
import {
  exportPdfMutation,
  type PdfExportInputV2Input,
  pdfExportJobQuery,
} from "@myoxus/graphql";

import { saveServerPdf, pdfFilename } from "./save-server-pdf";
import { dispatchPdfExportCompleted } from "./events";

/** Result of a successful server-side PDF export. */
export interface ServerPdfExportResult {
  /** Body font families the renderer could not honour. Empty for the common
   *  case; non-empty triggers a non-blocking fallback warning. */
  unmappedFontFamilies: string[];
  /** False when the native chooser was cancelled. */
  saved: boolean;
}

export type PdfExportJobPhase =
  "queued" | "rendering" | "validating" | "done" | "failed";

export interface ServerPdfExportProgress {
  jobId: string;
  status: string;
  phase: PdfExportJobPhase;
  downloadUrl: string | null;
  errorClass: string | null;
  errorDetail: string | null;
  pageCount: number | null;
  unmappedFontFamilies: string[];
}

export interface ServerPdfExportOptions {
  fetchService: Pick<FetchService, "fetch">;
  templateId?: string;
  locale?: string;
  paperSize?: string;
  orientation?: string;
  imageQuality?: string;
  /** Omission uses new server admission defaults; explicit saved choices pass through. */
  complianceProfile?: string;
  coverPage?: boolean;
  tocBehavior?: string;
  footerStyle?: string;
  pageNumbering?: string;
  colorVariant?: string;

  confidentialityLabel?: string;
  documentVersionId?: string;
  typedInputs?: unknown;
  eventSourceService?: Pick<EventSourceService, "eventSource">;
  onProgress?: (progress: ServerPdfExportProgress) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sseMaxRetries?: number;
}

type PdfExportJobWire = {
  id?: string;
  jobId?: string;
  job_id?: string;
  status: string;
  phase?: PdfExportJobPhase;
  downloadUrl?: string | null;
  download_url?: string | null;
  errorClass?: string | null;
  error_class?: string | null;
  errorDetail?: string | null;
  error_detail?: string | null;
  pageCount?: number | null;
  page_count?: number | null;
  unmappedFontFamilies?: string[];
  unmapped_font_families?: string[];
};

function normalisePdfExportProgress(
  jobId: string,
  job: PdfExportJobWire,
): ServerPdfExportProgress {
  const status = job.status;
  const phase =
    job.phase ??
    (status === "running"
      ? "rendering"
      : status === "done" || status === "failed" || status === "queued"
        ? status
        : "queued");
  return {
    jobId: job.jobId ?? job.job_id ?? job.id ?? jobId,
    status,
    phase,
    downloadUrl: job.downloadUrl ?? job.download_url ?? null,
    errorClass: job.errorClass ?? job.error_class ?? null,
    errorDetail: job.errorDetail ?? job.error_detail ?? null,
    pageCount: job.pageCount ?? job.page_count ?? null,
    unmappedFontFamilies:
      job.unmappedFontFamilies ?? job.unmapped_font_families ?? [],
  };
}

async function pollPdfExportJobUntilTerminal(
  jobId: string,
  graphqlService: GraphQLService,
  options: ServerPdfExportOptions,
): Promise<ServerPdfExportProgress> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const pollIntervalMs = options.pollIntervalMs ?? 2000;

  for (;;) {
    if (Date.now() > deadline) {
      throw Object.assign(new Error("timeout"), { errorClass: "Timeout" });
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const pollResult = await graphqlService.gql({
      query: pdfExportJobQuery,
      variables: { jobId },
    });
    const progress = normalisePdfExportProgress(jobId, pollResult.pdfExportJob);
    options.onProgress?.(progress);
    if (progress.status !== "queued" && progress.status !== "running") {
      return progress;
    }
  }
}

async function waitForPdfExportSseTerminal(
  jobId: string,
  options: ServerPdfExportOptions,
): Promise<ServerPdfExportProgress | null> {
  const eventSourceService = options.eventSourceService;
  if (!eventSourceService) {
    return null;
  }

  return await new Promise((resolve, reject) => {
    const maxRetries = options.sseMaxRetries ?? 3;
    let retries = 0;
    let source: EventSource | null = null;
    let settled = false;
    const timeoutMs = options.timeoutMs ?? 60_000;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const settle = (value: ServerPdfExportProgress | null) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      source?.close();
      resolve(value);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      source?.close();
      reject(error);
    };

    timeoutHandle =
      timeoutMs > 0
        ? setTimeout(() => {
            fail(
              Object.assign(new Error("timeout"), { errorClass: "Timeout" }),
            );
          }, timeoutMs)
        : null;

    const connect = () => {
      source?.close();
      source = eventSourceService.eventSource(
        `/api/pdf-export/${jobId}/events`,
        { withCredentials: true },
      );

      const handlePayload = (event: MessageEvent) => {
        let progress: ServerPdfExportProgress;
        try {
          progress = normalisePdfExportProgress(jobId, JSON.parse(event.data));
        } catch (error) {
          fail(error);
          return;
        }
        options.onProgress?.(progress);
        if (progress.phase === "done" || progress.status === "done") {
          settle(progress);
        } else if (
          progress.phase === "failed" ||
          progress.status === "failed"
        ) {
          fail(
            Object.assign(new Error("pdf export failed"), {
              jobId: progress.jobId,
              errorClass: progress.errorClass,
              errorDetail: progress.errorDetail,
            }),
          );
        }
      };

      source.addEventListener("update", handlePayload);
      source.addEventListener("done", handlePayload);
      source.addEventListener("failed", handlePayload);
      source.onerror = () => {
        source?.close();
        if (retries >= maxRetries) {
          settle(null);
          return;
        }
        retries += 1;
        setTimeout(connect, Math.min(250 * 2 ** retries, 2000));
      };
    };

    connect();
  });
}

function buildPdfExportInput(
  workspaceId: string,
  docId: string,
  options: ServerPdfExportOptions,
): PdfExportInputV2Input {
  const input: PdfExportInputV2Input = {
    workspaceId,
    docId,
    templateId: options.templateId ?? "default",
  };

  if (options.locale !== undefined) input.locale = options.locale;
  if (options.paperSize !== undefined) input.paperSize = options.paperSize;
  if (options.orientation !== undefined)
    input.orientation = options.orientation;
  if (options.imageQuality !== undefined) {
    input.imageQuality = options.imageQuality;
  }
  if (options.complianceProfile !== undefined) {
    input.complianceProfile = options.complianceProfile;
  }
  if (options.coverPage !== undefined) input.coverPage = options.coverPage;
  if (options.tocBehavior !== undefined) {
    input.tocBehavior = options.tocBehavior;
  }
  if (options.footerStyle !== undefined)
    input.footerStyle = options.footerStyle;
  if (options.pageNumbering !== undefined)
    input.pageNumbering = options.pageNumbering;
  if (options.colorVariant !== undefined)
    input.colorVariant = options.colorVariant;
  if (options.confidentialityLabel !== undefined) {
    input.confidentialityLabel = options.confidentialityLabel;
  }
  if (options.documentVersionId !== undefined) {
    input.documentVersionId = options.documentVersionId;
  }
  if (options.typedInputs !== undefined)
    input.typedInputs = options.typedInputs;

  return input;
}

/** Stream or poll for job completion, then download. Throws on failure or timeout. */
export async function runServerPdfExport(
  workspaceId: string,
  docId: string,
  docTitle: string,
  graphqlService: GraphQLService,
  options: ServerPdfExportOptions,
): Promise<ServerPdfExportResult> {
  // 1. Create the export job through the canonical V2 PDF-export API.
  const startResult = await graphqlService.gql({
    query: exportPdfMutation,
    variables: { input: buildPdfExportInput(workspaceId, docId, options) },
  });
  const jobId = startResult.exportPdf.id;

  let progress = normalisePdfExportProgress(jobId, startResult.exportPdf);
  options.onProgress?.(progress);

  // 2. Prefer the job-specific SSE stream. Polling stays as fallback when the
  // browser lacks EventSource, the stream disconnects repeatedly, or tests pass
  // no EventSourceService.
  if (progress.status === "queued" || progress.status === "running") {
    progress =
      (await waitForPdfExportSseTerminal(jobId, options)) ??
      (await pollPdfExportJobUntilTerminal(jobId, graphqlService, options));
  }

  if (progress.status !== "done") {
    throw Object.assign(new Error("pdf export failed"), {
      jobId: progress.jobId,
      errorClass: progress.errorClass,
      errorDetail: progress.errorDetail,
    });
  }

  // 3. Download the PDF.
  const url = progress.downloadUrl ?? `/api/pdf-export/${jobId}/download`;
  const saved = await saveServerPdf(
    options.fetchService,
    url,
    pdfFilename(docTitle, new Date().toISOString(), options.documentVersionId),
  );
  dispatchPdfExportCompleted({
    workspaceId,
    docId,
    jobId: progress.jobId,
    downloadUrl: url,
  });

  return { unmappedFontFamilies: progress.unmappedFontFamilies, saved };
}
