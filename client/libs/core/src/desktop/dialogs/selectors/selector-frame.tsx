// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  Button,
  DialogFooter,
  DialogFooterActions,
  Divider,
  Group,
  MyoxusText,
  RowInput,
  Stack,
  useDebouncedCallback,
} from "@myoxus/ui-facade";
import type { PropsWithChildren, ReactNode } from "react";

export interface SelectorFrameProps extends PropsWithChildren {
  fitContent?: boolean;
  searchPlaceholder?: string;
  selectedCount: number;
  onSearch: (query: string) => void;
  onClear: () => void;
  onCancel?: () => void;
  onConfirm?: () => void;
  actions?: ReactNode;
  headerActions?: ReactNode;
}

/**
 * Shared Mantine/Facade frame for searchable multi/single-select modals
 * (documents, tags, collections): debounced search header, scrollable body,
 * and selection count + action footer.
 */
export function SelectorFrame({
  children,
  fitContent = false,
  searchPlaceholder,
  selectedCount,
  onSearch,
  onClear,
  onCancel,
  onConfirm,
  actions,
  headerActions,
}: SelectorFrameProps) {
  const t = useI18n();
  const handleSearch = useDebouncedCallback((next: string) => {
    onSearch(next);
  }, 200);

  return (
    <Stack
      data-testid="doc-selector-layout"
      data-myoxus-ui-role="selector-layout"
      gap={0}
      h={fitContent ? undefined : "100%"}
      mih={0}
    >
      <Group data-myoxus-ui-role="selector-layout-header" wrap="nowrap">
        <RowInput
          data-testid="doc-selector-search-input"
          block
          placeholder={searchPlaceholder}
          onChange={handleSearch}
        />
        {headerActions}
      </Group>

      <Divider space="none" />

      <Stack
        component="main"
        data-myoxus-ui-role="selector-layout-content"
        flex={fitContent ? undefined : "1 1 0"}
        gap={0}
        mih={0}
      >
        {children}
      </Stack>

      <DialogFooter data-myoxus-ui-role="selector-layout-footer">
        <Group data-myoxus-ui-role="selector-layout-footer-info" wrap="wrap">
          <Group data-myoxus-ui-role="selector-layout-selected-count">
            <MyoxusText component="span" typographySlot="body-small">
              {t["com.myoxus.selectPage.selected"]()}
            </MyoxusText>
            <MyoxusText
              component="span"
              tone="accent"
              typographySlot="body-small"
            >
              {selectedCount}
            </MyoxusText>
          </Group>
          <Button variant="plain" onClick={onClear}>
            {t["com.myoxus.editCollection.pages.clear"]()}
          </Button>
        </Group>

        <DialogFooterActions data-myoxus-ui-role="selector-layout-footer-actions">
          {actions ?? (
            <>
              <Button
                data-testid="doc-selector-cancel-button"
                onClick={onCancel}
              >
                {t["Cancel"]()}
              </Button>
              <Button
                data-testid="doc-selector-confirm-button"
                onClick={onConfirm}
                variant="primary"
              >
                {t["Confirm"]()}
              </Button>
            </>
          )}
        </DialogFooterActions>
      </DialogFooter>
    </Stack>
  );
}
