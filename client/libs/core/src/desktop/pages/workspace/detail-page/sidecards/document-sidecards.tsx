// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT

import { ViewContextSurface } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import {
  ExportToPdfIcon,
  HistoryIcon,
  InfoIcon,
  TagsIcon,
  TreePanelIcon,
} from "@myoxus/icons/react";
import { DetailPageContextScrollRoot, Scrollable } from "@myoxus/ui-facade";
import type { EditorHost } from "@virgultum/editor/std";

import {
  DocumentInfoToolBody,
  DocumentOutlineToolBody,
  DocumentPdfExportsToolBody,
  DocumentToolContentProvider,
  DocumentVersionsToolBody,
} from "../context/document-context-overview";
import { DocumentTagsSidecard } from "../context/document-tags-sidecard";

const DOCUMENT_PAGE_VIEW_FAMILY = ["document-page"] as const;
const DOCUMENT_VIEW_FAMILIES = ["document-page", "document-edgeless"] as const;

/**
 * Owns the document-specific cards and scopes their shared metadata/versioning
 * services to those cards instead of the complete editor route.
 */
export function DocumentSidecards({
  docId,
  docTitle,
  editor,
  mode,
  readonly,
  workspaceId,
}: {
  docId: string;
  docTitle: string;
  editor: EditorHost | null;
  mode: "page" | "edgeless";
  readonly: boolean;
  workspaceId: string;
}) {
  const t = useI18n();

  return (
    <DocumentToolContentProvider
      docId={docId}
      docTitle={docTitle}
      editor={editor}
      workspaceId={workspaceId}
    >
      {mode === "page" ? (
        <>
          <ViewContextSurface
            surfaceId="outline"
            order={10}
            label={t["com.myoxus.structureTree.sidebar.title"]()}
            tooltip={t["com.myoxus.structureTree.sidebar.title"]()}
            icon={<TreePanelIcon />}
            viewFamilies={DOCUMENT_PAGE_VIEW_FAMILY}
          >
            <DocumentOutlineToolBody />
          </ViewContextSurface>
          <ViewContextSurface
            surfaceId="tags"
            order={15}
            label={t["Tags"]()}
            tooltip={t["Tags"]()}
            icon={<TagsIcon />}
            viewFamilies={DOCUMENT_PAGE_VIEW_FAMILY}
          >
            <DocumentTagsSidecard docId={docId} readonly={readonly} />
          </ViewContextSurface>
          <ViewContextSurface
            surfaceId="document-info"
            order={20}
            label={t["com.myoxus.document-metadata.tab.information"]()}
            tooltip={t["com.myoxus.document-metadata.tab.information"]()}
            icon={<InfoIcon />}
            viewFamilies={DOCUMENT_PAGE_VIEW_FAMILY}
          >
            <DetailPageContextScrollRoot>
              <Scrollable.Viewport>
                <DocumentInfoToolBody />
              </Scrollable.Viewport>
              <Scrollable.Scrollbar />
            </DetailPageContextScrollRoot>
          </ViewContextSurface>
        </>
      ) : null}
      <ViewContextSurface
        surfaceId="activity"
        order={50}
        label={t["com.myoxus.history.version-history"]()}
        tooltip={t["com.myoxus.history.version-history"]()}
        icon={<HistoryIcon />}
        viewFamilies={DOCUMENT_VIEW_FAMILIES}
      >
        <DetailPageContextScrollRoot>
          <Scrollable.Viewport>
            <DocumentVersionsToolBody />
          </Scrollable.Viewport>
          <Scrollable.Scrollbar />
        </DetailPageContextScrollRoot>
      </ViewContextSurface>
      <ViewContextSurface
        surfaceId="export"
        order={55}
        label={t["com.myoxus.sidebar.pdf-exports.title"]()}
        tooltip={t["com.myoxus.sidebar.pdf-exports.description"]()}
        icon={<ExportToPdfIcon />}
        viewFamilies={DOCUMENT_VIEW_FAMILIES}
      >
        <DetailPageContextScrollRoot>
          <Scrollable.Viewport>
            <DocumentPdfExportsToolBody />
          </Scrollable.Viewport>
          <Scrollable.Scrollbar />
        </DetailPageContextScrollRoot>
      </ViewContextSurface>
    </DocumentToolContentProvider>
  );
}
