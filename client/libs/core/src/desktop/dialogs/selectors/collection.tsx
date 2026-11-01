import { SelectorLayout } from "@myoxus/core/components/page-list/selector/selector-layout";
import {
  type CollectionMeta,
  CollectionService,
} from "@myoxus/core/modules/collection";
import type { DialogComponentProps } from "@myoxus/core/modules/dialogs";
import type { WORKSPACE_DIALOG_SCHEMA } from "@myoxus/core/modules/dialogs/constant";
import { useI18n } from "@myoxus/i18n";
import { ViewLayersIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Checkbox,
  EmptyState,
  Modal,
  Scrollable,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemIcon,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { useCallback, useMemo, useState } from "react";

export const CollectionSelectorDialog = ({
  close,
  init: selectedCollectionIds,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["collection-selector"]>) => {
  const t = useI18n();
  const collectionService = useService(CollectionService);
  const collections = useLiveData(collectionService.collectionMetas$);
  const [selection, setSelection] = useState(selectedCollectionIds);
  const [keyword, setKeyword] = useState("");

  const collectionMetas = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase();
    return query
      ? collections.filter((meta) =>
          meta.title.toLocaleLowerCase().includes(query),
        )
      : collections;
  }, [collections, keyword]);

  const toggleCollection = useCallback((collection: CollectionMeta) => {
    setSelection((current) =>
      current.includes(collection.id)
        ? current.filter((id) => id !== collection.id)
        : [...current, collection.id],
    );
  }, []);

  return (
    <Modal
      open
      onOpenChange={() => close()}
      title={t["Collections"]()}
      width="xl"
      height="80%"
      contentOptions={{ bodyOverflow: "hidden" }}
    >
      <SelectorLayout
        searchPlaceholder={t[
          "com.myoxus.selector-collection.search.placeholder"
        ]()}
        selectedCount={selection.length}
        onSearch={setKeyword}
        onClear={() => setSelection([])}
        onCancel={() => close()}
        onConfirm={() => close(selection)}
      >
        <Scrollable.Viewport fill>
          {collectionMetas.length > 0 ? (
            <SurfaceList label={t["Collections"]()}>
              {collectionMetas.map((collection) => {
                const selected = selection.includes(collection.id);
                return (
                  <SurfaceListItem
                    alignItems="center"
                    component="label"
                    density="compact"
                    fullWidth
                    interactive
                    key={collection.id}
                    layout="row"
                    selected={selected}
                    data-collection-id={collection.id}
                    data-myoxus-ui-role="collection-selector-row"
                  >
                    <Checkbox
                      checked={selected}
                      onChange={() => toggleCollection(collection)}
                    />
                    <SurfaceListItemIcon size="md">
                      <ViewLayersIcon />
                    </SurfaceListItemIcon>
                    <SurfaceListText kind="title">
                      {collection.title.trim() || t["Untitled"]()}
                    </SurfaceListText>
                  </SurfaceListItem>
                );
              })}
            </SurfaceList>
          ) : (
            <EmptyState title={t["com.myoxus.collections.empty.message"]()} />
          )}
        </Scrollable.Viewport>
      </SelectorLayout>
    </Modal>
  );
};
