import { type DocRecord, DocService } from "@myoxus/core/modules/doc";
import { i18nTime, useI18n } from "@myoxus/i18n";
import { useLiveData, useServices } from "@myoxus/infra";
import {
  MyoxusText,
  PropertyValue,
  SurfaceListMeta,
  Tooltip,
} from "@myoxus/ui-facade";

import { PlainTextDocGroupHeader } from "../explorer/docs-view/group-header";
import type { GroupHeaderProps } from "../explorer/types";

const toRelativeDate = (time: string | number) => {
  return i18nTime(time, {
    relative: {
      max: [1, "day"],
      accuracy: "day",
    },
    absolute: {
      accuracy: "day",
    },
  });
};

const capitalizeDateCopy = (value: string) =>
  value ? value[0].toLocaleUpperCase() + value.slice(1) : value;

const MetaDateValueFactory = ({
  type,
}: {
  type: "createDate" | "updatedDate";
}) =>
  function ReadonlyDateValue() {
    const { docService } = useServices({
      DocService,
    });

    const docMeta = useLiveData(docService.doc.meta$);
    const value = docMeta?.[type];

    const relativeDate = value ? toRelativeDate(value) : null;
    const date = value ? i18nTime(value) : null;

    return (
      <Tooltip content={date} side="top" align="end">
        <PropertyValue isEmpty={!relativeDate}>{relativeDate}</PropertyValue>
      </Tooltip>
    );
  };

export const CreateAtValue = MetaDateValueFactory({
  type: "createDate",
});

export const UpdatedAtValue = MetaDateValueFactory({
  type: "updatedDate",
});

export const CreatedAtGroupHeader = ({
  groupId,
  docCount,
}: GroupHeaderProps) => {
  const date = groupId
    ? capitalizeDateCopy(toRelativeDate(groupId))
    : "No Date";
  return (
    <PlainTextDocGroupHeader groupId={groupId} docCount={docCount}>
      {date}
    </PlainTextDocGroupHeader>
  );
};

export const UpdatedAtGroupHeader = ({
  groupId,
  docCount,
}: GroupHeaderProps) => {
  const t = useI18n();
  const date = groupId
    ? capitalizeDateCopy(toRelativeDate(groupId))
    : t["com.myoxus.all-docs.group.updated-at.never-updated"]();
  return (
    <PlainTextDocGroupHeader groupId={groupId} docCount={docCount}>
      {date}
    </PlainTextDocGroupHeader>
  );
};

const DateDocListProperty = ({
  label,
  time,
  tooltip,
}: {
  label: string;
  time?: number | string;
  tooltip: (absoluteTime: string) => string;
}) => {
  if (time === undefined || time === null || time === "") return null;

  const relativeTime = i18nTime(time, { relative: true });
  const absoluteTime = i18nTime(time);
  const accessibleLabel = `${label}: ${relativeTime}`;

  return (
    <Tooltip content={capitalizeDateCopy(tooltip(absoluteTime))}>
      <SurfaceListMeta
        aria-label={accessibleLabel}
        title={`${label}: ${absoluteTime}`}
        layout="row-cluster"
      >
        <MyoxusText component="span" typographySlot="body-small" truncate>
          {relativeTime}
        </MyoxusText>
      </SurfaceListMeta>
    </Tooltip>
  );
};

export const CreateAtDocListProperty = ({ doc }: { doc: DocRecord }) => {
  const t = useI18n();
  const docMeta = useLiveData(doc.meta$);
  const createDate = docMeta?.createDate;

  return (
    <DateDocListProperty
      label={t["com.myoxus.page-properties.property.createdAt"]()}
      time={createDate}
      tooltip={(time) => t.t("created at", { time })}
    />
  );
};

export const UpdatedAtDocListProperty = ({ doc }: { doc: DocRecord }) => {
  const t = useI18n();
  const docMeta = useLiveData(doc.meta$);
  const updatedDate = docMeta?.updatedDate;

  return (
    <DateDocListProperty
      label={t["com.myoxus.page-properties.property.updatedAt"]()}
      time={updatedDate}
      tooltip={(time) => t.t("updated at", { time })}
    />
  );
};

export { DateFilterValue as CreatedAtFilterValue } from "./date";
export { DateFilterValue as UpdatedAtFilterValue } from "./date";
