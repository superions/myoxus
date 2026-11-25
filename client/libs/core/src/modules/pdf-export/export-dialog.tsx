import type { DialogComponentProps } from "@myoxus/core/modules/dialogs";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import type { WORKSPACE_DIALOG_SCHEMA } from "@myoxus/core/modules/dialogs/constant";
import {
  EventSourceService,
  FetchService,
  GraphQLService,
} from "@myoxus/core/modules/server";
import {
  cancelPdfExportJobMutation,
  pdfExportDialogBootstrapQuery,
  pdfTemplatePreviewPdfQuery,
} from "@myoxus/graphql";
import { I18n, useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import {
  Button,
  Group,
  Modal,
  MyoxusText,
  Progress,
  SettingsNotice,
  Stack,
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  notify,
  useClipboard,
} from "@myoxus/ui-facade";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  createDefaultPdfExportFormValue,
  PdfCapabilityForm,
  validatePdfExportFormValue,
} from "./capability-form";
import {
  PdfExportErrorDisplay,
  type PdfExportRenderError,
} from "./error-display";
import {
  runServerPdfExport,
  type ServerPdfExportProgress,
  type ServerPdfExportResult,
} from "./run-server-export";
import { PdfTemplatePreviewThumbnail } from "./template-preview-thumbnail";
import { PdfTemplatePicker } from "./template-picker";
import type {
  PdfExportDialogBootstrap,
  PdfExportDialogFormValue,
  PdfTemplateOption,
} from "./types";
import {
  LATEST_DOCUMENT_VERSION,
  PdfDocumentVersionPicker,
} from "./version-picker";

type PdfExportDialogStage = "options" | "progress";

export interface OpenPdfExportDialogOptions {
  workspaceId: string;
  docId: string;
  docTitle: string;
  bootstrap: PdfExportDialogBootstrap;
  onBeforeStart?: () => Promise<boolean | void>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  initialTemplateId?: string | null;
  initialFormValue?: PdfExportDialogFormValue;
}

export function requireAssignedPdfTemplate(
  bootstrap: PdfExportDialogBootstrap,
): void {
  if (bootstrap.availablePdfTemplates.length > 0) return;
  throw Object.assign(new Error("workspace has no assigned PDF template"), {
    errorClass: "WorkspaceConfigurationRequired" as const,
  });
}

export async function loadPdfExportDialogBootstrap(
  graphqlService: GraphQLService,
  workspaceId: string,
  docId: string,
): Promise<PdfExportDialogBootstrap> {
  return await graphqlService.gql({
    query: pdfExportDialogBootstrapQuery,
    variables: { workspaceId, docId, locale: I18n.language },
    timeout: 20_000,
  });
}

function selectInitialTemplate(
  options: OpenPdfExportDialogOptions,
): PdfTemplateOption {
  const templates = options.bootstrap.availablePdfTemplates;
  const selected =
    // Existing export-history rows may identify their template by slug.
    templates.find(
      (template) =>
        template.id === options.initialTemplateId ||
        template.slug === options.initialTemplateId,
    ) ??
    templates.find(
      (template) =>
        template.id === options.bootstrap.pdfExportSettings.defaultTemplateId,
    ) ??
    templates.find((template) => template.isDefault) ??
    templates[0];
  if (!selected) {
    throw new Error("PDF export dialog requires an assigned template");
  }
  return selected;
}

function progressLabel(
  progress: ServerPdfExportProgress | null,
  t: ReturnType<typeof useI18n>,
): string {
  if (!progress) return t.t("com.myoxus.pdf-export.dialog.progress.ready");
  switch (progress.phase) {
    case "queued":
      return t.t("com.myoxus.pdf-export.dialog.progress.queued");
    case "rendering":
      return t.t("com.myoxus.pdf-export.dialog.progress.rendering");
    case "validating":
      return t.t("com.myoxus.pdf-export.dialog.progress.validating");
    case "done":
      return t.t("com.myoxus.pdf-export.dialog.progress.done");
    case "failed":
      return t.t("com.myoxus.pdf-export.dialog.progress.failed");
  }
}

function progressPercent(progress: ServerPdfExportProgress | null): number {
  switch (progress?.phase) {
    case "queued":
      return 20;
    case "rendering":
      return 55;
    case "validating":
      return 80;
    case "done":
      return 100;
    case "failed":
      return 100;
    default:
      return 0;
  }
}

