import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { type DocRecord, DocService } from "@myoxus/core/modules/doc";
import { useI18n } from "@myoxus/i18n";
import { TemplateIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { Checkbox, MenuItem, PropertyValue } from "@myoxus/ui-facade";
import { type ChangeEvent, useCallback } from "react";

import { PlainTextDocGroupHeader } from "../explorer/docs-view/group-header";
import { StackProperty } from "../explorer/docs-view/stack-property";
import type { GroupHeaderProps } from "../explorer/types";
import { FilterValueMenu } from "../filter/filter-value-menu";
import type { PropertyValueProps } from "../properties/types";

const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();

export const TemplateValue = ({ readonly }: PropertyValueProps) => {
  const docService = useService(DocService);

  const isTemplate = useLiveData(docService.doc.isTemplate$);

  const onChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (readonly) return;
      const value = e.target.checked;
      void docService.doc.record.setTemplateState(value);
    },
    [docService.doc.record, readonly],
  );

  const toggle = useCallback(() => {
    if (readonly) return;
    void docService.doc.record.setTemplateState(!isTemplate);
  }, [docService.doc.record, isTemplate, readonly]);

  return (
    <PropertyValue onClick={toggle} readonly>
      <Checkbox
        data-testid="toggle-template-checkbox"
        checked={!!isTemplate}
        onChange={onChange}
        onClick={stopPropagation}
        disabled={readonly}
      />
    </PropertyValue>
  );
};

export const TemplateDocListProperty = ({ doc }: { doc: DocRecord }) => {
  const t = useI18n();
  const isTemplate = useLiveData(doc.isTemplate$);

  if (!isTemplate) {
    return null;
  }

  return (
    <StackProperty icon={<TemplateIcon />}>{t["Template"]()}</StackProperty>
  );
};

export const TemplateGroupHeader = ({
  groupId,
  docCount,
}: GroupHeaderProps) => {
  const t = useI18n();
  const text =
    groupId === "true"
      ? t["com.myoxus.all-docs.group.is-template"]()
      : groupId === "false"
        ? t["com.myoxus.all-docs.group.is-not-template"]()
        : "Default";

  return (
    <PlainTextDocGroupHeader groupId={groupId} docCount={docCount}>
      {text}
    </PlainTextDocGroupHeader>
  );
};

export const TemplateFilterValue = ({
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
                value: "true",
              });
            }}
            selected={filter.value === "true"}
          >
            {"True"}
          </MenuItem>
          <MenuItem
            onClick={() => {
              onChange?.({
                ...filter,
                value: "false",
              });
            }}
            selected={filter.value !== "true"}
          >
            {"False"}
          </MenuItem>
        </>
      }
    >
      <span>{filter.value === "true" ? "True" : "False"}</span>
    </FilterValueMenu>
  );
};
