import type { NodeOperation } from "@myoxus/core/components/structure-tree";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { type Tag, TagService } from "@myoxus/core/modules/tag";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService, useServices } from "@myoxus/infra";
import { StructureTreeColorIcon } from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import { AddItemPlaceholder } from "../../layouts/add-item-placeholder";
import { StructureTreeNode } from "../../tree/node";
import { StructureTreeDocNode } from "../doc";
import {
  useStructureTreeTagNodeOperations,
  useStructureTreeTagNodeOperationsMenu,
} from "./operations";

export const StructureTreeTagNode = ({
  tagId,
  operations: additionalOperations,
  parentPath,
}: {
  tagId: string;
  operations?: NodeOperation[];
  parentPath: string[];
}) => {
  const t = useI18n();
  const { tagService, globalContextService } = useServices({
    TagService,
    GlobalContextService,
  });
  const structureTreeStateService = useService(StructureTreeStateService);
  const active =
    useLiveData(globalContextService.globalContext.tagId.$) === tagId;
  const path = useMemo(
    () => [...parentPath, `tag-${tagId}`],
    [parentPath, tagId],
  );
  const collapsed = useLiveData(structureTreeStateService.collapsed$(path));
  const setCollapsed = useCallback(
    (value: boolean) => {
      structureTreeStateService.setCollapsed(path, value);
    },
    [structureTreeStateService, path],
  );

  const tagRecord = useLiveData(tagService.tagList.tagByTagId$(tagId));
  const tagColor = useLiveData(tagRecord?.color$);
  const tagName = useLiveData(tagRecord?.value$);

  const Icon = useCallback(
    ({ className }: { className?: string }) => {
      return <StructureTreeColorIcon className={className} color={tagColor} />;
    },
    [tagColor],
  );

  const option = useMemo(
    () => ({
      openNodeCollapsed: () => setCollapsed(false),
    }),
    [setCollapsed],
  );
  const operations = useStructureTreeTagNodeOperationsMenu(tagId, option);
  const { handleNewDoc } = useStructureTreeTagNodeOperations(tagId, option);

  const finalOperations = useMemo(() => {
    if (additionalOperations) {
      return [...operations, ...additionalOperations];
    }
    return operations;
  }, [additionalOperations, operations]);

  if (!tagRecord) {
    return null;
  }

  return (
    <StructureTreeNode
      icon={Icon}
      name={tagName || t["Untitled"]()}
      collapsed={collapsed}
      setCollapsed={setCollapsed}
      to={`/tag/${tagId}`}
      active={active}
      operations={finalOperations}
      data-testid={`structure-tree-tag-${tagId}`}
      aria-label={tagName}
      data-role="structure-tree-tag"
    >
      <StructureTreeTagNodeDocs
        tag={tagRecord}
        onNewDoc={handleNewDoc}
        path={path}
      />
    </StructureTreeNode>
  );
};

/**
 * the `tag.pageIds$` has a performance issue,
 * so we split the tag node children into a separate component,
 * so it won't be rendered when the tag node is collapsed.
 */
export const StructureTreeTagNodeDocs = ({
  tag,
  onNewDoc,
  path,
}: {
  tag: Tag;
  onNewDoc?: () => void;
  path: string[];
}) => {
  const t = useI18n();
  const tagDocIds = useLiveData(tag.pageIds$);

  return (
    <>
      {tagDocIds.map((docId) => (
        <StructureTreeDocNode key={docId} docId={docId} parentPath={path} />
      ))}
      <AddItemPlaceholder label={t["New Page"]()} onClick={onNewDoc} />
    </>
  );
};
