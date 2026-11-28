// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DocsService } from "@myoxus/core/modules/doc";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { useI18n } from "@myoxus/i18n";
import { ViewIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  ContextMenu,
  Group,
  IconButton,
  SurfaceListCardHeader,
  SurfaceListItem,
  Tooltip,
} from "@myoxus/ui-facade";
import { useContext, useMemo } from "react";

import { DocExplorerContext } from "../context";
import { quickActions } from "../quick-actions.constants";
import {
  DocDragHandle,
  DocIcon,
  type DocListItemProps,
  DocPreview,
  DocSelectionCheckbox,
  DocTitle,
  EXPLORER_MORE_MENU_OFFSET,
} from "./doc-list-primitives";
import { MoreMenuButton, MoreMenuContent } from "./more-menu";
import { CardViewProperties } from "./properties";
import { AllDocsPublicStatusAction } from "./public-status-action";

export const CardViewDoc = ({
  docId,
  groupId,
  selectionKey,
  inventoryPreview,
  onReading,
}: DocListItemProps & { onReading?: (element: HTMLElement) => void }) => {
  const t = useI18n();
  const context = useContext(DocExplorerContext);
  const selectMode = useLiveData(context.selectMode$);
  const selectedKeys = useLiveData(
    selectionKey ? context.selectedItemKeys$ : context.selectedDocIds$,
  );
  const showMoreOperation = useLiveData(context.showMoreOperation$);
  const displayPreference = useLiveData(context.displayPreference$);

  const docsService = useService(DocsService);
  const metadataCache = useService(DocumentMetadataCacheService);
  const doc = useLiveData(docsService.list.doc$(docId));
  const mode$ = useMemo(
    () => docsService.list.primaryMode$(docId),
    [docId, docsService],
  );
  useLiveData(mode$);

  const indexState = useLiveData(metadataCache.watchIndexState());
  const indexRow =
    indexState.phase === "ready"
      ? metadataCache.getIndexRowByExternalId(docId)
      : undefined;
  const isPageMode =
    Boolean(indexRow) &&
    (docsService.list.getPrimaryMode(docId) ??
      indexRow?.primaryMode ??
      "page") === "page";

  if (!doc) {
    return null;
  }

  const previewNode = (
    <DocPreview
      edgelessFallback={t["com.myoxus.edgelessMode"]()}
      emptyFallback={t["com.myoxus.selectPage.empty"]()}
      enableLocalTextFallback
      id={docId}
      kind="preview"
      inventoryPreview={inventoryPreview}
    />
  );

  const actionControls = (
    <>
      {inventoryPreview && isPageMode && !selectMode && onReading ? (
        <IconButton
          data-myoxus-ui-role="document-reading-action"
          icon={<ViewIcon />}
          tooltip={t["com.myoxus.editor.toolbar.preview"]()}
          aria-label={t["com.myoxus.editor.toolbar.preview"]()}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onReading(event.currentTarget);
          }}
        />
      ) : null}
      <AllDocsPublicStatusAction docId={docId} />
      {quickActions
        .filter((action) => displayPreference?.[action.key])
        .map((action) => (
          <Tooltip key={action.key} content={t.t(action.name)}>
            <action.Component aria-label={t.t(action.name)} doc={doc} />
          </Tooltip>
        ))}
      {selectMode ? (
        <DocSelectionCheckbox
          groupId={groupId}
          id={docId}
          selectionKey={selectionKey}
        />
      ) : (
        <MoreMenuButton
          docId={docId}
          contentOptions={EXPLORER_MORE_MENU_OFFSET}
        />
      )}
    </>
  );

  return (
    <ContextMenu
      asChild
      disabled={!showMoreOperation}
      items={<MoreMenuContent docId={docId} />}
    >
      <SurfaceListItem
        appearance="card"
        component="div"
        density="card"
        fullHeight
        fullWidth
        interactive
        layout="column"
        role="presentation"
        selected={selectedKeys.includes(selectionKey ?? docId)}
      >
        <DocDragHandle id={docId} placement="outside-left-top" />
        {inventoryPreview ? (
          <>
            {previewNode}
            <SurfaceListCardHeader>
              <DocTitle
                id={docId}
                kind="card-title"
                lineClamp={2}
                truncate={false}
                data-myoxus-ui-role="doc-card-title"
                data-testid="doc-list-item-title"
              />
            </SurfaceListCardHeader>
            <Group justify="space-between" wrap="wrap">
              <Group wrap="wrap">
                <DocIcon id={docId} />
                <CardViewProperties docId={docId} />
              </Group>
              <Group wrap="nowrap">{actionControls}</Group>
            </Group>
          </>
        ) : (
          <>
            <SurfaceListCardHeader>
              <DocIcon id={docId} />
              <DocTitle
                id={docId}
                kind="card-title"
                data-myoxus-ui-role="doc-card-title"
                data-testid="doc-list-item-title"
              />
              {actionControls}
            </SurfaceListCardHeader>
            {previewNode}
            <CardViewProperties docId={docId} />
          </>
        )}
      </SurfaceListItem>
    </ContextMenu>
  );
};
