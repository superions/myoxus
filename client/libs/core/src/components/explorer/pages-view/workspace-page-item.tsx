import { useLiveData } from "@myoxus/infra";
import { memo, useContext, useMemo } from "react";

import { parseWorkspacePageKey } from "../../../modules/workspace-pages/identity";
import { DocExplorerContext } from "../context";
import { DocListItem } from "../docs-view/doc-list-item";
import type { ExplorerItemComponentProps } from "../explorer-items-view";
import { DatabasePageItem } from "./database-page-item";
import { WorkspacePagesExplorerContext } from "./context";

/** Dispatch a typed mixed Page key without teaching document items about Databases. */
export const WorkspacePageItem = memo(function WorkspacePageItem({
  groupId,
  itemId,
  inventoryPreview,
}: ExplorerItemComponentProps) {
  const identity = parseWorkspacePageKey(itemId);
  if (!identity) return null;
  return identity.kind === "database" ? (
    <DatabasePageItem itemId={itemId} groupId={groupId} />
  ) : (
    <DocumentWorkspacePageItem
      documentId={identity.id}
      groupId={groupId}
      itemId={itemId}
      inventoryPreview={inventoryPreview}
    />
  );
});

function DocumentWorkspacePageItem({
  documentId,
  groupId,
  itemId,
  inventoryPreview,
}: {
  documentId: string;
  groupId: string;
  itemId: string;
  inventoryPreview?: "grid" | "masonry";
}) {
  const pagesContext = useContext(WorkspacePagesExplorerContext);
  const explorerContext = useContext(DocExplorerContext);
  const selectedItemKeys = useLiveData(explorerContext.selectedItemKeys$);
  const selectedDocumentIds = useMemo(
    () =>
      selectedItemKeys.flatMap((key) => {
        const selectedIdentity = parseWorkspacePageKey(key);
        return selectedIdentity?.kind === "document"
          ? [selectedIdentity.id]
          : [];
      }),
    [selectedItemKeys],
  );

  return (
    <DocListItem
      docId={documentId}
      inventoryPreview={inventoryPreview}
      groupId={groupId}
      selectionKey={itemId}
      dragSelectionDocIds={selectedDocumentIds}
      selectionGroups={pagesContext?.groups.map((group) => ({
        key: group.key,
        items: [...group.items],
      }))}
    />
  );
}
