// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { TagMetadataModal } from "@myoxus/core/modules/tag/view/tag-metadata-modal";
import { Trans, useI18n } from "@myoxus/i18n";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  DeleteIcon,
  EditIcon,
  TagsIcon,
} from "@myoxus/icons/react";
import {
  Menu,
  MenuItem,
  MenuSeparator,
  type TagColorRole,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { type PropsWithChildren, useRef, useState } from "react";

import type { TagColor, TagLike } from "./types";

export type TagMetadataUpdate = {
  name: string;
  color: TagColorRole;
  description: string;
};

type TagEditMenuProps = PropsWithChildren<{
  onTagArchive: (tagId: string) => void;
  onTagDeletePermanently?: (tagId: string) => Promise<boolean>;
  onTagRestore?: (tagId: string) => void;
  canEdit?: boolean;
  canDeletePermanently?: boolean;
  colors: TagColor[];
  tag: TagLike;
  onTagUpdate: (tagId: string, metadata: TagMetadataUpdate) => Promise<boolean>;
  jumpToTag?: (tagId: string) => void;
}>;

export const TagEditMenu = ({
  tag,
  onTagArchive,
  onTagDeletePermanently,
  onTagRestore,
  canEdit = true,
  canDeletePermanently = false,
  children,
  jumpToTag,
  colors,
  onTagUpdate,
}: TagEditMenuProps) => {
  const t = useI18n();
  const { closeConfirmModal, openConfirmModal } = useConfirmModal();
  const [editOpen, setEditOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const confirmPermanentDelete = () => {
    if (!onTagDeletePermanently) return;
    openConfirmModal({
      title: t["com.myoxus.delete-tags.confirm.title"](),
      description: (
        <Trans
          i18nKey="com.myoxus.delete-tags.confirm.description"
          values={{ tag: tag.name }}
        >
          The tag <strong>{{ tag: tag.name } as any}</strong> will be removed
          from all documents and Database rows. This cannot be undone.
        </Trans>
      ),
      confirmText: t["com.myoxus.all-docs.quick-action.delete-permanently"](),
      cancelText: t["com.myoxus.confirmModal.button.cancel"](),
      confirmButtonOptions: { variant: "error" },
      closeOnConfirm: false,
      returnFocusRef: triggerRef,
      onConfirm: async () => {
        if (await onTagDeletePermanently(tag.id)) {
          closeConfirmModal();
        }
      },
    });
  };

  return (
    <>
      <Menu
        contentOptions={{
          onClick(event) {
            event.stopPropagation();
          },
        }}
        items={
          tag.archived ? (
            <>
              {canEdit ? (
                <MenuItem
                  prefixIcon={<ArchiveRestoreIcon />}
                  onClick={() => onTagRestore?.(tag.id)}
                >
                  {t["com.myoxus.tags.restore.action"]()}
                </MenuItem>
              ) : null}
              {jumpToTag ? (
                <MenuItem
                  prefixIcon={<TagsIcon />}
                  onClick={() => jumpToTag(tag.id)}
                >
                  {t["com.myoxus.page-properties.tags.open-tags-page"]()}
                </MenuItem>
              ) : null}
              {canDeletePermanently && onTagDeletePermanently ? (
                <>
                  {canEdit || jumpToTag ? <MenuSeparator /> : null}
                  <MenuItem
                    prefixIcon={<DeleteIcon />}
                    type="danger"
                    onClick={confirmPermanentDelete}
                  >
                    {t["com.myoxus.all-docs.quick-action.delete-permanently"]()}
                  </MenuItem>
                </>
              ) : null}
            </>
          ) : canEdit ? (
            <>
              <MenuItem
                prefixIcon={<EditIcon />}
                onClick={() => setEditOpen(true)}
              >
                {t["Edit"]()}
              </MenuItem>
              <MenuItem
                prefixIcon={<ArchiveIcon />}
                type="danger"
                onClick={() => onTagArchive(tag.id)}
              >
                {t["com.myoxus.tags.archive.action"]()}
              </MenuItem>
              {jumpToTag ? (
                <MenuItem
                  prefixIcon={<TagsIcon />}
                  onClick={() => jumpToTag(tag.id)}
                >
                  {t["com.myoxus.page-properties.tags.open-tags-page"]()}
                </MenuItem>
              ) : null}
            </>
          ) : null
        }
        rootOptions={{
          onOpen() {
            if (document.activeElement instanceof HTMLElement) {
              triggerRef.current = document.activeElement;
            }
          },
        }}
      >
        {children}
      </Menu>
      <TagMetadataModal
        colors={colors}
        mode="edit"
        onOpenChange={setEditOpen}
        onSubmit={(metadata) => onTagUpdate(tag.id, metadata)}
        open={editOpen}
        returnFocusRef={triggerRef}
        tag={tag}
      />
    </>
  );
};
