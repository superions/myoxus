// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { MobileJournalConflictList } from "@myoxus/core/mobile/pages/workspace/detail/menu/journal-conflicts";
import { type DocRecord, DocService } from "@myoxus/core/modules/doc";
import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { JournalService } from "@myoxus/core/modules/journal";
import { PublicUserLabel } from "@myoxus/core/modules/server/views/public-user";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { ViewService } from "@myoxus/core/modules/workbench/services/view";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { i18nTime, useI18n } from "@myoxus/i18n";
import {
  EdgelessIcon,
  LongerIcon,
  PageIcon,
  TemplateIcon,
  TodayIcon,
} from "@myoxus/icons/react";
import {
  useLiveData,
  useService,
  useServiceOptional,
  useServices,
} from "@myoxus/infra";
import {
  type AvatarProps,
  Badge,
  BadgeList,
  BadgeListItem,
  Button,
  Checkbox,
  DatePicker,
  Menu,
  type MenuRef,
  MyoxusText,
  notify,
  PlaceholderText,
  type RadioItem,
  SurfaceListMeta,
  Tooltip,
} from "@myoxus/ui-facade";
import type { DocMode } from "@virgultum/editor/model";
import dayjs from "dayjs";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { DocListPropertyProps, GroupHeaderProps } from "../explorer/types";
import { MemberSelectorInline } from "../member-selector";
import type { PropertyValueProps } from "../properties/types";
import { PropertyRadioGroup } from "../properties/widgets/radio-group";
import { DateFilterValue } from "./basic-properties";
import {
  BooleanPropertyFilterMenu,
  createMappedGroupHeader,
  PropertyFieldCell,
  PropertyFilterMenu,
  type PropertyFilterProps,
  PropertyGroupHeader,
  PropertyListBadge,
} from "./property-kit";

const stopClick = (event: React.MouseEvent) => event.stopPropagation();

// ---------------------------------------------------------------------------
// Created / Updated At
// ---------------------------------------------------------------------------

const formatRelativeDay = (time: string | number) =>
  i18nTime(time, {
    relative: { max: [1, "day"], accuracy: "day" },
    absolute: { accuracy: "day" },
  });

const capitalizeFirst = (text: string) =>
  text ? text[0].toLocaleUpperCase() + text.slice(1) : text;

const createMetaDateValue = (field: "createDate" | "updatedDate") =>
  function DocMetaDateValue() {
    const { docService } = useServices({ DocService });
    const meta = useLiveData(docService.doc.meta$);
    const timestamp = meta?.[field];
    const relative = timestamp ? formatRelativeDay(timestamp) : null;
    const absolute = timestamp ? i18nTime(timestamp) : null;

    return (
      <Tooltip content={absolute} side="top" align="end">
        <PropertyFieldCell isEmpty={!relative}>{relative}</PropertyFieldCell>
      </Tooltip>
    );
  };

export const CreateAtValue = createMetaDateValue("createDate");
export const UpdatedAtValue = createMetaDateValue("updatedDate");

export const CreatedAtGroupHeader = createMappedGroupHeader((groupId) =>
  groupId ? capitalizeFirst(formatRelativeDay(groupId)) : "No Date",
);

export const UpdatedAtGroupHeader = createMappedGroupHeader((groupId, t) =>
  groupId
    ? capitalizeFirst(formatRelativeDay(groupId))
    : t["com.myoxus.all-docs.group.updated-at.never-updated"](),
);

const InlineTimestampBadge = ({
  label,
  time,
  formatTooltip,
}: {
  label: string;
  time?: number | string;
  formatTooltip: (absoluteTime: string) => string;
}) => {
  if (time === undefined || time === null || time === "") return null;

  const relative = i18nTime(time, { relative: true });
  const absolute = i18nTime(time);

  return (
    <Tooltip content={capitalizeFirst(formatTooltip(absolute))}>
      <SurfaceListMeta
        aria-label={`${label}: ${relative}`}
        title={`${label}: ${absolute}`}
        layout="row-cluster"
      >
        <MyoxusText component="span" typographySlot="body-small" truncate>
          {relative}
        </MyoxusText>
      </SurfaceListMeta>
    </Tooltip>
  );
};

export const CreateAtDocListProperty = ({ doc }: { doc: DocRecord }) => {
  const t = useI18n();
  const meta = useLiveData(doc.meta$);
  return (
    <InlineTimestampBadge
      label={t["com.myoxus.page-properties.property.createdAt"]()}
      time={meta?.createDate}
      formatTooltip={(time) => t.t("created at", { time })}
    />
  );
};

