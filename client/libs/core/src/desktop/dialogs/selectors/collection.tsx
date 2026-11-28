// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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
import { useCallback, useMemo, useRef, useState } from "react";

import { SelectorFrame } from "./selector-frame";

export const CollectionSelectorDialog = ({
  close,
  init: selectedCollectionIds,
  returnFocusRef,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["collection-selector"]>) => {
  const t = useI18n();
  const collectionService = useService(CollectionService);
  const collections = useLiveData(collectionService.collectionMetas$);

  const [open, setOpen] = useState(true);
  const resultRef = useRef<string[] | undefined>(undefined);
  const [selection, setSelection] = useState<string[]>(selectedCollectionIds);
  const [keyword, setKeyword] = useState("");

  const requestClose = useCallback(
    (result?: string[]) => {
      if (!open) return;
      resultRef.current = result;
      setOpen(false);
    },
    [open],
  );

  const visibleCollections = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase(t.language);
    if (!query) return collections;
    return collections.filter((meta) =>
      meta.title.toLocaleLowerCase(t.language).includes(query),
    );
  }, [collections, keyword, t.language]);

  const toggleCollection = useCallback((meta: CollectionMeta) => {
    setSelection((prev) =>
      prev.includes(meta.id)
        ? prev.filter((id) => id !== meta.id)
        : [...prev, meta.id],
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
      title={t["Collections"]()}
      width="xl"
      height="80%"
      contentOptions={{ bodyOverflow: "hidden" }}
    >
      <SelectorFrame
        searchPlaceholder={t[
          "com.myoxus.selector-collection.search.placeholder"
        ]()}
        selectedCount={selection.length}
        onSearch={setKeyword}
        onClear={() => setSelection([])}
        onCancel={() => requestClose()}
        onConfirm={() => requestClose(selection)}
      >
        <Scrollable.Viewport fill>
          {visibleCollections.length > 0 ? (
            <SurfaceList label={t["Collections"]()}>
              {visibleCollections.map((collection) => {
                const selected = selection.includes(collection.id);
                return (
                  <SurfaceListItem
                    key={collection.id}
                    alignItems="center"
                    component="label"
                    density="compact"
                    fullWidth
                    interactive
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
      </SelectorFrame>
    </Modal>
  );
};
