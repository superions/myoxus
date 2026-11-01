import { getArtworkUrl } from "@myoxus/theme/artwork";
import { useWorkspaceTagCommands } from "@myoxus/core/components/tags";
import { TagService } from "@myoxus/core/modules/tag";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { inferOpenMode } from "@myoxus/core/utils";
import { useI18n } from "@myoxus/i18n";
import { AllDocsIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { type MouseEvent, useCallback } from "react";

import { usePageHelper } from "../../../editor/virgultum/page-list/utils";
import { ActionButton } from "./action-button";
import { EmptyLayout } from "./layout";
import type { UniversalEmptyProps } from "./types";

export interface EmptyDocsProps extends UniversalEmptyProps {
  type?: "all" | "trash";
  /**
   * Used for "New doc", if provided, new doc will be created with this tag.
   */
  tagId?: string;
  allowCreate?: boolean;
}

export const EmptyDocs = ({
  type = "all",
  tagId,
  allowCreate = true,
  ...props
}: EmptyDocsProps) => {
  const t = useI18n();
  const tagCommands = useWorkspaceTagCommands();
  const tagService = useService(TagService);
  const currentWorkspace = useService(WorkspaceService).workspace;
  const pageHelper = usePageHelper(currentWorkspace.docCollection);
  const tag = useLiveData(tagService.tagList.tagByTagId$(tagId));
  const tagArchived = useLiveData(tag?.archived$);
  const catalogState = useLiveData(tagService.tagList.catalogState$);
  const canAssignTag =
    !tagId || (catalogState.status === "ready" && Boolean(tag) && !tagArchived);

  const showActionButton = type !== "trash"; // && !BUILD_CONFIG.isMobileEdition;

  const onCreate = useCallback(
    async (e: MouseEvent) => {
      if (!canAssignTag) {
        return;
      }
      const doc = pageHelper.createPage(undefined, {
        at: inferOpenMode(e),
      });

      try {
        if (tag) await tag.tag(doc.id);
      } catch (error) {
        tagCommands.reportError(error);
      }
    },
    [canAssignTag, pageHelper, tag, tagCommands],
  );

  return (
    <EmptyLayout
      illustrationLight={getArtworkUrl("documents")}
      title={t["com.myoxus.empty.docs.title"]()}
      description={
        type === "trash"
          ? t["com.myoxus.empty.docs.trash-description"]()
          : t["com.myoxus.empty.docs.all-description"]()
      }
      action={
        allowCreate && showActionButton ? (
          <ActionButton
            disabled={!canAssignTag}
            onClick={onCreate}
            prefix={<AllDocsIcon />}
          >
            {t["com.myoxus.empty.docs.action.new-doc"]()}
          </ActionButton>
        ) : null
      }
      {...props}
    />
  );
};