export const UpdatedAtDocListProperty = ({ doc }: { doc: DocRecord }) => {
  const t = useI18n();
  const meta = useLiveData(doc.meta$);
  return (
    <InlineTimestampBadge
      label={t["com.myoxus.page-properties.property.updatedAt"]()}
      time={meta?.updatedDate}
      formatTooltip={(time) => t.t("updated at", { time })}
    />
  );
};

export const CreatedAtFilterValue = DateFilterValue;
export const UpdatedAtFilterValue = DateFilterValue;

// ---------------------------------------------------------------------------
// Created / Updated By
// ---------------------------------------------------------------------------

const CreatedByTooltip = ({ userName }: { userName: string }) => {
  const t = useI18n();
  return t.t("com.myoxus.page-properties.property.createdBy.tip", { userName });
};

const UpdatedByTooltip = ({ userName }: { userName: string }) => {
  const t = useI18n();
  return t.t("com.myoxus.page-properties.property.updatedBy.tip", { userName });
};

const DocAuthorAvatar = ({
  kind,
  doc,
  size,
  showName,
  emptyFallback,
}: {
  kind: "CreatedBy" | "UpdatedBy";
  doc: DocRecord;
  size?: AvatarProps["size"];
  showName?: boolean;
  emptyFallback?: ReactNode;
}) => {
  const t = useI18n();
  const userId = useLiveData(
    kind === "CreatedBy" ? doc?.createdBy$ : doc?.updatedBy$,
  );

  if (userId) {
    return (
      <PublicUserLabel
        id={userId}
        size={size}
        showName={showName}
        align="center"
        tooltip={kind === "CreatedBy" ? CreatedByTooltip : UpdatedByTooltip}
      />
    );
  }

  return emptyFallback === undefined ? (
    <span>
      {t["com.myoxus.page-properties.property-user-avatar-no-record"]()}
    </span>
  ) : (
    emptyFallback
  );
};

const createAuthorValue = (kind: "CreatedBy" | "UpdatedBy") =>
  function DocAuthorValue() {
    const t = useI18n();
    const doc = useService(DocService).doc.record;
    const isCloud = useService(WorkspaceService).workspace.flavour !== "local";

    return (
      <PropertyFieldCell readonly>
        {isCloud ? (
          <DocAuthorAvatar kind={kind} doc={doc} />
        ) : (
          <span>{t["com.myoxus.page-properties.local-user"]()}</span>
        )}
      </PropertyFieldCell>
    );
  };

export const CreatedByValue = createAuthorValue("CreatedBy");
export const UpdatedByValue = createAuthorValue("UpdatedBy");

export const CreatedByUpdatedByFilterValue = ({
  filter,
  isDraft,
  onDraftCompleted,
  onChange,
}: PropertyFilterProps) => {
  const t = useI18n();
  const menuRef = useRef<MenuRef>(null);

  useEffect(() => {
    if (isDraft) menuRef.current?.changeOpen(true);
  }, [isDraft]);

  const selected = useMemo(
    () => filter.value?.split(",").filter(Boolean) ?? [],
    [filter.value],
  );

  const handleChange = useCallback(
    (nextIds: string[]) => {
      onChange?.({ ...filter, value: nextIds.join(",") });
    },
    [filter, onChange],
  );

  return (
    <MemberSelectorInline
      placeholder={
        <PlaceholderText>{t["com.myoxus.filter.empty"]()}</PlaceholderText>
      }
      selected={selected}
      onChange={handleChange}
      ref={menuRef}
      onEditorClose={onDraftCompleted}
    />
  );
};

export const CreatedByDocListInlineProperty = ({ doc }: { doc: DocRecord }) => (
  <DocAuthorAvatar
    doc={doc}
    kind="CreatedBy"
    emptyFallback={null}
    showName={false}
  />
);

export const UpdatedByDocListInlineProperty = ({ doc }: { doc: DocRecord }) => (
  <DocAuthorAvatar
    doc={doc}
    kind="UpdatedBy"
    emptyFallback={null}
    showName={false}
  />
);

export const ModifiedByGroupHeader = ({
  groupId,
  docCount,
}: GroupHeaderProps) => (
  <PropertyGroupHeader groupId={groupId} docCount={docCount}>
    <PublicUserLabel id={groupId} showName={false} align="center" />
  </PropertyGroupHeader>
);

// ---------------------------------------------------------------------------
// Doc Primary Mode
// ---------------------------------------------------------------------------

