// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRegionalFormatters } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { FetchService, type GraphQLService } from "@myoxus/core/modules/server";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import {
  Badge,
  Button,
  Group,
  MyoxusText,
  notify,
  SettingsNotice,
  Stack,
  SurfaceList,
  SurfaceListCardHeader,
  SurfaceListItem,
  SurfaceListMeta,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { saveServerPdf, pdfFilename } from "./save-server-pdf";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  isPdfExportCompletedEvent,
  PDF_EXPORT_COMPLETED_EVENT,
} from "./events";
import {
  loadPdfExportDialogBootstrap,
  openPdfExportDialog,
  requireAssignedPdfTemplate,
} from "./export-dialog";
import {
  documentPdfExportHistoryQuery,
  type PdfExportDialogFormValue,
  type PdfExportHistoryEntry,
  type PdfExportHistoryResponse,
} from "./types";

type GraphQLCallOptions = Parameters<GraphQLService["gql"]>[0];

function localHistoryQueryOptions(
  variables: Record<string, unknown>,
): GraphQLCallOptions {
  // Keep the module-local history operation's untyped boundary isolated from
  // the generated export dialog operations.
  return {
    query: documentPdfExportHistoryQuery,
    variables,
  } as unknown as GraphQLCallOptions;
}

export interface PdfExportHistoryPanelProps {
  workspaceId: string;
  docId: string;
  docTitle: string;
  graphqlService: GraphQLService;
  limit?: number;
}

function safePdfFilename(title: string, createdAt: string): string {
  return pdfFilename(title, createdAt);
}

function renderInputsToFormValue(
  inputs: Record<string, unknown>,
): PdfExportDialogFormValue {
  return {
    locale: typeof inputs.locale === "string" ? inputs.locale : undefined,
    paperSize:
      typeof inputs.paper_size === "string"
        ? inputs.paper_size
        : typeof inputs.paperSize === "string"
          ? inputs.paperSize
          : undefined,
    orientation:
      typeof inputs.orientation === "string" ? inputs.orientation : undefined,
    imageQuality:
      typeof inputs.image_quality === "string"
        ? inputs.image_quality
        : typeof inputs.imageQuality === "string"
          ? inputs.imageQuality
          : undefined,
    coverPage:
      typeof inputs.cover_page === "boolean"
        ? inputs.cover_page
        : typeof inputs.coverPage === "boolean"
          ? inputs.coverPage
          : undefined,
    tocBehavior:
      typeof inputs.toc_behavior === "string"
        ? inputs.toc_behavior
        : typeof inputs.tocBehavior === "string"
          ? inputs.tocBehavior
          : undefined,
    footerStyle:
      typeof inputs.footer_style === "string" ? inputs.footer_style : undefined,
    pageNumbering:
      typeof inputs.page_numbering === "string"
        ? inputs.page_numbering
        : undefined,
    colorVariant:
      typeof inputs.color_variant === "string"
        ? inputs.color_variant
        : undefined,
    confidentialityLabel:
      typeof inputs.confidentiality_label === "string"
        ? inputs.confidentiality_label
        : typeof inputs.confidentialityLabel === "string"
          ? inputs.confidentialityLabel
          : undefined,
    typedInputs:
      inputs.typed_inputs !== undefined
        ? inputs.typed_inputs
        : inputs.typedInputs,
  };
}

function templateLabel(
  entry: PdfExportHistoryEntry,
  defaultLabel = "Default",
): string {
  return entry.templateId === "default"
    ? defaultLabel
    : `${entry.templateId.slice(0, 8)}...`;
}

function statusLabel(status: string, t?: ReturnType<typeof useI18n>): string {
  switch (status) {
    case "queued":
      return t?.["com.myoxus.sidebar.pdf-exports.status.queued"]() ?? "Queued";
    case "running":
      return (
        t?.["com.myoxus.sidebar.pdf-exports.status.running"]() ?? "Rendering"
      );
    case "done":
      return t?.["com.myoxus.sidebar.pdf-exports.status.done"]() ?? "Done";
    case "failed":
      return t?.["com.myoxus.sidebar.pdf-exports.status.failed"]() ?? "Failed";
    default:
      return (
        status ||
        t?.["com.myoxus.sidebar.pdf-exports.status.unknown"]() ||
        "Unknown"
      );
  }
}

