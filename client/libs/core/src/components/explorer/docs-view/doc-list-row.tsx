// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DocsService } from "@myoxus/core/modules/doc";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  ContextMenu,
  SurfaceListItem,
  SurfaceListItemMain,
  SurfaceListSpacer,
  Tooltip,
  useResponsiveElementSize,
} from "@myoxus/ui-facade";
import { useContext } from "react";

import { DocExplorerContext } from "../context";
import { listQuickActions } from "../quick-actions.constants";
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
import { type DocListDensity, ListViewProperties } from "./properties";
import { AllDocsPublicStatusAction } from "./public-status-action";

export const ListViewDoc = ({
  docId,
  groupId,
  selectionKey,
}: DocListItemProps) => {
  const t = useI18n();
  const doc = useLiveData(useService(DocsService).list.doc$(docId));
  const context = useContext(DocExplorerContext);
  const showMoreOperation = useLiveData(context.showMoreOperation$);
  const displayPreference = useLiveData(context.displayPreference$);
  const selectedKeys = useLiveData(
    selectionKey ? context.selectedItemKeys$ : context.selectedDocIds$,
  );

  const { ref: rowRef, width: rowWidth } =
    useResponsiveElementSize<HTMLDivElement>();
  const density: DocListDensity =
    rowWidth > 0 && rowWidth <= 560
      ? "compact"
      : rowWidth > 0 && rowWidth <= 750
        ? "medium"
        : "regular";

  if (!doc) {
    return null;
  }

  return (
    <ContextMenu
      asChild
      disabled={!showMoreOperation}
      items={<MoreMenuContent docId={docId} />}
    >
      <SurfaceListItem
        ref={rowRef}
        data-list-density={density}
        component="div"
        density="compact"
        fullHeight
        fullWidth
        interactive
        layout="row"
        alignItems="center"
        role="presentation"
        selected={selectedKeys.includes(selectionKey ?? docId)}
      >
        <DocDragHandle id={docId} />
        <DocSelectionCheckbox
          groupId={groupId}
          id={docId}
          selectionKey={selectionKey}
          visible
        />
        <DocIcon id={docId} size="md" />
        <SurfaceListItemMain compact={density === "compact"} grow>
          <DocTitle
            id={docId}
            data-myoxus-ui-role="doc-list-title"
            data-testid="doc-list-item-title"
          />
          <DocPreview id={docId} />
        </SurfaceListItemMain>
        <SurfaceListSpacer />
        <ListViewProperties density={density} docId={docId} />
        <AllDocsPublicStatusAction docId={docId} />
        {listQuickActions
          .filter((action) => displayPreference?.[action.key])
          .map((action) => (
            <Tooltip key={action.key} content={t.t(action.name)}>
              <action.Component
                aria-label={t.t(action.name)}
                doc={doc}
                size="small"
              />
            </Tooltip>
          ))}
        <MoreMenuButton
          docId={docId}
          contentOptions={EXPLORER_MORE_MENU_OFFSET}
          iconProps={{ size: "small" }}
        />
      </SurfaceListItem>
    </ContextMenu>
  );
};