function cleanExportInput(value: PdfExportDialogFormValue) {
  return Object.fromEntries(
    Object.entries(value).filter(([, next]) => {
      if (next === undefined || next === null || next === "") return false;
      if (typeof next === "string") return next.trim().length > 0;
      return true;
    }),
  );
}

function errorFromUnknown(
  err: unknown,
  progress: ServerPdfExportProgress | null,
  fallbackMessage: string,
): PdfExportRenderError {
  const structured = err as
    | {
        jobId?: string;
        errorClass?: string | null;
        errorDetail?: string | null;
        message?: string;
        extensions?: { class?: string; violationsJson?: string };
      }
    | undefined;
  return {
    code:
      structured?.errorClass ??
      structured?.extensions?.class ??
      progress?.errorClass ??
      "Unknown",
    jobId: structured?.jobId ?? progress?.jobId,
    message:
      structured?.message ??
      structured?.errorDetail ??
      progress?.errorDetail ??
      fallbackMessage,
    detail:
      structured?.errorDetail ??
      structured?.extensions?.violationsJson ??
      progress?.errorDetail ??
      undefined,
  };
}

function initialFormValue(
  options: OpenPdfExportDialogOptions,
  template: PdfTemplateOption,
  webLanguage: string,
): PdfExportDialogFormValue {
  return {
    ...createDefaultPdfExportFormValue(
      template,
      options.bootstrap.pdfExportSettings,
      options.bootstrap.documentBrandingProfile,
      options.docTitle,
      webLanguage,
    ),
    ...Object.fromEntries(
      Object.entries(options.initialFormValue ?? {}).filter(
        ([, value]) => value !== undefined,
      ),
    ),
  };
}