export function PdfExportHistoryPanel({
  workspaceId,
  docId,
  docTitle,
  graphqlService,
  limit = 20,
}: PdfExportHistoryPanelProps) {
  const t = useI18n();
  const workspaceDialogService = useService(WorkspaceDialogService);
  const fetchService = useService(FetchService);
  const { formatDateTime } = useRegionalFormatters();
  const normalizedDocId = docId.trim();
  const scope = useMemo(
    () => ({ workspaceId, docId: normalizedDocId, graphqlService, limit }),
    [workspaceId, normalizedDocId, graphqlService, limit],
  );
  const activeScope = useRef<typeof scope | null>(scope);
  activeScope.current = scope;
  const latestRequest = useRef(0);
  useEffect(() => {
    activeScope.current = scope;
    return () => {
      if (activeScope.current === scope) activeScope.current = null;
    };
  }, [scope]);
  const [readState, setReadState] = useState<{
    scope: typeof scope;
    entries: PdfExportHistoryEntry[];
    loading: boolean;
    error: string | null;
  }>({ scope, entries: [], loading: true, error: null });
  const entries = readState.scope === scope ? readState.entries : [];
  const loading = readState.scope !== scope || readState.loading;
  const error = readState.scope === scope ? readState.error : null;
  const [busy, setBusy] = useState<{
    scope: typeof scope;
    id: string | null;
  } | null>(null);
  const busyJobId = busy?.scope === scope ? busy.id : null;
  const setBusyJobId = (id: string | null) => {
    if (activeScope.current === scope) setBusy({ scope, id });
  };
  const setError = (message: string | null) => {
    if (activeScope.current === scope)
      setReadState((previous) => ({ ...previous, error: message }));
  };
  const loadFailedMessage =
    t["com.myoxus.sidebar.pdf-exports.error.load-failed"]();

  const load = useCallback(async () => {
    // Only the latest read in this mounted document/server scope may publish.
    // Disposal also fences callbacks retained by an old export dialog or event.
    if (activeScope.current !== scope) return;
    const request = ++latestRequest.current;
    const ownsRequest = () =>
      activeScope.current === scope && latestRequest.current === request;
    setReadState((previous) => ({
      scope,
      entries: previous.scope === scope ? previous.entries : [],
      loading: true,
      error: null,
    }));
    if (!normalizedDocId) {
      setReadState({ scope, entries: [], loading: false, error: null });
      console.warn("pdf export history load skipped: missing document id", {
        workspaceId,
      });
      return;
    }
    try {
      const data = (await graphqlService.gql(
        localHistoryQueryOptions({
          workspaceId,
          docId: normalizedDocId,
          limit,
        }),
      )) as unknown as PdfExportHistoryResponse;
      if (!ownsRequest()) return;
      setReadState((previous) => ({
        scope,
        entries: data.documentPdfExportHistory ?? [],
        loading: false,
        // A download/export may fail while this read is in flight.
        error: previous.scope === scope ? previous.error : null,
      }));
      console.info("pdf export history loaded", {
        docId: normalizedDocId,
        rows: data.documentPdfExportHistory?.length ?? 0,
      });
    } catch (err) {
      if (!ownsRequest()) return;
      const message = err instanceof Error ? err.message : loadFailedMessage;
      console.warn("pdf export history load failed", {
        docId: normalizedDocId,
        error: err,
      });
      setReadState((previous) => ({ ...previous, error: message }));
    } finally {
      if (ownsRequest())
        setReadState((previous) => ({ ...previous, loading: false }));
    }
  }, [
    graphqlService,
    limit,
    loadFailedMessage,
    normalizedDocId,
    workspaceId,
    scope,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const reloadAfterExport = (event: Event) => {
      if (!isPdfExportCompletedEvent(event)) return;
      if (
        event.detail.workspaceId !== workspaceId ||
        event.detail.docId !== normalizedDocId
      ) {
        return;
      }
      void load();
    };
    window.addEventListener(PDF_EXPORT_COMPLETED_EVENT, reloadAfterExport);
    return () => {
      window.removeEventListener(PDF_EXPORT_COMPLETED_EVENT, reloadAfterExport);
    };
  }, [load, normalizedDocId, workspaceId]);

  const hasEntries = entries.length > 0;
  const showRefreshAction = hasEntries || Boolean(error);
  const confirmedEmpty = !loading && !!normalizedDocId && !error && !hasEntries;

  const redownload = async (entry: PdfExportHistoryEntry) => {
    if (!entry.downloadUrl) return;
    setBusyJobId(entry.id);
    setError(null);
    try {
      console.info("pdf export history redownload started", {
        jobId: entry.id,
        docId: normalizedDocId,
      });
      const saved = await saveServerPdf(
        fetchService,
        entry.downloadUrl,
        safePdfFilename(docTitle, entry.createdAt),
      );
      if (saved)
        notify.success({ title: t["com.myoxus.export.pdf.success"]() });
    } catch (err) {
      const message =
        t["com.myoxus.sidebar.pdf-exports.error.download-failed"]();
      console.warn("pdf export history redownload failed", {
        jobId: entry.id,
        error: err,
      });
      setError(message);
    } finally {
      setBusyJobId(null);
    }
  };

  const reexport = async (
    entry: PdfExportHistoryEntry,
    trigger: HTMLButtonElement,
  ) => {
    setBusyJobId(entry.id);
    setError(null);
    try {
      console.info("pdf export history re-export dialog opened", {
        jobId: entry.id,
        docId: normalizedDocId,
      });
      const bootstrap = await loadPdfExportDialogBootstrap(
        graphqlService,
        workspaceId,
        normalizedDocId,
      );
      if (activeScope.current !== scope) return;
      requireAssignedPdfTemplate(bootstrap);
      setBusyJobId(null);
      await openPdfExportDialog(workspaceDialogService, {
        workspaceId,
        docId: normalizedDocId,
        docTitle,
        bootstrap,
        returnFocusRef: { current: trigger },
        initialTemplateId: entry.templateId,
        initialFormValue: renderInputsToFormValue(entry.renderInputs ?? {}),
      });
      await load();
    } catch (err) {
      if (activeScope.current !== scope) return;
      if (
        (err as { errorClass?: string } | null)?.errorClass ===
        "WorkspaceConfigurationRequired"
      ) {
        notify.warning({
          title:
            t["com.myoxus.pdf-export.dialog.empty.no-templates.notice-title"](),
          message: t["com.myoxus.pdf-export.dialog.empty.no-templates.body"](),
        });
        return;
      }
      const message =
        err instanceof Error
          ? err.message
          : t["com.myoxus.sidebar.pdf-exports.error.reexport-failed"]();
      console.warn("pdf export history re-export failed", {
        jobId: entry.id,
        error: err,
      });
      setError(message);
    } finally {
      setBusyJobId(null);
    }
  };

  const createExport = async (trigger: HTMLButtonElement) => {
    setBusyJobId("create");
    setError(null);
    try {
      console.info("pdf export history initial export dialog opened", {
        docId: normalizedDocId,
      });
      const bootstrap = await loadPdfExportDialogBootstrap(
        graphqlService,
        workspaceId,
        normalizedDocId,
      );
      if (activeScope.current !== scope) return;
      requireAssignedPdfTemplate(bootstrap);
      setBusyJobId(null);
      const result = await openPdfExportDialog(workspaceDialogService, {
        workspaceId,
        docId: normalizedDocId,
        docTitle,
        bootstrap,
        returnFocusRef: { current: trigger },
      });
      if (result) {
        void load();
      }
    } catch (err) {
      if (activeScope.current !== scope) return;
      if (
        (err as { errorClass?: string } | null)?.errorClass ===
        "WorkspaceConfigurationRequired"
      ) {
        notify.warning({
          title:
            t["com.myoxus.pdf-export.dialog.empty.no-templates.notice-title"](),
          message: t["com.myoxus.pdf-export.dialog.empty.no-templates.body"](),
        });
        return;
      }
      const message =
        err instanceof Error
          ? err.message
          : t["com.myoxus.sidebar.pdf-exports.error.reexport-failed"]();
      console.warn("pdf export history initial export failed", {
        docId: normalizedDocId,
        error: err,
      });
      setError(message);
    } finally {
      setBusyJobId(null);
    }
  };

  return (
    <Stack
      aria-label={t["com.myoxus.sidebar.pdf-exports.aria-label"]()}
      component="section"
      data-empty={confirmedEmpty ? "true" : undefined}
      data-myoxus-ui-role="pdf-export-history"
      data-testid="pdf-export-history-panel"
    >
      {showRefreshAction ? (
        <Group
          component="header"
          data-myoxus-ui-role="pdf-export-history-header"
        >
          <Button
            data-testid="pdf-export-history-refresh"
            disabled={loading}
            onClick={load}
            variant="secondary"
          >
            {t["com.myoxus.sidebar.action.refresh"]()}
          </Button>
        </Group>
      ) : null}

      {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
      {loading ? (
        <MyoxusText
          component="p"
          data-myoxus-ui-role="empty-state-copy"
          tone="secondary"
          typographySlot="body-small"
        >
          {t["com.myoxus.sidebar.pdf-exports.loading"]()}
        </MyoxusText>
      ) : null}
      {!loading && !normalizedDocId ? (
        <MyoxusText
          component="p"
          data-myoxus-ui-role="empty-state-copy"
          tone="secondary"
          typographySlot="body-small"
        >
          {t["com.myoxus.sidebar.pdf-exports.waiting-for-doc"]()}
        </MyoxusText>
      ) : null}
      {confirmedEmpty ? (
        <>
          <MyoxusText data-testid="pdf-export-history-empty">
            {t["com.myoxus.sidebar.pdf-exports.empty"]()}
          </MyoxusText>
          <Button
            data-empty-action="secondary"
            data-testid="pdf-export-create-first"
            disabled={busyJobId === "create"}
            onClick={(event) => void createExport(event.currentTarget)}
            variant="plain"
          >
            {t["com.myoxus.pdf-export.dialog.button.start"]()}
          </Button>
        </>
      ) : null}

      <SurfaceList data-myoxus-ui-role="pdf-export-history-list">
        {entries.map((entry) => {
          const inputs = entry.renderInputs ?? {};
          const locale =
            typeof inputs.locale === "string" ? inputs.locale : "default";
          const busy = busyJobId === entry.id;
          return (
            <SurfaceListItem
              appearance="row"
              data-myoxus-ui-role="pdf-export-history-entry"
              density="default"
              key={entry.id}
              layout="column"
            >
              <SurfaceListCardHeader data-myoxus-ui-role="pdf-export-history-entry-header">
                <SurfaceListText
                  component="h3"
                  data-myoxus-ui-role="panel-title"
                  kind="card-title"
                >
                  {templateLabel(
                    entry,
                    t["com.myoxus.sidebar.pdf-exports.template.default"](),
                  )}
                </SurfaceListText>
                <Badge
                  tone={
                    entry.status === "done"
                      ? "success"
                      : entry.status === "failed"
                        ? "error"
                        : "neutral"
                  }
                  data-myoxus-ui-role="status-badge"
                  data-status={entry.status}
                >
                  {statusLabel(entry.status, t)}
                </Badge>
              </SurfaceListCardHeader>
              <SurfaceListMeta
                layout="row-group"
                data-myoxus-ui-role="panel-meta"
              >
                <MyoxusText component="span" typographySlot="body-small">
                  {t["com.myoxus.sidebar.pdf-exports.meta.locale"]()}: {locale}
                </MyoxusText>
                <MyoxusText component="span" typographySlot="body-small">
                  {t["com.myoxus.sidebar.pdf-exports.meta.created"]()}:{" "}
                  {entry.createdAt
                    ? formatDateTime(entry.createdAt)
                    : t["com.myoxus.sidebar.common.not-available"]()}
                </MyoxusText>
                {entry.pageCount == null ? null : (
                  <MyoxusText component="span" typographySlot="body-small">
                    {t["com.myoxus.sidebar.pdf-exports.meta.pages"]()}:{" "}
                    {entry.pageCount}
                  </MyoxusText>
                )}
              </SurfaceListMeta>
              {entry.errorClass ? (
                <MyoxusText
                  component="p"
                  data-myoxus-ui-role="panel-error"
                  tone="danger"
                  typographySlot="body-small"
                >
                  {entry.errorClass}:{" "}
                  {entry.errorDetail ??
                    t["com.myoxus.sidebar.common.no-details"]()}
                </MyoxusText>
              ) : null}
              <Group data-myoxus-ui-role="action-row">
                <Button
                  disabled={!entry.downloadUrl || busy}
                  onClick={() => void redownload(entry)}
                  variant="secondary"
                >
                  {t["com.myoxus.sidebar.pdf-exports.action.redownload"]()}
                </Button>
                <Button
                  disabled={busy}
                  onClick={(event) => void reexport(entry, event.currentTarget)}
                  variant="primary"
                >
                  {t["com.myoxus.sidebar.pdf-exports.action.reexport"]()}
                </Button>
              </Group>
            </SurfaceListItem>
          );
        })}
      </SurfaceList>
    </Stack>
  );
}

export const __test__ = {
  renderInputsToFormValue,
  safePdfFilename,
  statusLabel,
};
