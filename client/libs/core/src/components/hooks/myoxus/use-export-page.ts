import { Container } from "@virgultum/editor/global/di";
import type { RefObject } from "react";
import { exportWorkspaceLabels } from "@myoxus/core/modules/tag/export";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { EditorService } from "@myoxus/core/modules/editor";
import { CoreDocEmbedProvider, DocsService } from "@myoxus/core/modules/doc";
import { GuardService } from "@myoxus/core/modules/permissions";
import {
  GraphQLService,
  FetchService,
  WorkspaceServerService,
} from "@myoxus/core/modules/server";
import {
  type Workspace as CoreWorkspace,
  WorkspaceService,
} from "@myoxus/core/modules/workspace";
import { getMyoxusWorkspaceSchema } from "@myoxus/core/modules/workspace/global-schema";
import {
  pushGlobalLoadingEventAtom,
  resolveGlobalLoadingEventAtom,
} from "@myoxus/global-loading";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { notify } from "@myoxus/ui-facade";
import {
  getMermaidBlockSource,
  getMermaidBlockTitle,
  mermaidMessages,
  MermaidRenderSourceError,
  normalizeMermaidExportFileName,
  projectMermaidExportRenderSource,
  renderMermaidSvg,
} from "@virgultum/block-mermaid";
import { ExportManager } from "@virgultum/editor/blocks/surface";
import {
  docLinkBaseURLMiddleware,
  documentReferenceMiddleware,
  prepareMarkdownDocumentExport,
  embedSyncedDocMiddleware,
  HtmlAdapterFactoryIdentifier,
  MarkdownAdapterFactoryIdentifier,
  MarkdownAdapter,
  type MarkdownImportDiagnostics,
  hasMarkdownImportDiagnostics,
  titleMiddleware,
} from "@virgultum/editor/shared/adapters";
import { printToPdf } from "@virgultum/editor/shared/utils";
import { DocEmbedProvider } from "@virgultum/editor/shared/services";
import type { EmbedSyncedDocModel } from "@virgultum/editor/model";
import type { BlockStdScope } from "@virgultum/editor/std";
import { type Store, Transformer } from "@virgultum/editor/store";
import {
  createAssetsArchive,
  download,
  MarkdownTransformer,
  ZipTransformer,
} from "@virgultum/editor/widgets/linked-doc";
import { useSetAtom } from "jotai";
import { nanoid } from "nanoid";

import { openEdgelessPreflightDialog } from "../../../modules/pdf-export/edgeless-preflight-dialog";
import {
  loadPdfExportDialogBootstrap,
  openPdfExportDialog,
  requireAssignedPdfTemplate,
} from "../../../modules/pdf-export/export-dialog";
import type { ServerPdfExportResult } from "../../../modules/pdf-export/run-server-export";
import { useAsyncCallback } from "../myoxus-async-hooks";
import {
  SOURCE_SYNC_TIMEOUT_MS as PDF_SOURCE_SYNC_TIMEOUT_MS,
  waitForServerDocumentSync as waitForServerPdfSourceSync,
} from "../../../modules/file-export/source-sync";
import { materializeDiagramExportSvg } from "./diagram-export-svg";
import { startDocxExport } from "../../../modules/file-export/docx-export-notification";

export type {
  PdfExportJobPhase,
  ServerPdfExportOptions,
  ServerPdfExportProgress,
  ServerPdfExportResult,
} from "../../../modules/pdf-export/run-server-export";
export { runServerPdfExport } from "../../../modules/pdf-export/run-server-export";

type ExportType =
  | "docx"
  | "pdf"
  | "html"
  | "png"
  | "markdown"
  | "snapshot"
  | "pdf-export"
  | "mermaid-source"
  | "mermaid-markdown"
  | "mermaid-svg"
  | "mermaid-png";

