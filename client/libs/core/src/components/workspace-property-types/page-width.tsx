import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { type DocRecord, DocService } from "@myoxus/core/modules/doc";
import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { LongerIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { MenuItem, PropertyValue, type RadioItem } from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import { PlainTextDocGroupHeader } from "../explorer/docs-view/group-header";
import { StackProperty } from "../explorer/docs-view/stack-property";
import type { GroupHeaderProps } from "../explorer/types";
import { FilterValueMenu } from "../filter/filter-value-menu";
import type { PropertyValueProps } from "../properties/types";
import { PropertyRadioGroup } from "../properties/widgets/radio-group";

export const PageWidthValue = ({ readonly }: PropertyValueProps) => {
  const t = useI18n();
  const editorSetting = useService(EditorSettingService).editorSetting;
  const defaultPageWidth = useLiveData(editorSetting.settings$).fullWidthLayout;

  const doc = useService(DocService).doc;
  const pageWidth = useLiveData(doc.pageWidth$);

  const radioValue = pageWidth ?? (defaultPageWidth ? "fullWidth" : "standard");

  const radioItems = useMemo<RadioItem[]>(
    () => [
      {
        value: "standard",
        label:
          t[
            "com.myoxus.settings.editorSettings.page.default-page-width.standard"
          ](),
        testId: "standard-width-trigger",
      },
      {
        value: "fullWidth",
        label:
          t[
            "com.myoxus.settings.editorSettings.page.default-page-width.full-width"
          ](),
        testId: "full-width-trigger",
      },
    ],
    [t],
  );

  const handleChange = useCallback(
    (value: string) => {
      void doc.record.setPageWidth(value);
    },
    [doc],
  );
  return (
    <PropertyValue hoverable={false} readonly={readonly}>
      <PropertyRadioGroup
        value={radioValue}
        onChange={handleChange}
        items={radioItems}
        disabled={readonly}
      />
    </PropertyValue>
  );
};

export const PageWidthDocListProperty = ({ doc }: { doc: DocRecord }) => {
  const t = useI18n();
  const pageWidth = useLiveData(doc.pageWidth$);

  return (
    <StackProperty icon={<LongerIcon />}>
      {pageWidth === "standard" || !pageWidth
        ? t[
            "com.myoxus.settings.editorSettings.page.default-page-width.standard"
          ]()
        : t[
            "com.myoxus.settings.editorSettings.page.default-page-width.full-width"
          ]()}
    </StackProperty>
  );
};

export const PageWidthFilterValue = ({
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
                value: "fullWidth",
              });
            }}
            selected={filter.value === "fullWidth"}
          >
            {t[
              "com.myoxus.settings.editorSettings.page.default-page-width.full-width"
            ]()}
          </MenuItem>
          <MenuItem
            onClick={() => {
              onChange?.({
                ...filter,
                value: "standard",
              });
            }}
            selected={filter.value !== "fullWidth"}
          >
            {t[
              "com.myoxus.settings.editorSettings.page.default-page-width.standard"
            ]()}
          </MenuItem>
        </>
      }
    >
      <span>
        {filter.value === "fullWidth"
          ? t[
              "com.myoxus.settings.editorSettings.page.default-page-width.full-width"
            ]()
          : t[
              "com.myoxus.settings.editorSettings.page.default-page-width.standard"
            ]()}
      </span>
    </FilterValueMenu>
  );
};

export const PageWidthGroupHeader = ({
  groupId,
  docCount,
}: GroupHeaderProps) => {
  const t = useI18n();
  const text =
    groupId === "fullWidth"
      ? t[
          "com.myoxus.settings.editorSettings.page.default-page-width.full-width"
        ]()
      : groupId === "standard"
        ? t[
            "com.myoxus.settings.editorSettings.page.default-page-width.standard"
          ]()
        : "Default";

  return (
    <PlainTextDocGroupHeader groupId={groupId} docCount={docCount}>
      {text}
    </PlainTextDocGroupHeader>
  );
};
