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
} from "@myoxus/ui-facade";
import { type PropsWithChildren, type ReactNode, useCallback } from "react";

export interface SelectorContentProps extends PropsWithChildren {
  fitContent?: boolean;
  searchPlaceholder?: string;
  selectedCount?: number;

  onSearch?: (value: string) => void;
  onClear?: () => void;
  onCancel?: () => void;
  onConfirm?: () => void;

  actions?: ReactNode;
  headerActions?: ReactNode;
}

/**
 * Provides a unified layout for doc/collection/tag selector
 * - Header (Search input)
 * - Content
 * - Footer (Selected count + Actions)
 */
export const SelectorLayout = ({
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
}: SelectorContentProps) => {
  const t = useI18n();

  const onSearchChange = useCallback(
    (value: string) => {
      onSearch?.(value);
    },
    [onSearch],
  );

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
          onChange={onSearchChange}
          debounce={200}
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
              {selectedCount ?? 0}
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
};