interface ExportHandlerOptions {
  page: Store;
  /**
   * Editor host root. Pre-B-FIND-02 this was typed as the rich
   * `MyoxusEditorContainer` adapter, but the only branch that
   * reads it (`pdf` -> `printToPdf`) wants the raw
   * `HTMLElement`. Tightening here keeps the contract honest.
   */
  editorContainer: HTMLElement | null;
  type: Exclude<ExportType, "docx">;
  graphqlService: GraphQLService;
  workspaceDialogService: WorkspaceDialogService;
  /** Editor mode at the time the user clicked Export. Edgeless triggers the
   *  client-side raster snapshot capture before the server export starts. */
  pageMode: "page" | "edgeless";
  workspace: CoreWorkspace;
  guardService: GuardService;
  docsService: DocsService;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

interface AdapterResult {
  file: string;
  assetsIds: string[];
}

type AdapterFactoryIdentifier =
  typeof HtmlAdapterFactoryIdentifier | typeof MarkdownAdapterFactoryIdentifier;

interface AdapterConfig {
  identifier: AdapterFactoryIdentifier;
  fileExtension: string; // file extension need to be lower case with dot prefix, e.g. '.md', '.txt', '.html'
  contentType: string;
  indexFileName: string;
}

function getFirstMermaidSource(doc: Store) {
  const [block] = doc.getBlocksByFlavour("myoxus:mermaid" as never);
  if (block) return getMermaidBlockSource(block.model.props);

  throw new Error(
    "This document does not contain a first-class Mermaid block.",
  );
}

function getFirstMermaidStaticRenderSource(doc: Store) {
  const [block] = doc.getBlocksByFlavour("myoxus:mermaid" as never);
  if (block) {
    return projectMermaidExportRenderSource(
      getMermaidBlockSource(block.model.props),
      getMermaidBlockTitle(block.model.props),
    );
  }

  throw new Error(
    "This document does not contain a first-class Mermaid block.",
  );
}

function mermaidMarkdownFence(source: string) {
  return `\`\`\`mermaid\n${source.replaceAll("\r\n", "\n").trimEnd()}\n\`\`\`\n`;
}

function svgSize(svg: string) {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const svgElement = doc.documentElement;
  const width = Number.parseFloat(svgElement.getAttribute("width") ?? "");
  const height = Number.parseFloat(svgElement.getAttribute("height") ?? "");
  const viewBox = svgElement.getAttribute("viewBox")?.split(/\s+/).map(Number);

  if (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  ) {
    return { width, height };
  }
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    return { width: Math.max(1, viewBox[2]), height: Math.max(1, viewBox[3]) };
  }
  return { width: 1200, height: 800 };
}

async function svgToPngBlob(svg: string) {
  const { width, height } = svgSize(svg);
  const canvas = document.createElement("canvas");
  const scale = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("Canvas is not available for Mermaid PNG export.");

  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () =>
      reject(new Error("Failed to load Mermaid SVG for PNG export."));
    // Materialization already embeds fonts/assets. Chromium taints a canvas
    // for SVG foreignObject content loaded through a blob URL; a self-contained
    // data image preserves the existing native labels and remains exportable.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  context.scale(scale, scale);
  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("Failed to encode Mermaid PNG export.");
  return blob;
}

async function exportMermaidDoc(doc: Store, type: ExportType) {
  const source = getFirstMermaidSource(doc);
  const docTitle = normalizeMermaidExportFileName(
    doc.meta?.title || "Untitled",
  );

  switch (type) {
    case "mermaid-source":
      download(
        new Blob([source], { type: "text/plain;charset=utf-8" }),
        `${docTitle}.mmd`,
      );
      return;
    case "mermaid-markdown":
      download(
        new Blob([mermaidMarkdownFence(source)], {
          type: "text/markdown;charset=utf-8",
        }),
        `${docTitle}.md`,
      );
      return;
    case "mermaid-svg": {
      const { svg } = await renderMermaidSvg(
        getFirstMermaidStaticRenderSource(doc),
        {
          idPrefix: `myoxus-mermaid-export-${doc.id}`,
        },
      );
      if (!svg)
        throw new MermaidRenderSourceError(mermaidMessages.previewEmpty());
      download(
        new Blob([await materializeDiagramExportSvg(svg)], {
          type: "image/svg+xml;charset=utf-8",
        }),
        `${docTitle}.svg`,
      );
      return;
    }
    case "mermaid-png": {
      const { svg } = await renderMermaidSvg(
        getFirstMermaidStaticRenderSource(doc),
        {
          idPrefix: `myoxus-mermaid-export-${doc.id}`,
        },
      );
      if (!svg)
        throw new MermaidRenderSourceError(mermaidMessages.previewEmpty());
      download(
        await svgToPngBlob(await materializeDiagramExportSvg(svg)),
        `${docTitle}.png`,
      );
      return;
    }
  }
}

