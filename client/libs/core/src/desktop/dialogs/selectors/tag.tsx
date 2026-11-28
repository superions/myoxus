// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { FavoriteTag } from "@myoxus/core/components/page-list";
import type {
  DialogComponentProps,
  WORKSPACE_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import { FavoriteService } from "@myoxus/core/modules/favorite";
import { TagService } from "@myoxus/core/modules/tag";
import { useI18n } from "@myoxus/i18n";
import { ArchiveIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Badge,
  Checkbox,
  ColorSwatch,
  EmptyState,
  Modal,
  notify,
  Scrollable,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemIcon,
  SurfaceListItemMain,
  SurfaceListSpacer,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { memo, useCallback, useMemo, useRef, useState } from "react";

import { SelectorFrame } from "./selector-frame";

const TagFavoriteToggle = memo(function TagFavoriteToggle({
  tagId,
}: {
  tagId: string;
}) {
  const t = useI18n();
  const favoriteService = useService(FavoriteService);
  const isFavorite = useLiveData(
    favoriteService.favoriteList.isFavorite$("tag", tagId),
  );

  const handleToggle = useCallback(() => {
    favoriteService.favoriteList.toggle("tag", tagId);
    notify({
      title: isFavorite
        ? t["com.myoxus.toastMessage.removedFavorites"]()
        : t["com.myoxus.toastMessage.addedFavorites"](),
    });
  }, [favoriteService.favoriteList, isFavorite, t, tagId]);

  return <FavoriteTag active={isFavorite} onClick={handleToggle} />;
});

export const TagSelectorDialog = ({
  close,
  init: selectedTagIds,
  returnFocusRef,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["tag-selector"]>) => {
  const t = useI18n();
  const tagList = useService(TagService).tagList;
  const tagMetas = useLiveData(tagList.tagMetas$);

  const [open, setOpen] = useState(true);
  const resultRef = useRef<string[] | undefined>(undefined);
  const [selection, setSelection] = useState<string[]>(selectedTagIds);
  const [keyword, setKeyword] = useState("");

  const requestClose = useCallback(
    (result?: string[]) => {
      if (!open) return;
      resultRef.current = result;
      setOpen(false);
    },
    [open],
  );

  const filteredTags = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase(t.language);
    if (!query) return tagMetas;
    return tagMetas.filter((tag) =>
      tag.name.toLocaleLowerCase(t.language).includes(query),
    );
  }, [keyword, t.language, tagMetas]);

  const toggleTag = useCallback((tagId: string) => {
    setSelection((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId],
    );
  }, []);

  return (
    <Modal
      open={open}
      returnFocusRef={returnFocusRef}
      onExitTransitionEnd={() => close(resultRef.current)}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) requestClose();
      }}
      title={t["Tags"]()}
      width="xl"
      height="80%"
      contentOptions={{
        bodyOverflow: "hidden",
        "data-testid": "tag-selector-dialog",
      }}
    >
      <SelectorFrame
        searchPlaceholder={t["com.myoxus.selector-tag.search.placeholder"]()}
        selectedCount={selection.length}
        onSearch={setKeyword}
        onClear={() => setSelection([])}
        onCancel={() => requestClose()}
        onConfirm={() => requestClose(selection)}
      >
        <Scrollable.Viewport fill>
          {filteredTags.length > 0 ? (
            <SurfaceList label={t["Tags"]()}>
              {filteredTags.map((tag) => {
                const selected = selection.includes(tag.id);
                return (
                  <SurfaceListItem
                    key={tag.id}
                    component="label"
                    alignItems="center"
                    density="compact"
                    fullWidth
                    interactive
                    layout="row"
                    selected={selected}
                    data-tag-id={tag.id}
                    data-testid="tag-list-item"
                    data-myoxus-ui-role="tag-selector-row"
                  >
                    <Checkbox
                      size="xs"
                      checked={selected}
                      onChange={() => toggleTag(tag.id)}
                    />
                    <SurfaceListItemIcon data-testid="tag-list-item-icon">
                      <ColorSwatch
                        aria-label={t["Tags"]()}
                        tagColorRole={tag.color}
                        shape="circle"
                      />
                    </SurfaceListItemIcon>
                    <SurfaceListItemMain
                      compact
                      grow
                      data-testid="tag-list-item-title"
                    >
                      <SurfaceListText
                        data-testid="tag-list-item-title-text"
                        kind="title"
                      >
                        {tag.name || t["Untitled"]()}
                      </SurfaceListText>
                      {tag.archived ? (
                        <Badge prefix={<ArchiveIcon />}>
                          {t["com.myoxus.tags.status.archived"]()}
                        </Badge>
                      ) : null}
                    </SurfaceListItemMain>
                    <SurfaceListSpacer />
                    <span
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                    >
                      <TagFavoriteToggle tagId={tag.id} />
                    </span>
                  </SurfaceListItem>
                );
              })}
            </SurfaceList>
          ) : (
            <EmptyState
              title={t["com.myoxus.tags.empty.noTagsDescription"]()}
            />
          )}
        </Scrollable.Viewport>
      </SelectorFrame>
    </Modal>
  );
};
