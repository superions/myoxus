import { MobileJournalConflictList } from "@myoxus/core/mobile/pages/workspace/detail/menu/journal-conflicts";
import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { DocService } from "@myoxus/core/modules/doc";
import { JournalService } from "@myoxus/core/modules/journal";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { ViewService } from "@myoxus/core/modules/workbench/services/view";
import { i18nTime, useI18n } from "@myoxus/i18n";
import { TodayIcon } from "@myoxus/icons/react";
import { useLiveData, useService, useServiceOptional } from "@myoxus/infra";
import {
  Badge,
  BadgeList,
  BadgeListItem,
  Button,
  Checkbox,
  DatePicker,
  Menu,
  MenuItem,
  PropertyValue,
} from "@myoxus/ui-facade";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PlainTextDocGroupHeader } from "../explorer/docs-view/group-header";
import { StackProperty } from "../explorer/docs-view/stack-property";
import type { DocListPropertyProps, GroupHeaderProps } from "../explorer/types";
import { FilterValueMenu } from "../filter/filter-value-menu";
import type { PropertyValueProps } from "../properties/types";

const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();
export const JournalValue = ({ readonly }: PropertyValueProps) => {
  const t = useI18n();

  const journalService = useService(JournalService);
  const doc = useService(DocService).doc;
  const journalDate = useLiveData(journalService.journalDate$(doc.id));
  const checked = !!journalDate;

  const [selectedDate, setSelectedDate] = useState(
    dayjs().format("YYYY-MM-DD"),
  );
  const [showDatePicker, setShowDatePicker] = useState(false);
  const displayDate = useMemo(
    () =>
      i18nTime(selectedDate, {
        absolute: { accuracy: "day" },
      }),
    [selectedDate],
  );
  const docs = useLiveData(
    useMemo(
      () => journalService.journalsByDate$(selectedDate),
      [journalService, selectedDate],
    ),
  );
  const conflict = docs.length > 1;

  useEffect(() => {
    if (journalDate) setSelectedDate(journalDate);
  }, [journalDate]);

  const handleDateSelect = useCallback(
    (day: string) => {
      const date = dayjs(day).format("YYYY-MM-DD");
      setSelectedDate(date);
      journalService.setJournalDate(doc.id, date);
    },
    [journalService, doc.id],
  );

  const handleCheck = useCallback(
    (_: unknown, v: boolean) => {
      if (!v) {
        journalService.removeJournalDate(doc.id);
        setShowDatePicker(false);
      } else {
        handleDateSelect(selectedDate);
      }
    },
    [journalService, doc.id, handleDateSelect, selectedDate],
  );

  const workbench = useService(WorkbenchService).workbench;
  const activeView = useLiveData(workbench.activeView$);
  const view = useServiceOptional(ViewService)?.view ?? activeView;

  const handleOpenDuplicate = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      view.showTool("calendar");
    },
    [view],
  );

  const propertyRef = useRef<HTMLDivElement>(null);

  const toggle = useCallback(
    (e: React.MouseEvent) => {
      if (readonly) return;
      if (propertyRef.current?.contains(e.target as Node)) {
        handleCheck(null, !checked);
      }
    },
    [checked, handleCheck, readonly],
  );

  return (
    <PropertyValue ref={propertyRef} onClick={toggle} readonly={readonly}>
      <BadgeList>
        <BadgeListItem>
          <Checkbox checked={checked} disabled={readonly} />
        </BadgeListItem>
        {checked ? (
          <Menu
            contentOptions={{
              onClick: (e) => e.stopPropagation(),
            }}
            rootOptions={{
              modal: true,
              open: !readonly && showDatePicker,
              onOpenChange: setShowDatePicker,
            }}
            items={
              <DatePicker
                weekDays={t["com.myoxus.common.calendar.week-days"]()}
                monthNames={t["com.myoxus.common.calendar.month-names"]()}
                todayLabel={t["com.myoxus.common.calendar.today"]()}
                value={selectedDate}
                onChange={handleDateSelect}
              />
            }
          >
            <Button
              data-testid="date-selector"
              variant="plain"
              onClick={stopPropagation}
              disabled={readonly}
            >
              {displayDate}
            </Button>
          </Menu>
        ) : null}

        {checked && conflict ? (
          BUILD_CONFIG.isMobileEdition ? (
            <Menu items={<MobileJournalConflictList date={selectedDate} />}>
              <Badge
                data-testid="conflict-tag"
                tone="error"
                onClick={stopPropagation}
              >
                {t["com.myoxus.page-properties.property.journal-duplicated"]()}
              </Badge>
            </Menu>
          ) : (
            <Badge
              data-testid="conflict-tag"
              tone="error"
              onClick={handleOpenDuplicate}
            >
              {t["com.myoxus.page-properties.property.journal-duplicated"]()}
            </Badge>
          )
        ) : null}
      </BadgeList>
    </PropertyValue>
  );
};

export const JournalFilterValue = ({
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

export const JournalDocListProperty = ({ doc }: DocListPropertyProps) => {
  const journalService = useService(JournalService);
  const journalDate = useLiveData(journalService.journalDate$(doc.id));

  if (!journalDate) {
    return null;
  }

  return (
    <StackProperty icon={<TodayIcon />}>
      {i18nTime(journalDate, { absolute: { accuracy: "day" } })}
    </StackProperty>
  );
};

export const JournalGroupHeader = ({ groupId, docCount }: GroupHeaderProps) => {
  const t = useI18n();
  const text =
    groupId === "true"
      ? t["com.myoxus.all-docs.group.is-journal"]()
      : t["com.myoxus.all-docs.group.is-not-journal"]();
  return (
    <PlainTextDocGroupHeader groupId={groupId} docCount={docCount}>
      {text}
    </PlainTextDocGroupHeader>
  );
};