function pdfSourceSyncError(
  page: Store,
  phase: "document" | "edgeless-snapshot",
) {
  return Object.assign(
    new Error(
      phase === "document"
        ? "PDF export stopped because the document has not finished syncing yet. Please retry after the editor shows the latest changes."
        : "PDF export stopped because the edgeless canvas snapshot has not finished syncing yet. Please retry after the canvas state is saved.",
    ),
    {
      errorClass: "Unavailable",
      errorDetail:
        phase === "document"
          ? "pdf export source sync barrier did not complete before render dispatch"
          : "pdf export edgeless snapshot sync barrier did not complete before render dispatch",
      workspaceId: page.workspace.id,
      docId: page.id,
    },
  );
}

async function runServerPdfExportPreflight(
  page: Store,
  pageMode: "page" | "edgeless",
  workspace: CoreWorkspace,
  editorRoot: Element | null,
  workspaceDialogService: WorkspaceDialogService,
): Promise<boolean | void> {
  if (!(await waitForServerPdfSourceSync(page, workspace))) {
    throw pdfSourceSyncError(page, "document");
  }
  if (pageMode !== "edgeless" || !editorRoot) return;

  const canContinue = await (
    editorRoot as HTMLElement & { std: BlockStdScope }
  ).std
    .get(ExportManager)
    .captureEdgelessSnapshotForExport({
      confirmPreflight: (result) =>
        openEdgelessPreflightDialog(workspaceDialogService, result),
    });
  if (canContinue === false) return false;

  // Edgeless preflight writes snapshot metadata into the document; give the
  // websocket layer a chance to persist it before the server reads the doc.
  if (!(await waitForServerPdfSourceSync(page, workspace))) {
    throw pdfSourceSyncError(page, "edgeless-snapshot");
  }
}

