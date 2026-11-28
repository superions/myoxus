// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { ChevronDownIcon, ChevronRightIcon } from "@myoxus/icons/react";
import { useLiveData } from "@myoxus/infra";
import {
  Checkbox,
  Group,
  IconButton,
  MyoxusText,
  SurfaceListHeader,
  SurfaceListHeaderTitle,
  SurfaceListItemIcon,
  SurfaceListSpacer,
} from "@myoxus/ui-facade";
import {
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
} from "react";

import { DocExplorerContext } from "../context";

export const DocGroupSelection = ({ groupId }: { groupId: string }) => {
  const t = useI18n();
  const context = useContext(DocExplorerContext);
  const groups = useLiveData(context.groups$);
  const selectedDocIds = useLiveData(context.selectedDocIds$);

  const group = groups.find((candidate) => candidate.key === groupId);
  const itemIds = group?.items ?? [];
  const selectedCount = itemIds.filter((id) =>
    selectedDocIds.includes(id),
  ).length;
  const allSelected = itemIds.length > 0 && selectedCount === itemIds.length;

  const handleToggleAll = useCallback(() => {
    const current = context.selectedDocIds$.value;
    const next = allSelected
      ? current.filter((id) => !itemIds.includes(id))
      : Array.from(new Set([...current, ...itemIds]));
    context.selectedDocIds$.next(next);
    context.selectMode$?.next(next.length > 0);
  }, [allSelected, context, itemIds]);

  if (itemIds.length === 0) {
    return null;
  }

  return (
    <Checkbox
      aria-label={t[
        allSelected
          ? "com.myoxus.common.clear-selection"
          : "com.myoxus.page.group-header.select-all"
      ]()}
      checked={allSelected}
      data-myoxus-ui-role="surface-list-group-action"
      indeterminate={selectedCount > 0 && !allSelected}
      onClick={(event) => event.stopPropagation()}
      onChange={handleToggleAll}
      size="xs"
    />
  );
};

export const DocGroupHeader = ({
  children,
  className,
  groupId,
  actions,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  groupId: string;
  actions?: ReactNode;
}) => {
  const t = useI18n();
  const context = useContext(DocExplorerContext);
  const groups = useLiveData(context.groups$);
  const selectedDocIds = useLiveData(context.selectedDocIds$);
  const collapsedGroups = useLiveData(context.collapsedGroups$);
  const selectMode = useLiveData(context.selectMode$);
  const view = useLiveData(context.view$);

  const group = groups.find((candidate) => candidate.key === groupId);
  const selectedCount = group?.items.filter((id) =>
    selectedDocIds.includes(id),
  ).length;
  const collapsed = collapsedGroups.includes(groupId);

  const handleToggleCollapse = useCallback(() => {
    const prev = context.collapsedGroups$.value;
    context.collapsedGroups$.next(
      prev.includes(groupId)
        ? prev.filter((id) => id !== groupId)
        : [...prev, groupId],
    );
  }, [context.collapsedGroups$, groupId]);

  const selectionCounter = selectMode ? (
    <MyoxusText
      component="span"
      tone="secondary"
      typographySlot="nav"
      data-myoxus-ui-role="surface-list-group-meta"
    >
      {selectedCount}/{group?.items.length}
    </MyoxusText>
  ) : null;

  if (view === "list") {
    return (
      <Group
        {...props}
        className={className}
        data-myoxus-ui-role="surface-list-group-label"
        wrap="nowrap"
      >
        <SurfaceListHeaderTitle data-myoxus-ui-role="surface-list-group-title">
          {children}
        </SurfaceListHeaderTitle>
        {selectionCounter}
        {actions ? <SurfaceListSpacer /> : null}
        {actions}
      </Group>
    );
  }

  return (
    <SurfaceListHeader
      density="section"
      data-collapsed={collapsed}
      data-myoxus-ui-role="surface-list-group-header"
    >
      <IconButton
        aria-expanded={!collapsed}
        aria-label={
          collapsed ? t["admin.common.expand"]() : t["admin.common.collapse"]()
        }
        icon={
          collapsed ? (
            <ChevronRightIcon
              aria-hidden="true"
              data-myoxus-ui-role="surface-list-group-disclosure"
            />
          ) : (
            <ChevronDownIcon
              aria-hidden="true"
              data-myoxus-ui-role="surface-list-group-disclosure"
            />
          )
        }
        onClick={handleToggleCollapse}
        size="small"
        withoutHover
      />
      <SurfaceListHeaderTitle className={className} {...props}>
        {children}
      </SurfaceListHeaderTitle>
      {selectionCounter}
      <SurfaceListSpacer />
      {actions}
      <DocGroupSelection groupId={groupId} />
    </SurfaceListHeader>
  );
};

export const PlainTextDocGroupHeader = ({
  groupId,
  docCount,
  className,
  children,
  icon,
  actions,
  status,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  groupId: string;
  docCount: number;
  icon?: ReactNode;
  actions?: ReactNode;
  status?: ReactNode;
}) => (
  <DocGroupHeader
    actions={actions}
    className={className}
    groupId={groupId}
    {...props}
  >
    {icon ? <SurfaceListItemIcon size="sm">{icon}</SurfaceListItemIcon> : null}
    <MyoxusText component="span" typographySlot="nav" tone="secondary">
      {children ?? groupId}
    </MyoxusText>
    {status}
    <MyoxusText component="span" typographySlot="nav" tone="tertiary">
      ·
    </MyoxusText>
    <MyoxusText component="span" typographySlot="nav" tone="tertiary">
      {docCount}
    </MyoxusText>
  </DocGroupHeader>
);
