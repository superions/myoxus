import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { type DocRecord, DocService } from "@myoxus/core/modules/doc";
import { useI18n } from "@myoxus/i18n";
import { EdgelessIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { MenuItem, PropertyValue, type RadioItem } from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import { PlainTextDocGroupHeader } from "../explorer/docs-view/group-header";
import { StackProperty } from "../explorer/docs-view/stack-property";
import type { GroupHeaderProps } from "../explorer/types";
import { FilterValueMenu } from "../filter/filter-value-menu";
import type { PropertyValueProps } from "../properties/types";
import { PropertyRadioGroup } from "../properties/widgets/radio-group";

const getThemeOptions = (t: ReturnType<typeof useI18n>) =>
  [
    {
      value: "system",
      label: t["com.myoxus.themeSettings.auto"](),
    },
    {
      value: "light",
      label: t["com.myoxus.themeSettings.light"](),
    },
    {
      value: "dark",
      label: t["com.myoxus.themeSettings.dark"](),
    },
  ] satisfies RadioItem[];

export const EdgelessThemeValue = ({
  onChange,
  readonly,
}: PropertyValueProps) => {
  const t = useI18n();
  const doc = useService(DocService).doc;
  const edgelessTheme = useLiveData(doc.edgelessColorTheme$);

  const handleChange = useCallback(
    (theme: string) => {
      void doc.record.setEdgelessColorTheme(theme);
      onChange?.(theme, true);
    },
    [doc, onChange],
  );
  const themeItems = useMemo<RadioItem[]>(() => getThemeOptions(t), [t]);

  return (
    <PropertyValue hoverable={false} readonly={readonly}>
      <PropertyRadioGroup
        value={edgelessTheme || "system"}
        onChange={handleChange}
        items={themeItems}
        disabled={readonly}
      />
    </PropertyValue>
  );
};

export const EdgelessThemeDocListProperty = ({ doc }: { doc: DocRecord }) => {
  const t = useI18n();
  const edgelessTheme = useLiveData(doc.edgelessColorTheme$);

  return (
    <StackProperty icon={<EdgelessIcon />}>
      {edgelessTheme === "system" || !edgelessTheme
        ? t["com.myoxus.themeSettings.auto"]()
        : edgelessTheme === "light"
          ? t["com.myoxus.themeSettings.light"]()
          : t["com.myoxus.themeSettings.dark"]()}
    </StackProperty>
  );
};

export const EdgelessThemeFilterValue = ({
  filter,
  isDraft,
  onDraftCompleted,
  onChange,
}: {
  filter: FilterParams;
  isDraft?: boolean;
  onDraftCompleted?: () => void;
  onChange?: (filter: FilterParams) => void;
}) => {
  const t = useI18n();

  return (
    <FilterValueMenu
      isDraft={isDraft}
      onDraftCompleted={onDraftCompleted}
      items={
        <>
          <MenuItem
            onClick={() => {
              onChange?.({
                ...filter,
                value: "system",
              });
            }}
            selected={filter.value === "system"}
          >
            {t["com.myoxus.themeSettings.auto"]()}
          </MenuItem>
          <MenuItem
            onClick={() => {
              onChange?.({
                ...filter,
                value: "light",
              });
            }}
            selected={filter.value === "light"}
          >
            {t["com.myoxus.themeSettings.light"]()}
          </MenuItem>
          <MenuItem
            onClick={() => {
              onChange?.({
                ...filter,
                value: "dark",
              });
            }}
            selected={filter.value === "dark"}
          >
            {t["com.myoxus.themeSettings.dark"]()}
          </MenuItem>
        </>
      }
    >
      <span>
        {filter.value === "system"
          ? t["com.myoxus.themeSettings.auto"]()
          : filter.value === "light"
            ? t["com.myoxus.themeSettings.light"]()
            : t["com.myoxus.themeSettings.dark"]()}
      </span>
    </FilterValueMenu>
  );
};

export const EdgelessThemeGroupHeader = ({
  groupId,
  docCount,
}: GroupHeaderProps) => {
  const t = useI18n();
  const text =
    groupId === "light"
      ? t["com.myoxus.themeSettings.light"]()
      : groupId === "dark"
        ? t["com.myoxus.themeSettings.dark"]()
        : groupId === "system"
          ? t["com.myoxus.themeSettings.auto"]()
          : "Default";

  return (
    <PlainTextDocGroupHeader groupId={groupId} docCount={docCount}>
      {text}
    </PlainTextDocGroupHeader>
  );
};
