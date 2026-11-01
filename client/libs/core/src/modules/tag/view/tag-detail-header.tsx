// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useGuard } from "@myoxus/core/components/guard/use-guard";
import {
  TagEditMenu,
  useWorkspaceTagColorOptions,
  useWorkspaceTagCommands,
} from "@myoxus/core/components/tags";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { MoreHorizontalIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Group,
  IconButton,
  WorkbenchHeaderContextPath,
  WorkbenchHeaderFrame,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";

import { TagService } from "../service/tag";

export const TagDetailHeader = ({
  actions,
  tagId,
  title,
}: {
  actions?: ReactNode;
  tagId?: string;
  title: string;
}) => {
  const t = useI18n();
  const tagList = useService(TagService).tagList;
  const tag = useLiveData(tagList.tagByTagId$(tagId));
  const name = useLiveData(tag?.value$);
  const color = useLiveData(tag?.color$);
  const description = useLiveData(tag?.description$);
  const archived = useLiveData(tag?.archived$);
  const commands = useWorkspaceTagCommands();
  const colors = useWorkspaceTagColorOptions();
  const workbench = useService(WorkbenchService).workbench;
  const canChangeTag = useGuard("Workspace_CreateDoc");
  const canDeleteTag = useGuard("Workspace_Properties_Delete");
  const showMenu = Boolean(tag && (canChangeTag || (archived && canDeleteTag)));
  const menu =
    tag && showMenu ? (
      <TagEditMenu
        canDeletePermanently={canDeleteTag}
        canEdit={canChangeTag}
        colors={colors}
        onTagArchive={(id) => {
          void commands.archiveTags([id]);
        }}
        onTagDeletePermanently={(id) => {
          return commands.deleteTagPermanently(id).then((changed) => {
            if (changed) {
              workbench.open("/tags", { at: "active", replaceHistory: true });
            }
            return changed;
          });
        }}
        onTagRestore={(id) => {
          void commands.restoreTag(id);
        }}
        onTagUpdate={(id, metadata) => commands.updateTag(id, metadata)}
        tag={{
          id: tag.id,
          name: name ?? "",
          color: color ?? "tag.grey",
          description: description ?? "",
          archived: archived ?? false,
        }}
      >
        <IconButton
          aria-label={`${name || title}: ${t["com.myoxus.common.open-menu"]()}`}
          icon={<MoreHorizontalIcon />}
          size="small"
        />
      </TagEditMenu>
    ) : null;

  return (
    <WorkbenchHeaderFrame
      data-myoxus-ui-role="tag-detail-header-frame"
      right={
        actions || menu ? (
          <Group gap="xs" wrap="nowrap">
            {actions}
            {menu}
          </Group>
        ) : undefined
      }
      title={
        <WorkbenchHeaderContextPath current={title} parents={[t["Tags"]()]} />
      }
    />
  );
};
