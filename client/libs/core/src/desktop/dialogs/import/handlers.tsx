// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { getStoreManager } from "@myoxus/core/editor/manager/store";
import type { DocxImportAttempt } from "@myoxus/core/modules/doc/services/docs";
import type { ExplorerIconService } from "@myoxus/core/modules/explorer-icon/services/explorer-icon";
import type { MermaidDiagramsService } from "@myoxus/core/modules/mermaid-diagrams";
import {
  type BpmnImportResult,
  prepareBpmnImport,
  runBpmnImport,
} from "@myoxus/core/modules/mermaid-diagrams/services/bpmn-import";
import type { OrganizeService } from "@myoxus/core/modules/organize";
import {
  getMyoxusWorkspaceSchema,
  type WorkspaceMetadata,
} from "@myoxus/core/modules/workspace";
import {
  ArchiveRestoreIcon,
  FileIconDocxIcon,
  FileIconHtmlIcon,
  FileIconMdIcon,
  FileIconZipIcon,
  WorkflowIcon,
} from "@myoxus/icons/react";
import {
  HtmlTransformer,
  MarkdownTransformer,
  type SnapshotImportHooks,
  ZipTransformer,
} from "@virgultum/editor/interchange";
import {
  emptyMarkdownImportDiagnostics,
  type MarkdownImportDiagnostics,
} from "@virgultum/editor/shared/adapters";
import type { DocEmbedProvider } from "@virgultum/editor/shared/services";
import type { Workspace } from "@virgultum/editor/store";
import type { ReactElement, SVGAttributes } from "react";

export type ImportType =
  | "markdown"
  | "mermaid"
  | "bpmn"
  | "markdownZip"
  | "snapshot"
  | "html"
  | "docx"
  | "workspace";

export type ImportAcceptType =
  "Markdown" | "Mermaid" | "Bpmn" | "Zip" | "Html" | "Docx" | "Skip";

export type ImportStatus = "idle" | "importing" | "success" | "error";

export type ImportResult = {
  docIds: string[];
  docx?: Extract<DocxImportAttempt, { status: "complete" }>;
  bpmn?: BpmnImportResult;
  markdownDiagnostics?: MarkdownImportDiagnostics;
  entryId?: string;
  isWorkspaceFile?: boolean;
  rootFolderId?: string;
};

export interface ImportOptionDescriptor {
  key: ImportType;
  label: string;
  prefixIcon: ReactElement<SVGAttributes<SVGElement>>;
  testId: string;
  type: ImportType;
}

export const IMPORT_FORMAT_OPTIONS: readonly ImportOptionDescriptor[] = [
  {
    key: "bpmn",
    label: "com.myoxus.editor.bpmn.slash-name",
    prefixIcon: <WorkflowIcon />,
    testId: "editor-option-menu-import-bpmn",
    type: "bpmn",
  },
  {
    key: "markdown",
    label: "com.myoxus.import.markdown-files",
    prefixIcon: <FileIconMdIcon />,
    testId: "editor-option-menu-import-markdown-files",
    type: "markdown",
  },
  {
    key: "mermaid",
    label: "Mermaid diagrams (.mmd)",
    prefixIcon: <FileIconMdIcon />,
    testId: "editor-option-menu-import-mermaid",
    type: "mermaid",
  },
  {
    key: "markdownZip",
    label: "com.myoxus.import.markdown-with-media-files",
    prefixIcon: <FileIconZipIcon />,
    testId: "editor-option-menu-import-markdown-with-media",
    type: "markdownZip",
  },
  {
    key: "html",
    label: "com.myoxus.import.html-files",
    prefixIcon: <FileIconHtmlIcon />,
    testId: "editor-option-menu-import-html",
    type: "html",
  },
  {
    key: "docx",
    label: "com.myoxus.import.docx",
    prefixIcon: <FileIconDocxIcon />,
    testId: "editor-option-menu-import-docx",
    type: "docx",
  },
  {
    key: "snapshot",
    label: "com.myoxus.import.snapshot",
    prefixIcon: <ArchiveRestoreIcon />,
    testId: "editor-option-menu-import-snapshot",
    type: "snapshot",
  },
  {
    key: "workspace",
    label: "com.myoxus.cmdk.import-workspace",
    prefixIcon: <ArchiveRestoreIcon />,
    testId: "editor-option-menu-import-workspace",
    type: "workspace",
  },
];

const FILE_PICKER_OPTIONS: Record<
  ImportType,
  { acceptType: ImportAcceptType; multiple: boolean }
> = {
  bpmn: { acceptType: "Bpmn", multiple: true },
  markdown: { acceptType: "Markdown", multiple: true },
  mermaid: { acceptType: "Mermaid", multiple: true },
  markdownZip: { acceptType: "Zip", multiple: false },
  html: { acceptType: "Html", multiple: true },
  docx: { acceptType: "Docx", multiple: false },
  snapshot: { acceptType: "Zip", multiple: false },
  workspace: { acceptType: "Skip", multiple: false },
};

