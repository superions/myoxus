// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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

import { DocPicker } from "../selectors/doc-picker";
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

/**
 * Dual-mode workspace collection editor (manual page selection and dynamic
 * filter rules). Switching tabs retains both `allowList` and `rules` until save.
 */
export function EditCollection({
  init,
  mode: initialMode,
  onConfirmText,
  onModeChange,
  onCancel,
  onConfirm,
}: EditCollectionProps) {
  const t = useI18n();
  const [draft, setDraft] = useState<CollectionInfo>(init);
  const [mode, setMode] = useState<EditCollectionMode>(
    initialMode ?? (init.rules.filters.length === 0 ? "page" : "rule"),
  );

  const isNameEmpty = draft.name.trim().length === 0;

  const handleSave = useCallback(() => {
    if (!isNameEmpty) {
      onConfirm(draft);
    }
  }, [draft, isNameEmpty, onConfirm]);

  const handleReset = useCallback(() => {
    setDraft((prev) => ({
      ...prev,
      rules: init.rules,
      allowList: init.allowList,
    }));
  }, [init.allowList, init.rules]);

  const handleAllowListChange = useCallback((allowList: string[]) => {
    setDraft((prev) => ({ ...prev, allowList }));
  }, []);

  const footerButtons = useMemo(
    () => (
      <DialogFooterActions data-myoxus-ui-role="collection-editor-actions">
        <Button onClick={onCancel}>
          {t["com.myoxus.editCollection.button.cancel"]()}
        </Button>
        <Button
          data-testid="save-collection"
          variant="primary"
          disabled={isNameEmpty}
          onClick={handleSave}
        >
          {onConfirmText ?? t["com.myoxus.editCollection.button.create"]()}
        </Button>
      </DialogFooterActions>
    ),
    [handleSave, isNameEmpty, onCancel, onConfirmText, t],
  );

  return (
    <Tabs
      data-myoxus-ui-role="collection-editor"
      fill={mode === "rule"}
      value={mode}
      onKeyDown={(event) => {
        if (event.key !== "Escape") {
          event.stopPropagation();
        }
      }}
      onChange={(next) => {
        if (!next) return;
        const nextMode = next as EditCollectionMode;
        setMode(nextMode);
        onModeChange?.(nextMode);
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
        <DocPicker
          init={init.allowList}
          onChange={handleAllowListChange}
          buttons={footerButtons}
        />
      </TabsContent>

      <TabsContent fill={mode === "rule"} flush value="rule">
        <RulesMode
          collection={draft}
          reset={handleReset}
          updateCollection={setDraft}
          buttons={footerButtons}
        />
      </TabsContent>
    </Tabs>
  );
}
