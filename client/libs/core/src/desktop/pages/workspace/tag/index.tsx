/**
 * Tag detail page — shows all documents associated with a specific tag.
 *
 * Subscribes to `CollectionRulesService` with a filter for `tags include-all
 * <tagId>` to get a live-updating, sorted and grouped document list for the
 * tag. Trash and empty-journal documents are always excluded.
 *
 * While this view is active it sets `globalContext.tagId` and
 * `globalContext.isTag = true` so that the command palette and other features
 * can contextualise their behaviour.
 *
 * Shows `<WorkbenchRouteNotFound>` when the tag ID in the URL is not found in the
 * workspace tag list.
 */
import { getDatabaseWorkspaceAvailability } from "@myoxus/core/modules/database/availability";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { TagService } from "@myoxus/core/modules/tag";
import { TagDetailHeader } from "@myoxus/core/modules/tag/view/tag-detail-header";
import { TagUsageList } from "@myoxus/core/modules/tag/view/tag-usage-list";
import {
  useIsActiveView,
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { PageContentRail } from "@myoxus/ui-facade";
import { useEffect } from "react";
import { useParams } from "react-router";

import { WorkbenchRouteNotFound } from "../../404";

/**
 * Tag detail view component.
 *
 * Renders the document list for a single tag. Uses `CollectionRulesService`
 * to compute the matching documents reactively. Shows an empty-state list when
 * no documents carry the tag, or `<WorkbenchRouteNotFound>` when the tag itself is
 * missing.
 *
 * @param tagId - The workspace-scoped tag identifier from the URL params.
 */
export const TagDetail = ({ tagId }: { tagId?: string }) => {
  const t = useI18n();
  const globalContext = useService(GlobalContextService).globalContext;
  const workspace = useService(WorkspaceService).workspace;
  const workspaceId =
    getDatabaseWorkspaceAvailability(workspace).serverWorkspaceId;

  const tagList = useService(TagService).tagList;
  const currentTag = useLiveData(tagList.tagByTagId$(tagId));

  const isActiveView = useIsActiveView();
  const tagName = useLiveData(currentTag?.value$);

  useEffect(() => {
    if (isActiveView && currentTag) {
      globalContext.tagId.set(currentTag.id);
      globalContext.isTag.set(true);

      return () => {
        globalContext.tagId.set(null);
        globalContext.isTag.set(false);
      };
    }
    return;
  }, [currentTag, globalContext, isActiveView]);

  if (!currentTag || !tagId) {
    return <WorkbenchRouteNotFound />;
  }

  return (
    <>
      <ViewTitle title={tagName ?? t["Untitled"]()} />
      <ViewIcon icon="tag" />
      <ViewHeader>
        <TagDetailHeader tagId={tagId} title={tagName ?? t["Untitled"]()} />
      </ViewHeader>
      <ViewBody>
        <PageContentRail
          scroll
          width="data"
          data-myoxus-ui-role="tag-detail-content-rail"
        >
          <TagUsageList tagId={tagId} workspaceId={workspaceId} />
        </PageContentRail>
      </ViewBody>
    </>
  );
};

export const Component = () => {
  const params = useParams();

  return <TagDetail tagId={params.tagId} />;
};