const OPTIONAL_MD_DIAGNOSTIC_KEYS = [
  "unsupportedAnnotations",
  "normalizedAnnotations",
  "unsupportedCallouts",
  "unsupportedMath",
  "unsupportedTables",
] as const;

export function getImportFileOptions(type: ImportType) {
  return FILE_PICKER_OPTIONS[type];
}

export function inferDroppedImportType(files: File[]): ImportType | null {
  const first = files[0];
  if (!first) return null;
  const name = first.name.toLowerCase();
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
  if (name.endsWith(".mmd") || name.endsWith(".mermaid")) return "mermaid";
  if (name.endsWith(".bpmn")) return "bpmn";
  if (name.endsWith(".html") || name.endsWith(".htm")) return "html";
  return null;
}

function stripFileExtension(fileName: string): string {
  return fileName.split(".").slice(0, -1).join(".");
}

export interface RunFormatImportContext {
  docCollection: Workspace;
  files: File[];
  handleImportWorkspace: () => Promise<WorkspaceMetadata | undefined>;
  organizeService?: OrganizeService;
  explorerIconService?: ExplorerIconService;
  snapshotHooks?: SnapshotImportHooks;
  referenceAccess?: DocEmbedProvider;
  diagramRegistry?: MermaidDiagramsService;
}

export async function runFormatImport(
  type: Exclude<ImportType, "docx">,
  ctx: RunFormatImportContext,
): Promise<ImportResult> {
  switch (type) {
    case "bpmn": {
      if (!ctx.diagramRegistry) {
        throw new Error("DIAGRAM_REGISTRY_UNAVAILABLE");
      }
      const bpmn = await runBpmnImport(
        ctx.diagramRegistry,
        await prepareBpmnImport(ctx.files),
      );
      return { docIds: bpmn.docIds, bpmn };
    }

    case "markdown": {
      const docIds: string[] = [];
      const markdownDiagnostics = emptyMarkdownImportDiagnostics();
      const extensions = getStoreManager().config.init().value.get("store");
      const schema = getMyoxusWorkspaceSchema();

      for (const file of ctx.files) {
        const markdown = await file.text();
        const { docId, diagnostics } =
          await MarkdownTransformer.importMarkdownToDoc({
            collection: ctx.docCollection,
            schema,
            markdown,
            fileName: stripFileExtension(file.name),
            extensions,
            access: ctx.referenceAccess,
          });
        markdownDiagnostics.unresolvedReferences +=
          diagnostics.unresolvedReferences;
        markdownDiagnostics.unsupportedReferences +=
          diagnostics.unsupportedReferences;
        for (const key of OPTIONAL_MD_DIAGNOSTIC_KEYS) {
          if (diagnostics[key]) {
            markdownDiagnostics[key] =
              (markdownDiagnostics[key] ?? 0) + diagnostics[key];
          }
        }
        if (docId) docIds.push(docId);
      }

      return { docIds, markdownDiagnostics };
    }

    case "mermaid": {
      const { importMermaidFilesToDocs } =
        await import("@myoxus/core/modules/mermaid-diagrams/services/mermaid-import");
      return {
        docIds: await importMermaidFilesToDocs({
          collection: ctx.docCollection,
          files: ctx.files,
        }),
      };
    }

    case "markdownZip": {
      const file = ctx.files.length === 1 ? ctx.files[0] : null;
      if (!file) {
        throw new Error("Expected a single zip file for markdownZip import");
      }
      const { docIds, diagnostics: markdownDiagnostics } =
        await MarkdownTransformer.importMarkdownZip({
          collection: ctx.docCollection,
          schema: getMyoxusWorkspaceSchema(),
          imported: file,
          extensions: getStoreManager().config.init().value.get("store"),
          access: ctx.referenceAccess,
        });
      return { docIds, markdownDiagnostics };
    }

    case "html": {
      const docIds: string[] = [];
      const extensions = getStoreManager().config.init().value.get("store");
      const schema = getMyoxusWorkspaceSchema();
      for (const file of ctx.files) {
        const html = await file.text();
        const docId = await HtmlTransformer.importHTMLToDoc({
          collection: ctx.docCollection,
          schema,
          extensions,
          html,
          fileName: stripFileExtension(file.name),
        });
        if (docId) docIds.push(docId);
      }
      return { docIds };
    }

    case "snapshot": {
      const file = ctx.files.length === 1 ? ctx.files[0] : null;
      if (!file) {
        throw new Error("Expected a single zip file for snapshot import");
      }
      const docs = await ZipTransformer.importDocs(
        ctx.docCollection,
        getMyoxusWorkspaceSchema(),
        file,
        ctx.snapshotHooks,
      );
      return {
        docIds: docs
          .filter((doc): doc is NonNullable<typeof doc> => doc !== undefined)
          .map((doc) => doc.id),
      };
    }

    case "workspace": {
      await ctx.handleImportWorkspace();
      return {
        docIds: [],
        entryId: undefined,
        isWorkspaceFile: true,
      };
    }
  }
}