export function PdfExportDialog({
  close: finishClose,
  ...options
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["pdf-export"]>) {
  const t = useI18n();
  const [opened, setOpened] = useState(true);
  const closeResult = useRef<ServerPdfExportResult | null>(null);
  // Keep the service-owned dialog mounted until Mantine restores focus.
  const close = (result: ServerPdfExportResult | null) => {
    closeResult.current = result;
    setOpened(false);
  };
  const graphqlService = useService(GraphQLService);
  const eventSourceService = useService(EventSourceService);
  const fetchService = useService(FetchService);
  const documentMetadataCache = useService(DocumentMetadataCacheService);
  const hasTemplateChoice = options.bootstrap.availablePdfTemplates.length > 1;
  const [selectedTemplate, setSelectedTemplate] = useState(() =>
    selectInitialTemplate(options),
  );
  const [formValue, setFormValue] = useState(() =>
    initialFormValue(options, selectedTemplate, t.language),
  );
  const [selectedDocumentVersion, setSelectedDocumentVersion] = useState(
    LATEST_DOCUMENT_VERSION,
  );
  const [stage, setStage] = useState<PdfExportDialogStage>("options");
  const [progress, setProgress] = useState<ServerPdfExportProgress | null>(
    null,
  );
  const progressRef = useRef<ServerPdfExportProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<PdfExportRenderError | null>(
    null,
  );
  const clipboard = useClipboard({ timeout: 2000 });
  const exportFailedMessage = t.t("com.myoxus.pdf-export.dialog.error.failed");

  useEffect(() => {
    if (clipboard.copied) {
      notify.success({ title: t["Copied to clipboard"]() });
    }
  }, [clipboard.copied, t]);

  useEffect(() => {
    if (clipboard.error) {
      notify.error({ title: t["com.myoxus.common.operation-failed"]() });
    }
  }, [clipboard.error, t]);

  const updateProgress = useCallback((next: ServerPdfExportProgress | null) => {
    progressRef.current = next;
    setProgress(next);
  }, []);

  const validationErrors = useMemo(
    () => validatePdfExportFormValue(selectedTemplate, formValue),
    [formValue, selectedTemplate],
  );
  const hasValidationErrors = Object.keys(validationErrors).length > 0;
  const exportBlockedByDocumentMetadata =
    options.bootstrap.documentMetadataValidation.blockedActions.includes(
      "export_pdf",
    );
  const canStart =
    !busy && !hasValidationErrors && !exportBlockedByDocumentMetadata;
  const canCancel =
    busy && !cancelling && progress?.status === "queued" && !!progress.jobId;
  const documentMetadataIssues = [
    ...options.bootstrap.documentMetadataValidation.errors,
    ...options.bootstrap.documentMetadataValidation.warnings,
  ];

  const start = async () => {
    if (!canStart) return;
    setBusy(true);
    setTransportError(null);
    setRenderError(null);
    updateProgress(null);
    setStage("progress");
    try {
      const canContinue = await options.onBeforeStart?.();
      if (canContinue === false) {
        setBusy(false);
        setStage("options");
        return;
      }
      // The server may commit an automatic version even when PDF rendering
      // subsequently fails. Refresh the existing canonical cache on either
      // outcome; a failed refresh must not disguise a successful download.
      const result = await runServerPdfExport(
        options.workspaceId,
        options.docId,
        options.docTitle,
        graphqlService,
        {
          ...cleanExportInput(formValue),
          fetchService,
          templateId: selectedTemplate.id,
          documentVersionId: options.bootstrap.documentVersioningSettings
            .enabled
            ? selectedDocumentVersion
            : undefined,
          eventSourceService,
          onProgress: updateProgress,
        },
      ).finally(() => {
        documentMetadataCache.invalidateIndex("pdf-export-attempt");
        void documentMetadataCache
          .hydrateMetadata(options.docId, undefined, { refresh: true })
          .catch(() => {
            documentMetadataCache.markStale(
              options.docId,
              "pdf-export-refresh-failed",
            );
          });
      });
      close(result);
    } catch (err) {
      setRenderError(
        errorFromUnknown(err, progressRef.current, exportFailedMessage),
      );
      setBusy(false);
      setCancelling(false);
    }
  };

  const loadTemplatePreviewPdf = async (template: PdfTemplateOption) => {
    const locale =
      typeof formValue.locale === "string" && formValue.locale.trim()
        ? formValue.locale
        : (options.bootstrap.pdfExportSettings.defaultLocale ?? "en-US");
    const result = await graphqlService.gql({
      query: pdfTemplatePreviewPdfQuery,
      variables: {
        templateId: template.id,
        locale,
        workspaceId: options.workspaceId,
      },
    });
    return result.pdfTemplatePreviewPdf ?? null;
  };

  const cancel = async () => {
    if (!canCancel || !progress?.jobId) return;
    setCancelling(true);
    setTransportError(null);
    try {
      const result = await graphqlService.gql({
        query: cancelPdfExportJobMutation,
        variables: { jobId: progress.jobId },
      });
      if (!result.cancelPdfExportJob) {
        setTransportError(
          t.t("com.myoxus.pdf-export.dialog.error.cancel-rejected"),
        );
        setCancelling(false);
      }
    } catch {
      setTransportError(
        t.t("com.myoxus.pdf-export.dialog.error.cancel-failed"),
      );
      setCancelling(false);
    }
  };

  const title = t["com.myoxus.export.pdf.menu-label"]();

  return (
    <Modal
      open={opened}
      returnFocusRef={options.returnFocusRef}
      onExitTransitionEnd={() => finishClose(closeResult.current)}
      onOpenChange={(open) => !open && !busy && close(null)}
      persistent={busy}
      title={title}
      width="xl"
      scrollable
      contentOptions={{ "data-testid": "pdf-export-dialog" }}
    >
      <Stack gap="lg" data-myoxus-ui-role="pdf-export-dialog-content">
        {stage === "options" ? (
          <>
            <Group align="flex-start" wrap="nowrap">
              <PdfTemplatePreviewThumbnail
                key={selectedTemplate.id}
                templateId={selectedTemplate.id}
                templateName={selectedTemplate.name}
                loadPreviewPdf={() => loadTemplatePreviewPdf(selectedTemplate)}
              />
              <Stack flex={1} gap="xs">
                <MyoxusText typographySlot="section">
                  {options.docTitle}
                </MyoxusText>
                <MyoxusText tone="secondary">
                  {selectedTemplate.name}
                </MyoxusText>
              </Stack>
            </Group>
            {hasTemplateChoice ? (
              <Accordion variant="default">
                <AccordionItem value="template">
                  <AccordionControl>{selectedTemplate.name}</AccordionControl>
                  <AccordionPanel>
                    <PdfTemplatePicker
                      templates={options.bootstrap.availablePdfTemplates}
                      selectedTemplateId={selectedTemplate.id}
                      loadPreviewPdf={loadTemplatePreviewPdf}
                      onSelect={(template) => {
                        const defaults = createDefaultPdfExportFormValue(
                          template,
                          options.bootstrap.pdfExportSettings,
                          options.bootstrap.documentBrandingProfile,
                        );
                        setSelectedTemplate(template);
                        setFormValue((current) => ({
                          ...initialFormValue(options, template, t.language),
                          paperSize: (
                            template.capabilities.paperSize?.values ?? [
                              "A4",
                              "Letter",
                              "A3",
                              "A5",
                            ]
                          ).includes(current.paperSize ?? "")
                            ? current.paperSize
                            : defaults.paperSize,
                          orientation: current.orientation,
                          complianceProfile: current.complianceProfile,
                          colorVariant:
                            template.capabilities.colorVariant?.values?.includes(
                              current.colorVariant ?? "",
                            )
                              ? current.colorVariant
                              : defaults.colorVariant,
                        }));
                      }}
                    />
                  </AccordionPanel>
                </AccordionItem>
              </Accordion>
            ) : null}
          </>
        ) : null}

        {stage === "options" ? (
          <>
            {documentMetadataIssues.length > 0 ? (
              <SettingsNotice
                role={exportBlockedByDocumentMetadata ? "alert" : "note"}
                tone={exportBlockedByDocumentMetadata ? "error" : "warning"}
                title={
                  exportBlockedByDocumentMetadata
                    ? t.t(
                        "com.myoxus.pdf-export.dialog.document-metadata.blocked",
                      )
                    : t.t(
                        "com.myoxus.pdf-export.dialog.document-metadata.warnings",
                      )
                }
              >
                <Stack gap="xs">
                  {documentMetadataIssues.map((issue) => (
                    <MyoxusText
                      key={`${issue.code}-${issue.key ?? "document"}`}
                    >
                      {issue.message}
                    </MyoxusText>
                  ))}
                </Stack>
              </SettingsNotice>
            ) : null}
            <PdfCapabilityForm
              template={selectedTemplate}
              settings={options.bootstrap.pdfExportSettings}
              brandingProfile={options.bootstrap.documentBrandingProfile}
              value={formValue}
              onChange={setFormValue}
              validationErrors={validationErrors}
              beforeFields={
                <PdfDocumentVersionPicker
                  documentMetadata={options.bootstrap.documentMetadata}
                  settings={options.bootstrap.documentVersioningSettings}
                  versions={options.bootstrap.documentVersions}
                  value={selectedDocumentVersion}
                  onChange={setSelectedDocumentVersion}
                />
              }
            />
          </>
        ) : null}

        {stage === "progress" ? (
          <Stack gap="md" aria-live="polite">
            <MyoxusText typographySlot="section">
              {renderError
                ? t.t("com.myoxus.pdf-export.dialog.progress.failed")
                : progressLabel(progress, t)}
            </MyoxusText>
            {!renderError ? (
              <Progress
                ariaLabel={progressLabel(progress, t)}
                value={progressPercent(progress)}
              />
            ) : null}
            {transportError ? (
              <SettingsNotice tone="error" role="alert">
                {transportError}
              </SettingsNotice>
            ) : null}
            {renderError ? (
              <SettingsNotice tone="error" role="alert">
                <PdfExportErrorDisplay
                  copied={clipboard.copied}
                  error={renderError}
                  onCopyDetails={(details) => {
                    clipboard.copy(details);
                  }}
                />
              </SettingsNotice>
            ) : null}
          </Stack>
        ) : null}

        <Group justify="flex-end" wrap="wrap">
          {stage === "options" ? (
            <>
              <Button variant="secondary" onClick={() => close(null)}>
                {t.t("com.myoxus.pdf-export.dialog.button.cancel")}
              </Button>
              <Button disabled={!canStart} variant="primary" onClick={start}>
                {t.t("com.myoxus.pdf-export.dialog.button.start")}
              </Button>
            </>
          ) : null}
          {stage === "progress" ? (
            renderError ? (
              <Button
                variant="primary"
                onClick={() => {
                  setRenderError(null);
                  setTransportError(null);
                  setStage("options");
                }}
              >
                {t["com.myoxus.export.pdf.retry"]()}
              </Button>
            ) : (
              <Button
                disabled={!canCancel}
                variant="secondary"
                onClick={cancel}
              >
                {cancelling
                  ? t.t("com.myoxus.pdf-export.dialog.button.cancelling")
                  : t.t("com.myoxus.pdf-export.dialog.button.cancel")}
              </Button>
            )
          ) : null}
        </Group>
      </Stack>
    </Modal>
  );
}

export function openPdfExportDialog(
  dialogService: WorkspaceDialogService,
  options: OpenPdfExportDialogOptions,
): Promise<ServerPdfExportResult | null> {
  requireAssignedPdfTemplate(options.bootstrap);
  return new Promise((resolve) => {
    dialogService.open("pdf-export", options, (result) => {
      resolve(result ?? null);
    });
  });
}
