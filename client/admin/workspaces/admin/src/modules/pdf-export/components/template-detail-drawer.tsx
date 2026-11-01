/**
 * @file PDF export module — Detail drawer for one template.
 *
 * Tabs:
 *  - Overview — name, description, slug, version, source, capabilities.
 *  - Manifest — pretty-printed JSON manifest (read-only).
 *  - Files    — bundle file list with blob keys + content hashes.
 *  - Workspaces — list of workspaces this template is assigned to.
 *  - Edit     — rename + description (admin-only on non-system templates).
 *
 * Architecture:
 *  - Manifest content remains read-only for system-seeded templates
 *    (default/report/letter) per
 *    `docs/dev/server/pdf-export-v2-architecture.md` §8 — the bundled
 *    Typst sources are the source of truth, the DB rows are runtime
 *    cache.
 */
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Drawer,
  ErrorMessage,
  FieldLabel,
  Group,
  InlineLink,
  Input,
  notify,
  PdfPreviewCanvas,
  PdfPreviewError,
  PdfPreviewFooter,
  PdfPreviewPageCounter,
  PdfPreviewToolbar,
  PdfPreviewShell,
  PdfPreviewViewport,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsHeadingGroup,
  SettingsNotice,
  SettingsPanelDescription,
  SettingsSectionDescription,
  SettingsSectionHeading,
  SettingsStatusText,
  SettingsToolbar,
  Skeleton,
  Stack,
  SurfaceList,
  SurfaceListItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@myoxus/ui-facade";
