// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { PageNotFound } from "@myoxus/core/desktop/pages/404";
import { Page } from "@myoxus/core/mobile/components/page";
import { getDatabaseWorkspaceAvailability } from "@myoxus/core/modules/database/availability";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { TagService } from "@myoxus/core/modules/tag";
import { TagDetailHeader } from "@myoxus/core/modules/tag/view/tag-detail-header";
import { TagUsageList } from "@myoxus/core/modules/tag/view/tag-usage-list";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { PageContentRail, useThemeColor } from "@myoxus/ui-facade";
import { useEffect } from "react";
import { useParams } from "react-router";

export const Component = () => {
  useThemeColor("backgroundSecondaryColor");
  const t = useI18n();
  const tagId = useParams().tagId;
  const globalContext = useService(GlobalContextService).globalContext;
  const workspace = useService(WorkspaceService).workspace;
  const workspaceId =
    getDatabaseWorkspaceAvailability(workspace).serverWorkspaceId;
  const tagList = useService(TagService).tagList;
  const currentTag = useLiveData(tagList.tagByTagId$(tagId));
  const tagName = useLiveData(currentTag?.value$);

  useEffect(() => {
    if (currentTag) {
      globalContext.tagId.set(currentTag.id);
      globalContext.isTag.set(true);
      return () => {
        globalContext.tagId.set(null);
        globalContext.isTag.set(false);
      };
    }
    return;
  }, [currentTag, globalContext]);

  if (!currentTag || !tagId) {
    return <PageNotFound />;
  }

  return (
    <Page
      header={
        <TagDetailHeader tagId={tagId} title={tagName || t["Untitled"]()} />
      }
      tab
    >
      <PageContentRail fill scroll width="data">
        <TagUsageList tagId={tagId} workspaceId={workspaceId} />
      </PageContentRail>
    </Page>
  );
};