async function exportDoc(
  doc: Store,
  std: BlockStdScope | undefined,
  config: AdapterConfig,
  embedProvider = std?.getOptional(DocEmbedProvider),
) {
  const referenceProjection =
    config.identifier === MarkdownAdapterFactoryIdentifier ||
    config.identifier === HtmlAdapterFactoryIdentifier
      ? await prepareMarkdownDocumentExport(doc, embedProvider ?? undefined)
      : undefined;
  const referenceMetas =
    referenceProjection?.metas ?? doc.workspace.meta.docMetas;
  const htmlEmbedDocs = new Map<string, Store>();
  if (config.identifier === HtmlAdapterFactoryIdentifier) {
    // HTML expands first-level embeds and reads only titles at the next level.
    // Cached Yjs is not access proof: use the same host-owned guard/load path
    // as the visible embed before exposing either body or title to the adapter.
    let sources = [doc];
    const signal = AbortSignal.timeout(PDF_SOURCE_SYNC_TIMEOUT_MS);
    for (let depth = 0; depth < 2; depth++) {
      const next: Store[] = [];
      for (const source of sources) {
        for (const { model } of source.getBlocksByFlavour(
          "myoxus:embed-synced-doc",
        )) {
          const props = (model as EmbedSyncedDocModel).props;
          // Foreign bodies are loaded and guarded by the scoped native matcher.
          if (
            props.workspaceId !== undefined &&
            props.workspaceId !== doc.workspace.id
          )
            continue;
          const id = props.pageId;
          if (typeof id !== "string" || !id)
            throw new Error("Document embed target missing");
          if (htmlEmbedDocs.has(id)) continue;
          if (!embedProvider)
            throw new Error("Document embed access unavailable");
          const permission = embedProvider.readable(id);
          await embedProvider.waitForLoaded(id, signal);
          if (permission.value !== true)
            throw new Error("Document embed access denied");
          const target = doc.workspace.getDoc(id)?.getStore({ id });
          if (!target?.root) throw new Error("Document embed target missing");
          htmlEmbedDocs.set(id, target);
          next.push(target);
        }
      }
      sources = next;
    }
  }
  using transformer = new Transformer({
    schema: getMyoxusWorkspaceSchema(),
    blobCRUD: doc.workspace.blobSync,
    docCRUD: {
      create: (id: string) => doc.workspace.createDoc(id).getStore({ id }),
      get: (id: string) => {
        if (config.identifier !== HtmlAdapterFactoryIdentifier)
          return doc.workspace.getDoc(id)?.getStore({ id }) ?? null;
        if (!htmlEmbedDocs.has(id)) return null;
        if (embedProvider?.readable(id).value !== true)
          throw new Error("Document embed access denied");
        return htmlEmbedDocs.get(id) ?? null;
      },
      delete: (id: string) => doc.workspace.removeDoc(id),
    },
    middlewares: [
      docLinkBaseURLMiddleware(doc.workspace.id),
      titleMiddleware(
        referenceMetas.filter((meta) => !("workspaceId" in meta)),
      ),
      documentReferenceMiddleware(
        referenceMetas,
        new Map(),
        undefined,
        referenceProjection
          ? {
              nativeTargets: referenceProjection.nativeTargets,
              currentDocumentId: doc.id,
            }
          : undefined,
      ),
      embedSyncedDocMiddleware(
        config.identifier === MarkdownAdapterFactoryIdentifier
          ? "reference"
          : "content",
      ),
    ],
  });

  const adapterFactory = doc.provider.get(config.identifier);
  const exportServices = new Container();
  if (embedProvider)
    exportServices.addImpl(DocEmbedProvider, () => embedProvider);
  const adapter = adapterFactory.get(
    transformer,
    exportServices.provider(undefined, std?.provider ?? doc.provider),
  );
  const result = (
    referenceProjection
      ? await adapter.fromDocSnapshot({
          snapshot: referenceProjection.snapshot,
          assets: transformer.assetsManager,
        })
      : await adapter.fromDoc(doc)
  ) as AdapterResult;

  if (!result || (!result.file && !result.assetsIds.length)) {
    return;
  }

  const docTitle =
    referenceProjection?.snapshot.meta.title || doc.meta?.title || "Untitled";
  const contentBlob = new Blob([result.file], { type: config.contentType });

  let downloadBlob: Blob;
  let name: string;

  if (result.assetsIds.length > 0) {
    if (!transformer.assets) {
      throw new Error("No assets found");
    }
    const zip = await createAssetsArchive(transformer.assets, result.assetsIds);
    await zip.file(config.indexFileName, contentBlob);
    downloadBlob = await zip.generate();
    name = `${docTitle}.zip`;
  } else {
    downloadBlob = contentBlob;
    name = `${docTitle}${config.fileExtension}`;
  }

  if (
    [...htmlEmbedDocs.keys()].some(
      (id) => embedProvider?.readable(id).value !== true,
    )
  )
    throw new Error("Document embed access denied");
  await referenceProjection?.assertReadable();
  download(downloadBlob, name);
  return adapter instanceof MarkdownAdapter
    ? adapter.exportDiagnostics
    : undefined;
}

async function exportToHtml(
  doc: Store,
  std?: BlockStdScope,
  access?: DocEmbedProvider,
) {
  await exportDoc(
    doc,
    std,
    {
      identifier: HtmlAdapterFactoryIdentifier,
      fileExtension: ".html",
      contentType: "text/html",
      indexFileName: "index.html",
    },
    access ?? std?.getOptional(DocEmbedProvider),
  );
}