export const DocPrimaryModeValue = ({
  onChange,
  readonly,
}: PropertyValueProps) => {
  const t = useI18n();
  const doc = useService(DocService).doc;
  const primaryMode = useLiveData(doc.primaryMode$);

  const items = useMemo<RadioItem[]>(
    () => [
      { value: "page" as DocMode, label: t["Page"]() },
      { value: "edgeless" as DocMode, label: t["Edgeless"]() },
    ],
    [t],
  );

  const handleChange = useCallback(
    (mode: DocMode) => {
      doc.setPrimaryMode(mode);
      notify.success({
        title:
          mode === "page"
            ? t["com.myoxus.toastMessage.defaultMode.page.title"]()
            : t["com.myoxus.toastMessage.defaultMode.edgeless.title"](),
        message:
          mode === "page"
            ? t["com.myoxus.toastMessage.defaultMode.page.message"]()
            : t["com.myoxus.toastMessage.defaultMode.edgeless.message"](),
      });
      onChange?.(mode, true);
    },
    [doc, onChange, t],
  );

  return (
    <PropertyFieldCell hoverable={false} readonly={readonly}>
      <PropertyRadioGroup
        value={primaryMode}
        onChange={handleChange}
        items={items}
        disabled={readonly}
      />
    </PropertyFieldCell>
  );
};

export const DocPrimaryModeFilterValue = (props: PropertyFilterProps) => {
  const t = useI18n();
  return (
    <PropertyFilterMenu
      {...props}
      options={[
        {
          value: "page",
          label: t["Page"](),
          selected: props.filter.value !== "edgeless",
        },
        {
          value: "edgeless",
          label: t["Edgeless"](),
          selected: props.filter.value === "edgeless",
        },
      ]}
      displayLabel={
        props.filter.value === "edgeless" ? t["Edgeless"]() : t["Page"]()
      }
    />
  );
};

export const DocPrimaryModeDocListProperty = ({
  doc,
}: DocListPropertyProps) => {
  const t = useI18n();
  const primaryMode = useLiveData(doc.primaryMode$);
  const isEdgeless = primaryMode === "edgeless";

  return (
    <PropertyListBadge icon={isEdgeless ? <EdgelessIcon /> : <PageIcon />}>
      {isEdgeless ? t["Edgeless"]() : t["Page"]()}
    </PropertyListBadge>
  );
};

export const DocPrimaryModeGroupHeader = createMappedGroupHeader(
  (groupId, t) =>
    groupId === "edgeless"
      ? t["com.myoxus.edgelessMode"]()
      : groupId === "page"
        ? t["com.myoxus.pageMode"]()
        : "Default",
);

// ---------------------------------------------------------------------------
// Edgeless Theme
// ---------------------------------------------------------------------------

export const EdgelessThemeValue = ({
  onChange,
  readonly,
}: PropertyValueProps) => {
  const t = useI18n();
  const doc = useService(DocService).doc;
  const theme = useLiveData(doc.edgelessColorTheme$);

  const items = useMemo<RadioItem[]>(
    () => [
      { value: "system", label: t["com.myoxus.themeSettings.auto"]() },
      { value: "light", label: t["com.myoxus.themeSettings.light"]() },
      { value: "dark", label: t["com.myoxus.themeSettings.dark"]() },
    ],
    [t],
  );

  const handleChange = useCallback(
    (nextTheme: string) => {
      void doc.record.setEdgelessColorTheme(nextTheme);
      onChange?.(nextTheme, true);
    },
    [doc, onChange],
  );

  return (
    <PropertyFieldCell hoverable={false} readonly={readonly}>
      <PropertyRadioGroup
        value={theme || "system"}
        onChange={handleChange}
        items={items}
        disabled={readonly}
      />
    </PropertyFieldCell>
  );
};

export const EdgelessThemeDocListProperty = ({ doc }: { doc: DocRecord }) => {
  const t = useI18n();
  const theme = useLiveData(doc.edgelessColorTheme$);
  const label =
    !theme || theme === "system"
      ? t["com.myoxus.themeSettings.auto"]()
      : theme === "light"
        ? t["com.myoxus.themeSettings.light"]()
        : t["com.myoxus.themeSettings.dark"]();

  return <PropertyListBadge icon={<EdgelessIcon />}>{label}</PropertyListBadge>;
};

export const EdgelessThemeFilterValue = (props: PropertyFilterProps) => {
  const t = useI18n();
  const value = props.filter.value;
  return (
    <PropertyFilterMenu
      {...props}
      options={[
        { value: "system", label: t["com.myoxus.themeSettings.auto"]() },
        { value: "light", label: t["com.myoxus.themeSettings.light"]() },
        { value: "dark", label: t["com.myoxus.themeSettings.dark"]() },
      ]}
      displayLabel={
        value === "system"
          ? t["com.myoxus.themeSettings.auto"]()
          : value === "light"
            ? t["com.myoxus.themeSettings.light"]()
            : t["com.myoxus.themeSettings.dark"]()
      }
    />
  );
};

