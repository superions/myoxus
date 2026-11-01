// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CommentSidebar } from "@myoxus/core/components/comment/sidebar";
import { ServerService } from "@myoxus/core/modules/server";
import { ViewContextSurface } from "@myoxus/core/modules/workbench";
import { ServerFeature } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { CommentIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";

const DOCUMENT_AND_JOURNAL_VIEW_FAMILIES = [
  "document-page",
  "document-edgeless",
  "journal",
] as const;

export function CommentsSidecard({
  workspaceFlavour,
}: {
  workspaceFlavour: string;
}) {
  const t = useI18n();
  const serverService = useService(ServerService);
  const serverConfig = useLiveData(serverService.server.config$);
  const isAvailable =
    workspaceFlavour !== "local" &&
    serverConfig.features.includes(ServerFeature.Comment);

  if (!isAvailable) {
    return null;
  }

  return (
    <ViewContextSurface
      surfaceId="comment"
      order={60}
      label={t["com.myoxus.sidebar.tab.comments"]()}
      tooltip={t["com.myoxus.sidebar.tab.comments.tooltip"]()}
      icon={<CommentIcon />}
      viewFamilies={DOCUMENT_AND_JOURNAL_VIEW_FAMILIES}
    >
      <CommentSidebar />
    </ViewContextSurface>
  );
}