async function exportToMarkdown(
  doc: Store,
  std?: BlockStdScope,
  access?: DocEmbedProvider,
) {
  const referenceAccess =
    access ?? std?.getOptional(DocEmbedProvider) ?? undefined;
  if (!std) {
    return (await MarkdownTransformer.exportDoc(doc, referenceAccess))
      ?.diagnostics;
  } else {
    return exportDoc(
      doc,
      std,
      {
        identifier: MarkdownAdapterFactoryIdentifier,
        fileExtension: ".md",
        contentType: "text/plain",
        indexFileName: "index.md",
      },
      referenceAccess,
    );
  }
}

/** Map a server error_class string to an i18n key. */
function pdfErrorI18nKey(
  errorClass: string | null | undefined,
  t: ReturnType<typeof useI18n>,
): { title: string; message: string } {
  switch (errorClass) {
    case "Unavailable":
      return {
        title: t["com.myoxus.export.pdf.error.unavailable"](),
        message: t["com.myoxus.export.pdf.error.unavailable"](),
      };
    case "PermissionDenied":
      return {
        title: t["com.myoxus.export.pdf.error.permission"](),
        message: t["com.myoxus.export.pdf.error.permission"](),
      };
    case "TemplateError":
      return {
        title: t["com.myoxus.export.pdf.error.template"](),
        message: t["com.myoxus.export.pdf.error.template"](),
      };
    case "Timeout":
      return {
        title: t["com.myoxus.export.pdf.error.timeout"](),
        message: t["com.myoxus.export.pdf.error.timeout"](),
      };
    case "TooLarge":
      return {
        title: t["com.myoxus.export.pdf.error.too-large"](),
        message: t["com.myoxus.export.pdf.error.too-large"](),
      };
    default:
      return {
        title: t["com.myoxus.export.pdf.error.generic"](),
        message: t["com.myoxus.export.pdf.error.generic"](),
      };
  }
}

async function exportHandler({
  page,
  type,
  editorContainer,
  graphqlService,
  workspaceDialogService,
  pageMode,
  workspace,
  guardService,
  docsService,
  returnFocusRef,
}: ExportHandlerOptions): Promise<
  | ServerPdfExportResult
  | { markdownDiagnostics?: MarkdownImportDiagnostics }
  | null
  | void
> {
  const editorRoot = document.querySelector("editor-host");
  track.$.sharePanel.$.export({
    type,
  });
  switch (type) {
    case "mermaid-source":
    case "mermaid-markdown":
    case "mermaid-svg":
    case "mermaid-png":
      await exportMermaidDoc(page, type);
      return;
    case "html": {
      // Export owns its subscriptions independently of editor mount/unmount.
      const access = new CoreDocEmbedProvider(
        guardService,
        docsService,
        workspace,
      );
      try {
        await exportToHtml(page, editorRoot?.std, access);
      } finally {
        access.dispose();
      }
      return;
    }
    case "markdown": {
      const access = new CoreDocEmbedProvider(
        guardService,
        docsService,
        workspace,
      );
      try {
        return {
          markdownDiagnostics: await exportToMarkdown(
            page,
            editorRoot?.std,
            access,
          ),
        };
      } finally {
        access.dispose();
      }
    }
    case "snapshot":
      await ZipTransformer.exportDocs(
        page.workspace,
        getMyoxusWorkspaceSchema(),
        [page],
        await exportWorkspaceLabels(workspace, [page.id]),
      );
      return;
    case "pdf":
      if (!editorContainer) {
        console.warn(
          "export: browser print skipped; editor container missing",
          {
            workspaceId: page.workspace.id,
            docId: page.id,
          },
        );
        return;
      }
      await printToPdf(editorContainer);
      return;
    case "png": {
      await editorRoot?.std.get(ExportManager).exportPng();
      return;
    }
    case "pdf-export": {
      let bootstrap;
      try {
        bootstrap = await loadPdfExportDialogBootstrap(
          graphqlService,
          page.workspace.id,
          page.id,
        );
      } catch (cause) {
        throw Object.assign(new Error("failed to load PDF export settings"), {
          cause,
          errorClass: "PdfExportBootstrapFailed",
        });
      }
      requireAssignedPdfTemplate(bootstrap);
      return await openPdfExportDialog(workspaceDialogService, {
        workspaceId: page.workspace.id,
        docId: page.id,
        docTitle: page.meta?.title ?? "Untitled",
        bootstrap,
        returnFocusRef,
        onBeforeStart: () =>
          runServerPdfExportPreflight(
            page,
            pageMode,
            workspace,
            editorRoot,
            workspaceDialogService,
          ),
      });
    }
  }
}