export const EdgelessThemeGroupHeader = createMappedGroupHeader((groupId, t) =>
  groupId === "light"
    ? t["com.myoxus.themeSettings.light"]()
    : groupId === "dark"
      ? t["com.myoxus.themeSettings.dark"]()
      : groupId === "system"
        ? t["com.myoxus.themeSettings.auto"]()
        : "Default",
);

// ---------------------------------------------------------------------------
// Page Width
// ---------------------------------------------------------------------------

export const PageWidthValue = ({ readonly }: PropertyValueProps) => {
  const t = useI18n();
  const defaultFullWidth = useLiveData(
    useService(EditorSettingService).editorSetting.settings$,
  ).fullWidthLayout;
  const doc = useService(DocService).doc;
  const pageWidth = useLiveData(doc.pageWidth$);

  const selected = pageWidth ?? (defaultFullWidth ? "fullWidth" : "standard");

  const items = useMemo<RadioItem[]>(
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
    (nextWidth: string) => {
      void doc.record.setPageWidth(nextWidth);
    },
    [doc],
  );

  return (
    <PropertyFieldCell hoverable={false} readonly={readonly}>
      <PropertyRadioGroup
        value={selected}
        onChange={handleChange}
        items={items}
        disabled={readonly}
      />
    </PropertyFieldCell>
  );
};

export const PageWidthDocListProperty = ({ doc }: { doc: DocRecord }) => {
  const t = useI18n();
  const pageWidth = useLiveData(doc.pageWidth$);

  return (
    <PropertyListBadge icon={<LongerIcon />}>
      {!pageWidth || pageWidth === "standard"
        ? t[
            "com.myoxus.settings.editorSettings.page.default-page-width.standard"
          ]()
        : t[
            "com.myoxus.settings.editorSettings.page.default-page-width.full-width"
          ]()}
    </PropertyListBadge>
  );
};

export const PageWidthFilterValue = (props: PropertyFilterProps) => {
  const t = useI18n();
  const fullLabel =
    t[
      "com.myoxus.settings.editorSettings.page.default-page-width.full-width"
    ]();
  const standardLabel =
    t["com.myoxus.settings.editorSettings.page.default-page-width.standard"]();

  return (
    <PropertyFilterMenu
      {...props}
      options={[
        {
          value: "fullWidth",
          label: fullLabel,
          selected: props.filter.value === "fullWidth",
        },
        {
          value: "standard",
          label: standardLabel,
          selected: props.filter.value !== "fullWidth",
        },
      ]}
      displayLabel={
        props.filter.value === "fullWidth" ? fullLabel : standardLabel
      }
    />
  );
};

