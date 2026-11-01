import {
  FavoriteTag,
  type ListItem,
  ListTableHeader,
  tagHeaderColsDef,
  TagListItemRenderer,
  type TagMeta,
  VirtualizedList,
} from "@myoxus/core/components/page-list";
import { SelectorLayout } from "@myoxus/core/components/page-list/selector/selector-layout";
import type {
  DialogComponentProps,
  WORKSPACE_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import { FavoriteService } from "@myoxus/core/modules/favorite";
import { TagService } from "@myoxus/core/modules/tag";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { cssVar } from "@myoxus/theme";
import { Modal, notify } from "@myoxus/ui-facade";
import { useCallback, useMemo, useState } from "react";

const FavoriteOperation = ({ tag }: { tag: ListItem }) => {
  const t = useI18n();
  const favoriteService = useService(FavoriteService);
  const isFavorite = useLiveData(
    favoriteService.favoriteList.isFavorite$("tag", tag.id),
  );

  const onToggleFavoriteCollection = useCallback(() => {
    favoriteService.favoriteList.toggle("tag", tag.id);
    notify({
      title: isFavorite
        ? t["com.myoxus.toastMessage.removedFavorites"]()
        : t["com.myoxus.toastMessage.addedFavorites"](),
    });
  }, [favoriteService.favoriteList, tag.id, isFavorite, t]);

  return (
    <FavoriteTag onClick={onToggleFavoriteCollection} active={isFavorite} />
  );
};

export const TagSelectorDialog = ({
  close,
  init: selectedTagIds,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["tag-selector"]>) => {
  const t = useI18n();

  const workspace = useService(WorkspaceService).workspace;
  const tagList = useService(TagService).tagList;

  const [selection, setSelection] = useState(selectedTagIds);
  const [keyword, setKeyword] = useState("");
  const tagMetas: TagMeta[] = useLiveData(tagList.tagMetas$);

  const filteredTagMetas = useMemo(() => {
    return tagMetas.filter((tag) => {
      const reg = new RegExp(keyword, "i");
      return reg.test(tag.name);
    });
  }, [keyword, tagMetas]);

  const tagItemRenderer = useCallback((item: ListItem) => {
    return <TagListItemRenderer {...item} />;
  }, []);

  const tagOperationRenderer = useCallback((item: ListItem) => {
    return <FavoriteOperation tag={item} />;
  }, []);

  const tagHeaderRenderer = useCallback(() => {
    return <ListTableHeader headerCols={tagHeaderColsDef} />;
  }, []);

  return (
    <Modal
      open
      onOpenChange={() => close()}
      withoutCloseButton
      width={"80rem"}
      height="80%"
      contentOptions={{
        style: {
          padding: 0,
          background: cssVar("backgroundPrimaryColor"),
        },
      }}
    >
      <SelectorLayout
        searchPlaceholder={t["com.myoxus.selector-tag.search.placeholder"]()}
        selectedCount={selection.length}
        onSearch={setKeyword}
        onConfirm={() => close(selection)}
        onCancel={close}
        onClear={() => setSelection([])}
      >
        <VirtualizedList
          selectable={true}
          draggable={false}
          selectedIds={selection}
          onSelectedIdsChange={setSelection}
          items={filteredTagMetas}
          docCollection={workspace.docCollection}
          itemRenderer={tagItemRenderer}
          operationsRenderer={tagOperationRenderer}
          headerRenderer={tagHeaderRenderer}
        />
      </SelectorLayout>
    </Modal>
  );
};