import { getPdfResourceOptions } from "@myoxus/env/worker";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatAdminDateTime } from "../../../utils/locale-format";
import {
  usePdfTemplateAssignedWorkspacesQuery,
  usePdfTemplateFilesQuery,
  usePdfTemplatePreviewPdfQuery,
  useUpdatePdfTemplateMetadataMutation,
} from "../api";
import { PdfTemplateSourceBadge } from "../badges";
import type { PdfTemplateViewModel } from "../format-adapters";
import { logPdfExportUiEvent } from "../logging";
import {
  pdfTemplateDisplayDescription,
  pdfTemplateDisplayName,
} from "../template-localization";
import { UploadTemplateDialog } from "./upload-template-dialog";

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function OverviewTab({ template }: { template: PdfTemplateViewModel }) {
  const i18n = useI18n();
  const description = pdfTemplateDisplayDescription(template, i18n.t);
  return (
    <Stack>
      <SettingsDefinitionList>
        <SettingsDefinitionItem
          label={i18n.t("admin.pdf-export.column.slug")}
          mono
        >
          {template.slug}
        </SettingsDefinitionItem>
        <SettingsDefinitionItem
          label={i18n.t("admin.pdf-export.column.version")}
        >
          {template.version}
        </SettingsDefinitionItem>
        <SettingsDefinitionItem
          label={i18n.t("admin.pdf-export.column.source")}
        >
          <PdfTemplateSourceBadge source={template.source} />
        </SettingsDefinitionItem>
        <SettingsDefinitionItem
          label={i18n.t("admin.pdf-export.detail.schema-version")}
        >
          {template.schemaVersion}
        </SettingsDefinitionItem>
      </SettingsDefinitionList>

      {description ? (
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={3}>
            {i18n.t("admin.pdf-export.detail.description")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>{description}</SettingsSectionDescription>
        </SettingsHeadingGroup>
      ) : null}

      {template.provenance ? (
        <Stack component="section">
          <SettingsSectionHeading level={3}>
            {i18n.t("admin.pdf-export.column.source")}
          </SettingsSectionHeading>
          <SettingsDefinitionList>
            <SettingsDefinitionItem
              label={i18n.t("admin.pdf-fonts.column.license")}
              mono
            >
              {template.provenance.licenseSpdx}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t("admin.pdf-export.column.source")}
            >
              <InlineLink
                href={template.provenance.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                {template.provenance.sourceUrl}
              </InlineLink>
              {" @ "}
              <SettingsStatusText mono>
                {template.provenance.sourceRevision}
              </SettingsStatusText>
            </SettingsDefinitionItem>
          </SettingsDefinitionList>
          <SettingsPanelDescription>
            {template.provenance.copyrightNotice}
          </SettingsPanelDescription>
          {template.provenance.notice ? (
            <SettingsPanelDescription>
              {template.provenance.notice}
            </SettingsPanelDescription>
          ) : null}
        </Stack>
      ) : (
        <SettingsNotice tone="error">
          {i18n.t("admin.pdf-export.upload.error.invalid-bundle")}
        </SettingsNotice>
      )}

      <SettingsNotice tone="neutral">
        {template.source === "system"
          ? i18n.t("admin.pdf-export.detail.system-template-hint")
          : i18n.t("admin.pdf-export.detail.admin-template-hint")}
      </SettingsNotice>
    </Stack>
  );
}

function capabilityGroup(key: string) {
  if (/page|paper|margin|cover|toc/i.test(key)) return "page";
  if (/number|folio|counter/i.test(key)) return "numbering";
  if (/font|type|ligature|drop|column|note/i.test(key)) return "typography";
  if (/locale|translation|language/i.test(key)) return "locale";
  if (/pdf|icc|color|image|dpi|compression/i.test(key)) return "output";
  if (/encrypt|password|classification|watermark/i.test(key)) {
    return "security";
  }
  return "other";
}

function CapabilitiesTab({ template }: { template: PdfTemplateViewModel }) {
  const i18n = useI18n();
  const entries = Object.entries(template.capabilities);
  if (entries.length === 0) {
    return (
      <SettingsStatusText>
        {i18n.t("admin.pdf-export.detail.no-capabilities")}
      </SettingsStatusText>
    );
  }

  const groups = entries.reduce<Record<string, Array<[string, unknown]>>>(
    (acc, entry) => {
      const group = capabilityGroup(entry[0]);
      acc[group] ??= [];
      acc[group].push(entry);
      return acc;
    },
    {},
  );
  const order = [
    "page",
    "numbering",
    "typography",
    "locale",
    "output",
    "security",
    "other",
  ];

  return (
    <Stack>
      {order
        .filter((group) => groups[group]?.length)
        .map((group) => (
          <Stack key={group} component="section">
            <SettingsSectionHeading level={3}>
              {i18n.t(`admin.pdf-export.detail.capability-group.${group}`)}
            </SettingsSectionHeading>
            <SurfaceList>
              {groups[group].map(([key, value]) => (
                <SurfaceListItem key={key} component="li" density="compact">
                  <Group justify="space-between" wrap="wrap">
                    <SettingsStatusText mono>{key}</SettingsStatusText>
                    <SettingsStatusText mono>
                      {JSON.stringify(value)}
                    </SettingsStatusText>
                  </Group>
                </SurfaceListItem>
              ))}
            </SurfaceList>
          </Stack>
        ))}
    </Stack>
  );
}

function ManifestTab({ template }: { template: PdfTemplateViewModel }) {
  const i18n = useI18n();
  return (
    <Stack>
      <SettingsPanelDescription>
        {i18n.t("admin.pdf-export.detail.manifest-readonly")}
      </SettingsPanelDescription>
      <Textarea
        readOnly
        mono
        rows={18}
        value={JSON.stringify(template.manifest, null, 2)}
      />
    </Stack>
  );
}

function FilesTab({ templateId }: { templateId: string }) {
  const i18n = useI18n();
  const query = usePdfTemplateFilesQuery(templateId);
  const files = query.files ?? [];

  if (query.isLoading) return <Skeleton h={96} />;
  if (files.length === 0) {
    return (
      <SettingsStatusText>
        {i18n.t("admin.pdf-export.detail.no-files")}
      </SettingsStatusText>
    );
  }

  return (
    <Table aria-label={i18n.t("admin.pdf-export.detail.files-aria")}>
      <TableHeader>
        <TableRow>
          <TableHead>{i18n.t("admin.pdf-export.detail.file-path")}</TableHead>
          <TableHead>{i18n.t("admin.pdf-export.detail.blob-key")}</TableHead>
          <TableHead>
            {i18n.t("admin.pdf-export.detail.content-hash")}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map((f) => (
          <TableRow key={f.filePath}>
            <TableCell mono>{f.filePath}</TableCell>
            <TableCell mono muted>
              {f.blobKey}
            </TableCell>
            <TableCell mono muted>
              {f.contentHash.slice(0, 16)}…
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function WorkspacesTab({ templateId }: { templateId: string }) {
  const i18n = useI18n();
  const query = usePdfTemplateAssignedWorkspacesQuery(templateId);
  const assignments = query.assignments ?? [];

  if (query.isLoading) return <Skeleton h={96} />;
  if (assignments.length === 0) {
    return (
      <SettingsStatusText>
        {i18n.t("admin.pdf-export.detail.not-assigned")}
      </SettingsStatusText>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            {i18n.t("admin.pdf-export.detail.workspace-id")}
          </TableHead>
          <TableHead>{i18n.t("admin.pdf-export.detail.is-default")}</TableHead>
          <TableHead>{i18n.t("admin.pdf-export.detail.assigned-at")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {assignments.map((a) => (
          <TableRow key={a.workspaceId}>
            <TableCell mono>{a.workspaceId}</TableCell>
            <TableCell>
              {a.isDefault
                ? i18n.t("admin.common.yes")
                : i18n.t("admin.common.no")}
            </TableCell>
            <TableCell muted>
              {formatAdminDateTime(i18n.language, a.assignedAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type PreviewRenderState = "idle" | "loading" | "ready" | "failed";

function decodeBase64Pdf(pdfBase64: string): Uint8Array {
  const binary = atob(pdfBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function PdfJsPreviewCanvas({ pdfBase64 }: { pdfBase64: string }) {
  const i18n = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [state, setState] = useState<PreviewRenderState>("idle");
  const [error, setError] = useState<string | null>(null);
  const dataUrl = `data:application/pdf;base64,${pdfBase64}`;

  const reportError = useCallback((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logPdfExportUiEvent("template.preview.pdfjs.failed", { message }, "error");
    setError(message);
    setState("failed");
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    setPdf(null);
    setPageNumber(1);
    setState("loading");
    setError(null);

    async function loadPreview() {
      try {
        const pdfjs = await import("pdfjs-dist");
        if (cancelled) return;
        // Keep the document loaded while navigating; only the render task changes.
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        loadingTask = pdfjs.getDocument({
          ...getPdfResourceOptions(pdfjs.version),
          data: decodeBase64Pdf(pdfBase64),
        });
        const document = await loadingTask.promise;
        if (!cancelled) setPdf(document);
      } catch (err) {
        if (!cancelled) reportError(err);
      }
    }

    void loadPreview();
    return () => {
      cancelled = true;
      void loadingTask?.destroy();
    };
  }, [pdfBase64, reportError]);

  useEffect(() => {
    if (!pdf) return;
    const document = pdf;
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    setState("loading");
    setError(null);

    async function renderPage() {
      try {
        const page = await document.getPage(pageNumber);
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const viewport = page.getViewport({ scale: 1.35 });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        if (!canvas.getContext("2d"))
          throw new Error("Canvas 2D context is unavailable");
        renderTask = page.render({ canvas, viewport });
        await renderTask.promise;
        page.cleanup();
        if (!cancelled) setState("ready");
      } catch (err) {
        if (!cancelled) reportError(err);
      }
    }

    void renderPage();
    return () => {
      // A page change must release the canvas before the next page uses it.
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdf, pageNumber, reportError]);

  return (
    <PdfPreviewShell>
      {state === "failed" ? (
        <PdfPreviewError>
          <ErrorMessage>
            {i18n.t("admin.pdf-export.detail.preview.pdfjs-failed")}
            {error ? `: ${error}` : ""}
          </ErrorMessage>
        </PdfPreviewError>
      ) : null}
      {pdf && pdf.numPages > 1 ? (
        <PdfPreviewToolbar>
          <Button
            disabled={pageNumber === 1 || state === "loading"}
            onClick={() => setPageNumber((page) => page - 1)}
          >
            {i18n.t("admin.common.previous")}
          </Button>
          <PdfPreviewPageCounter
            current={new Intl.NumberFormat(i18n.language).format(pageNumber)}
            total={new Intl.NumberFormat(i18n.language).format(pdf.numPages)}
          />
          <Button
            disabled={pageNumber === pdf.numPages || state === "loading"}
            onClick={() => setPageNumber((page) => page + 1)}
          >
            {i18n.t("admin.common.next")}
          </Button>
        </PdfPreviewToolbar>
      ) : null}
      <PdfPreviewViewport>
        {state === "loading" || state === "idle" ? <Skeleton h="70vh" /> : null}
        <PdfPreviewCanvas
          ref={canvasRef}
          aria-label={i18n.t("admin.pdf-export.detail.preview.aria")}
          data-render-state={state}
        />
      </PdfPreviewViewport>
      <PdfPreviewFooter>
        <SettingsStatusText>
          {i18n.t("admin.pdf-export.detail.preview.fallback")}{" "}
        </SettingsStatusText>
        <InlineLink href={dataUrl} target="_blank" rel="noreferrer">
          {i18n.t("admin.pdf-export.detail.preview.open")}
        </InlineLink>
      </PdfPreviewFooter>
    </PdfPreviewShell>
  );
}

function PreviewTab({ template }: { template: PdfTemplateViewModel }) {
  const i18n = useI18n();
  const query = usePdfTemplatePreviewPdfQuery(template.id, i18n.language);

  if (query.error) {
    const message =
      query.error instanceof Error ? query.error.message : String(query.error);
    return (
      <SettingsNotice
        tone="error"
        title={i18n.t("admin.pdf-export.detail.preview.failed")}
      >
        {message}
      </SettingsNotice>
    );
  }

  return (
    <Stack>
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.pdf-export.detail.preview.title")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.pdf-export.detail.preview.description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      {query.pdfBase64 ? (
        <PdfJsPreviewCanvas pdfBase64={query.pdfBase64} />
      ) : (
        <Skeleton h="70vh" />
      )}
    </Stack>
  );
}

function EditTab({
  template,
  onChanged,
  onReplace,
}: {
  template: PdfTemplateViewModel;
  onChanged: () => void;
  onReplace: () => void;
}) {
  const i18n = useI18n();
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? "");
  const [saving, setSaving] = useState(false);
  const updateMutation = useUpdatePdfTemplateMetadataMutation();

  const dirty =
    name !== template.name || description !== (template.description ?? "");

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await updateMutation.trigger({
        id: template.id,
        name: name !== template.name ? name : undefined,
        description:
          description !== (template.description ?? "")
            ? description
            : undefined,
      });
      notify.success({ title: i18n.t("admin.pdf-export.edit.success") });
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify.error({
        title: i18n.t("admin.pdf-export.edit.failed"),
        message: msg,
      });
    } finally {
      setSaving(false);
    }
  }, [updateMutation, template, name, description, onChanged, i18n]);

  return (
    <Stack>
      <Stack>
        <FieldLabel htmlFor="pdf-tpl-edit-name">
          {i18n.t("admin.pdf-export.detail.name")}
        </FieldLabel>
        <Input
          id="pdf-tpl-edit-name"
          value={name}
          onChange={setName}
          maxLength={80}
        />
      </Stack>
      <Stack>
        <FieldLabel htmlFor="pdf-tpl-edit-desc">
          {i18n.t("admin.pdf-export.detail.description")}
        </FieldLabel>
        <Textarea
          id="pdf-tpl-edit-desc"
          value={description}
          onChange={setDescription}
          maxLength={500}
          rows={3}
        />
      </Stack>
      <SettingsToolbar>
        <Button onClick={handleSave} disabled={!dirty || saving}>
          {saving ? i18n.t("admin.common.saving") : i18n.t("admin.common.save")}
        </Button>
        <Button variant="secondary" onClick={onReplace}>
          {i18n.t("admin.pdf-export.upload.replace-button")}
        </Button>
      </SettingsToolbar>
      <SettingsNotice tone="neutral">
        {i18n.t("admin.pdf-export.upload.replace-preserves-assignments")}
      </SettingsNotice>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function TemplateDetailDrawer({
  template,
  onClose,
  onChanged,
}: {
  template: PdfTemplateViewModel;
  onClose: () => void;
  onChanged: () => void;
}) {
  const i18n = useI18n();
  const [replaceOpen, setReplaceOpen] = useState(false);
  const title = pdfTemplateDisplayName(template, i18n.t);
  return (
    <>
      <Drawer
        open
        onOpenChange={(open) => !open && onClose()}
        title={title}
        description={
          <Group wrap="wrap">
            <SettingsStatusText mono>{template.slug}</SettingsStatusText>
            {" · "}
            {template.version}
          </Group>
        }
        size="min(42rem, 100vw)"
      >
        <Tabs defaultValue="overview" layout="embedded">
          <TabsList>
            <TabsTrigger value="overview">
              {i18n.t("admin.pdf-export.detail.tab.overview")}
            </TabsTrigger>
            <TabsTrigger value="manifest">
              {i18n.t("admin.pdf-export.detail.tab.manifest")}
            </TabsTrigger>
            <TabsTrigger value="files">
              {i18n.t("admin.pdf-export.detail.tab.files")}
            </TabsTrigger>
            <TabsTrigger value="capabilities">
              {i18n.t("admin.pdf-export.detail.tab.capabilities")}
            </TabsTrigger>
            <TabsTrigger value="workspaces">
              {i18n.t("admin.pdf-export.detail.tab.workspaces")}
            </TabsTrigger>
            <TabsTrigger value="preview">
              {i18n.t("admin.pdf-export.detail.tab.preview")}
            </TabsTrigger>
            {!template.isDeleted && template.source === "admin" ? (
              <TabsTrigger value="edit">
                {i18n.t("admin.pdf-export.detail.tab.edit")}
              </TabsTrigger>
            ) : null}
          </TabsList>

          <TabsContent value="overview" layout="stack">
            <OverviewTab template={template} />
          </TabsContent>
          <TabsContent value="manifest" layout="stack">
            <ManifestTab template={template} />
          </TabsContent>
          <TabsContent value="files" layout="stack">
            <FilesTab templateId={template.id} />
          </TabsContent>
          <TabsContent value="capabilities" layout="stack">
            <CapabilitiesTab template={template} />
          </TabsContent>
          <TabsContent value="workspaces" layout="stack">
            <WorkspacesTab templateId={template.id} />
          </TabsContent>
          <TabsContent value="preview" layout="stack">
            <PreviewTab template={template} />
          </TabsContent>
          {!template.isDeleted && template.source === "admin" ? (
            <TabsContent value="edit" layout="stack">
              <EditTab
                key={`${template.id}:${template.version}`}
                template={template}
                onChanged={onChanged}
                onReplace={() => setReplaceOpen(true)}
              />
            </TabsContent>
          ) : null}
        </Tabs>
      </Drawer>
      {replaceOpen ? (
        <UploadTemplateDialog
          replaceTemplate={{
            id: template.id,
            slug: template.slug,
            version: template.version,
          }}
          onClose={() => setReplaceOpen(false)}
          onUploaded={() => {
            setReplaceOpen(false);
            notify.success({
              title: i18n.t("admin.pdf-export.upload.replace-success"),
            });
            onChanged();
          }}
        />
      ) : null}
    </>
  );
}