export const useExportPage = (
  returnFocusRef?: RefObject<HTMLElement | null>,
) => {
  const editor = useService(EditorService).editor;
  const graphqlService = useService(GraphQLService);
  const workspaceService = useService(WorkspaceService);
  const workspaceDialogService = useService(WorkspaceDialogService);
  const guardService = useService(GuardService);
  const docsService = useService(DocsService);
  const workspaceServerService = useService(WorkspaceServerService);
  const editorContainer = useLiveData(editor.editorContainer$);
  const editorMode = useLiveData(editor.mode$);
  const virgultumDoc = editor.doc.virgultumDoc;
  const pushGlobalLoadingEvent = useSetAtom(pushGlobalLoadingEventAtom);
  const resolveGlobalLoadingEvent = useSetAtom(resolveGlobalLoadingEventAtom);
  const t = useI18n();

  const onClickHandler = useAsyncCallback(
    async (type: ExportType) => {
      if (type === "docx") {
        track.$.sharePanel.$.export({ type });
        await startDocxExport(
          {
            page: virgultumDoc,
            pageMode: editorMode ?? "page",
            workspace: workspaceService.workspace,
            fetchService:
              workspaceServerService.server?.scope.get(FetchService),
          },
          returnFocusRef,
        );
        // DOCX owns its complete result, including neutral save cancellation.
        // It must never enter global loading or the generic success branch.
        return;
      }
      // Only the browser-print export path needs the mounted editor container.
      // Server PDF export opens its own dialog and performs a source-sync
      // preflight before rendering. Blocking it here made narrow Web layouts
      // unusable when the editor-container observable was not populated yet.
      if (type === "pdf" && editorContainer === null) {
        console.warn("export: browser print ignored before editor mount", {
          workspaceId: virgultumDoc.workspace.id,
          docId: virgultumDoc.id,
        });
        return;
      }

      const originEditorContainer =
        editorContainer === null
          ? null
          : // editor container is the typed MyoxusEditorContainer
            // adapter; .origin resolves to the underlying
            // HTMLDivElement (B-03).
            editorContainer.origin;

      const globalLoadingID = type === "pdf-export" ? null : nanoid();
      if (globalLoadingID) {
        pushGlobalLoadingEvent({
          key: globalLoadingID,
        });
      }
      try {
        const result = await exportHandler({
          page: virgultumDoc,
          type,
          editorContainer: originEditorContainer,
          graphqlService,
          workspaceDialogService,
          guardService,
          docsService,
          pageMode: editorMode ?? "page",
          workspace: workspaceService.workspace,
          returnFocusRef: returnFocusRef ?? {
            current:
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null,
          },
        });
        if (type === "pdf-export") {
          if (
            result === null ||
            (result && "saved" in result && !result.saved)
          ) {
            return;
          }
          notify.success({
            title: t["com.myoxus.export.pdf.success"](),
            message: t["com.myoxus.export.pdf.success"](),
          });
          const unmapped =
            result && "unmappedFontFamilies" in result
              ? (result.unmappedFontFamilies ?? [])
              : [];
          if (unmapped.length > 0) {
            notify.warning({
              title: t["com.myoxus.export.pdf.unmapped-fonts.title"](),
              message: t["com.myoxus.export.pdf.unmapped-fonts.message"]({
                families: unmapped.join(", "),
              }),
            });
          }
        } else {
          notify.success({
            title: t["com.myoxus.export.success.title"](),
            message: t["com.myoxus.export.success.message"](),
          });
          if (
            result &&
            "markdownDiagnostics" in result &&
            result.markdownDiagnostics &&
            hasMarkdownImportDiagnostics(result.markdownDiagnostics)
          ) {
            if (
              result.markdownDiagnostics.unsupportedAnnotations ||
              result.markdownDiagnostics.normalizedAnnotations
            )
              notify.warning({
                title: t["com.myoxus.markdown.annotation-diagnostics.title"](),
                message: t[
                  "com.myoxus.markdown.annotation-diagnostics.message"
                ]({
                  unsupported: String(
                    result.markdownDiagnostics.unsupportedAnnotations ?? 0,
                  ),
                  normalized: String(
                    result.markdownDiagnostics.normalizedAnnotations ?? 0,
                  ),
                }),
              });
            if (result.markdownDiagnostics.unsupportedCallouts)
              notify.warning({
                message: t["com.myoxus.markdown.callout-diagnostics"]({
                  count: String(result.markdownDiagnostics.unsupportedCallouts),
                }),
              });
            if (result.markdownDiagnostics.unsupportedTables)
              notify.warning({
                message: t["com.myoxus.markdown.table-diagnostics"]({
                  count: String(result.markdownDiagnostics.unsupportedTables),
                }),
              });
            if (result.markdownDiagnostics.unsupportedMath)
              notify.warning({
                message: t["com.myoxus.markdown.math-diagnostics"]({
                  count: String(result.markdownDiagnostics.unsupportedMath),
                }),
              });
            if (result.markdownDiagnostics.normalizedEndnotes)
              notify.warning({
                message: t["com.myoxus.markdown.endnote-diagnostics"]({
                  count: String(result.markdownDiagnostics.normalizedEndnotes),
                }),
              });
          }
        }
      } catch (err: any) {
        if (type === "pdf-export") {
          if (err?.errorClass === "WorkspaceConfigurationRequired") {
            notify.warning({
              title:
                t[
                  "com.myoxus.pdf-export.dialog.empty.no-templates.notice-title"
                ](),
              message:
                t["com.myoxus.pdf-export.dialog.empty.no-templates.body"](),
            });
          } else if (err?.errorClass === "PdfExportBootstrapFailed") {
            notify.error({
              title: t["com.myoxus.pdf-export.dialog.error.load-settings"](),
              message: t["com.myoxus.export.pdf.error.unavailable"](),
            });
          } else {
            console.error(err);
            const { title, message } = pdfErrorI18nKey(err?.errorClass, t);
            notify.error({ title, message });
          }
        } else if (err instanceof MermaidRenderSourceError) {
          notify.error({
            title: t["com.myoxus.export.error.title"](),
            message: err.message,
          });
        } else {
          console.error(err);
          notify.error({
            title: t["com.myoxus.export.error.title"](),
            message: t["com.myoxus.export.error.message"](),
          });
        }
      } finally {
        if (globalLoadingID) {
          resolveGlobalLoadingEvent(globalLoadingID);
        }
      }
    },
    [
      virgultumDoc,
      editorContainer,
      editorMode,
      pushGlobalLoadingEvent,
      resolveGlobalLoadingEvent,
      graphqlService,
      workspaceService.workspace,
      workspaceDialogService,
      guardService,
      docsService,
      workspaceServerService,
      returnFocusRef,
      t,
    ],
  );

  return onClickHandler;
};

export const __test__ = {
  exportMermaidDoc,
  PDF_SOURCE_SYNC_TIMEOUT_MS,
  getFirstMermaidSource,
  mermaidMarkdownFence,
  normalizeExportFileName: normalizeMermaidExportFileName,
  pdfSourceSyncError,
  runServerPdfExportPreflight,
  svgSize,
  waitForServerPdfSourceSync,
  exportToMarkdown,
  exportToHtml,
};
