// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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

export function TagDetail({ tagId }: { tagId?: string }) {
  const t = useI18n();
  const globalContext = useService(GlobalContextService).globalContext;
  const workspace = useService(WorkspaceService).workspace;
  const workspaceId =
    getDatabaseWorkspaceAvailability(workspace).serverWorkspaceId;
  const tagList = useService(TagService).tagList;

  const currentTag = useLiveData(tagList.tagByTagId$(tagId));
  const tagName = useLiveData(currentTag?.value$);
  const isActiveView = useIsActiveView();

  useEffect(() => {
    if (!isActiveView || !currentTag) {
      return;
    }
    globalContext.tagId.set(currentTag.id);
    globalContext.isTag.set(true);
    return () => {
      globalContext.tagId.set(null);
      globalContext.isTag.set(false);
    };
  }, [currentTag, globalContext, isActiveView]);

  if (!currentTag || !tagId) {
    return <WorkbenchRouteNotFound />;
  }

  const title = tagName ?? t["Untitled"]();

  return (
    <>
      <ViewTitle title={title} />
      <ViewIcon icon="tag" />
      <ViewHeader>
        <TagDetailHeader tagId={tagId} title={title} />
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
}

export function Component() {
  const { tagId } = useParams();
  return <TagDetail tagId={tagId} />;
}