export const PageWidthGroupHeader = createMappedGroupHeader((groupId, t) =>
  groupId === "fullWidth"
    ? t[
        "com.myoxus.settings.editorSettings.page.default-page-width.full-width"
      ]()
    : groupId === "standard"
      ? t[
          "com.myoxus.settings.editorSettings.page.default-page-width.standard"
        ]()
      : "Default",
);

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export const JournalValue = ({ readonly }: PropertyValueProps) => {
  const t = useI18n();
  const journalService = useService(JournalService);
  const doc = useService(DocService).doc;
  const journalDate = useLiveData(journalService.journalDate$(doc.id));
  const isJournal = Boolean(journalDate);

  const [selectedDate, setSelectedDate] = useState(() =>
    dayjs().format("YYYY-MM-DD"),
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (journalDate) setSelectedDate(journalDate);
  }, [journalDate]);

  const displayDate = useMemo(
    () => i18nTime(selectedDate, { absolute: { accuracy: "day" } }),
    [selectedDate],
  );

  const sameDayJournals = useLiveData(
    useMemo(
      () => journalService.journalsByDate$(selectedDate),
      [journalService, selectedDate],
    ),
  );
  const hasConflict = sameDayJournals.length > 1;

  const activeView = useLiveData(
    useService(WorkbenchService).workbench.activeView$,
  );
  const view = useServiceOptional(ViewService)?.view ?? activeView;

  const handleSelectDate = useCallback(
    (day: string) => {
      const normalized = dayjs(day).format("YYYY-MM-DD");
      setSelectedDate(normalized);
      journalService.setJournalDate(doc.id, normalized);
    },
    [doc.id, journalService],
  );

  const handleToggle = useCallback(
    (event: React.MouseEvent) => {
      if (readonly) return;
      if (!cellRef.current?.contains(event.target as Node)) return;
      if (isJournal) {
        journalService.removeJournalDate(doc.id);
        setPickerOpen(false);
      } else {
        handleSelectDate(selectedDate);
      }
    },
    [
      doc.id,
      handleSelectDate,
      isJournal,
      journalService,
      readonly,
      selectedDate,
    ],
  );

  const handleOpenConflict = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      view.showTool("calendar");
    },
    [view],
  );

  const cellRef = useRef<HTMLDivElement>(null);

  return (
    <PropertyFieldCell ref={cellRef} onClick={handleToggle} readonly={readonly}>
      <BadgeList>
        <BadgeListItem>
          <Checkbox checked={isJournal} disabled={readonly} />
        </BadgeListItem>
        {isJournal ? (
          <Menu
            contentOptions={{ onClick: stopClick }}
            rootOptions={{
              modal: true,
              open: !readonly && pickerOpen,
              onOpenChange: setPickerOpen,
            }}
            items={
              <DatePicker
                weekDays={t["com.myoxus.common.calendar.week-days"]()}
                monthNames={t["com.myoxus.common.calendar.month-names"]()}
                todayLabel={t["com.myoxus.common.calendar.today"]()}
                value={selectedDate}
                onChange={handleSelectDate}
              />
            }
          >
            <Button
              data-testid="date-selector"
              variant="plain"
              onClick={stopClick}
              disabled={readonly}
            >
              {displayDate}
            </Button>
          </Menu>
        ) : null}

        {isJournal && hasConflict ? (
          BUILD_CONFIG.isMobileEdition ? (
            <Menu items={<MobileJournalConflictList date={selectedDate} />}>
              <Badge
                data-testid="conflict-tag"
                tone="error"
                onClick={stopClick}
              >
                {t["com.myoxus.page-properties.property.journal-duplicated"]()}
              </Badge>
            </Menu>
          ) : (
            <Badge
              data-testid="conflict-tag"
              tone="error"
              onClick={handleOpenConflict}
            >
              {t["com.myoxus.page-properties.property.journal-duplicated"]()}
            </Badge>
          )
        ) : null}
      </BadgeList>
    </PropertyFieldCell>
  );
};

export const JournalFilterValue = BooleanPropertyFilterMenu;

export const JournalDocListProperty = ({ doc }: DocListPropertyProps) => {
  const journalDate = useLiveData(
    useService(JournalService).journalDate$(doc.id),
  );
  if (!journalDate) return null;

  return (
    <PropertyListBadge icon={<TodayIcon />}>
      {i18nTime(journalDate, { absolute: { accuracy: "day" } })}
    </PropertyListBadge>
  );
};

export const JournalGroupHeader = createMappedGroupHeader((groupId, t) =>
  groupId === "true"
    ? t["com.myoxus.all-docs.group.is-journal"]()
    : t["com.myoxus.all-docs.group.is-not-journal"](),
);

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export const TemplateValue = ({ readonly }: PropertyValueProps) => {
  const docService = useService(DocService);
  const isTemplate = useLiveData(docService.doc.isTemplate$);

  const handleCheckboxChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (readonly) return;
      void docService.doc.record.setTemplateState(event.target.checked);
    },
    [docService.doc.record, readonly],
  );

  const handleCellClick = useCallback(() => {
    if (readonly) return;
    void docService.doc.record.setTemplateState(!isTemplate);
  }, [docService.doc.record, isTemplate, readonly]);

  return (
    <PropertyFieldCell onClick={handleCellClick} readonly>
      <Checkbox
        data-testid="toggle-template-checkbox"
        checked={Boolean(isTemplate)}
        onChange={handleCheckboxChange}
        onClick={stopClick}
        disabled={readonly}
      />
    </PropertyFieldCell>
  );
};

export const TemplateDocListProperty = ({ doc }: { doc: DocRecord }) => {
  const t = useI18n();
  const isTemplate = useLiveData(doc.isTemplate$);
  if (!isTemplate) return null;

  return (
    <PropertyListBadge icon={<TemplateIcon />}>
      {t["Template"]()}
    </PropertyListBadge>
  );
};

export const TemplateGroupHeader = createMappedGroupHeader((groupId, t) =>
  groupId === "true"
    ? t["com.myoxus.all-docs.group.is-template"]()
    : groupId === "false"
      ? t["com.myoxus.all-docs.group.is-not-template"]()
      : "Default",
);

export const TemplateFilterValue = BooleanPropertyFilterMenu;
