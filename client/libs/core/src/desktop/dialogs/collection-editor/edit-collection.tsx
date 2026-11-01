/**
 * `EditCollection` — the form used when creating or editing a workspace collection.
 *
 * A collection is a saved filter/grouping of documents.  This component lets
 * the user configure it in one of two modes, selectable via the shared
 * Facade/Mantine tabs:
 *
 * - **`'page'` mode** — select specific documents to include via `SelectPage`.
 *   The collection becomes a pinned list of document IDs.
 * - **`'rule'` mode** — define filter rules via `RulesMode`.  The collection
 *   is evaluated dynamically and includes any document matching the rules.
 *
 * The initial mode is inferred from the collection's current state: rule mode
 * is chosen when `init.rules.filters` is non-empty, otherwise page mode.
 * Callers can override this with the `mode` prop.
 *
 * Switching tabs preserves both explicit inclusions and configured rules so
 * users can review either part of the collection before saving.
 *
 * The confirm button is disabled while `value.name` is empty, preventing
 * nameless collections from being saved.
 *
 * @param init           - Initial `CollectionInfo` to populate the form.
 * @param mode           - Optional override for the initial edit mode.
 * @param onConfirmText  - Custom label for the confirm button.
 * @param onConfirm      - Called with the updated `CollectionInfo` on save.
 * @param onCancel       - Called when the user cancels without saving.
 */
import { SelectPage } from "@myoxus/core/components/page-list/docs/select-page";
import type { CollectionInfo } from "@myoxus/core/modules/collection";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  DialogFooterActions,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@myoxus/ui-facade";
import { useCallback, useMemo, useState } from "react";

import { RulesMode } from "./rules-mode";

export type EditCollectionMode = "page" | "rule";

export interface EditCollectionProps {
  onConfirmText?: string;
  init: CollectionInfo;
  mode?: EditCollectionMode;
  onModeChange?: (mode: EditCollectionMode) => void;
  onCancel: () => void;
  onConfirm: (collection: CollectionInfo) => void;
}

export const EditCollection = ({
  init,
  onConfirm,
  onCancel,
  onConfirmText,
  onModeChange,
  mode: initMode,
}: EditCollectionProps) => {
  const t = useI18n();
  const [value, onChange] = useState<CollectionInfo>(init);
  const [mode, setMode] = useState<"page" | "rule">(
    initMode ?? (init.rules.filters.length === 0 ? "page" : "rule"),
  );
  const isNameEmpty = useMemo(() => value.name.trim().length === 0, [value]);
  const onSaveCollection = useCallback(() => {
    if (!isNameEmpty) {
      onConfirm(value);
    }
  }, [value, isNameEmpty, onConfirm]);
  const reset = useCallback(() => {
    onChange({
      ...value,
      rules: init.rules,
      allowList: init.allowList,
    });
  }, [init, value]);
  const onIdsChange = useCallback((ids: string[]) => {
    onChange((prev) => ({ ...prev, allowList: ids }));
  }, []);
  const buttons = useMemo(
    () => (
      <DialogFooterActions data-myoxus-ui-role="collection-editor-actions">
        <Button onClick={onCancel}>
          {t["com.myoxus.editCollection.button.cancel"]()}
        </Button>
        <Button
          data-testid="save-collection"
          variant="primary"
          disabled={isNameEmpty}
          onClick={onSaveCollection}
        >
          {onConfirmText ?? t["com.myoxus.editCollection.button.create"]()}
        </Button>
      </DialogFooterActions>
    ),
    [onCancel, t, isNameEmpty, onSaveCollection, onConfirmText],
  );
  return (
    <Tabs
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          return;
        }
        e.stopPropagation();
      }}
      data-myoxus-ui-role="collection-editor"
      fill={mode === "rule"}
      value={mode}
      onChange={(nextMode) => {
        if (!nextMode) {
          return;
        }
        const selectedMode = nextMode as EditCollectionMode;
        setMode(selectedMode);
        onModeChange?.(selectedMode);
      }}
    >
      <TabsList data-myoxus-ui-role="collection-editor-tabs">
        <TabsTrigger data-testid="edit-collection-pages-button" value="page">
          {t["com.myoxus.editCollection.pages"]()}
        </TabsTrigger>
        <TabsTrigger data-testid="edit-collection-rules-button" value="rule">
          {t["com.myoxus.editCollection.rules"]()}
        </TabsTrigger>
      </TabsList>
      <TabsContent flush value="page">
        <SelectPage
          init={init.allowList}
          onChange={onIdsChange}
          buttons={buttons}
        />
      </TabsContent>
      <TabsContent fill={mode === "rule"} flush value="rule">
        <RulesMode
          collection={value}
          reset={reset}
          updateCollection={onChange}
          buttons={buttons}
        />
      </TabsContent>
    </Tabs>
  );
};
