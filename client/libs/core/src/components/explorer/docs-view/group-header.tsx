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
  const contextValue = useContext(DocExplorerContext);
  const groups = useLiveData(contextValue.groups$);
  const selectedDocIds = useLiveData(contextValue.selectedDocIds$);
  const group = groups.find((candidate) => candidate.key === groupId);
  const hasItems = Boolean(group?.items.length);
  const isGroupAllSelected =
    hasItems && group?.items.every((id) => selectedDocIds.includes(id));
  const selectedCount = group?.items.filter((id) =>
    selectedDocIds.includes(id),
  ).length;

  const handleSelectAll = useCallback(() => {
    const previousIds = contextValue.selectedDocIds$.value;
    const nextIds = isGroupAllSelected
      ? previousIds.filter((id) => !group?.items.includes(id))
      : [...new Set([...previousIds, ...(group?.items ?? [])])];
    contextValue.selectedDocIds$.next(nextIds);
    contextValue.selectMode$?.next(nextIds.length > 0);
  }, [contextValue, group?.items, isGroupAllSelected]);

  if (!hasItems) return null;

  return (
    <Checkbox
      aria-label={t[
        isGroupAllSelected
          ? "com.myoxus.common.clear-selection"
          : "com.myoxus.page.group-header.select-all"
      ]()}
      checked={Boolean(isGroupAllSelected)}
      data-myoxus-ui-role="surface-list-group-action"
      indeterminate={Boolean(selectedCount && !isGroupAllSelected)}
      onClick={(event) => event.stopPropagation()}
      onChange={handleSelectAll}
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
  const contextValue = useContext(DocExplorerContext);

  const groups = useLiveData(contextValue.groups$);
  const selectedDocIds = useLiveData(contextValue.selectedDocIds$);
  const collapsedGroups = useLiveData(contextValue.collapsedGroups$);
  const selectMode = useLiveData(contextValue.selectMode$);
  const view = useLiveData(contextValue.view$);

  const group = groups.find((g) => g.key === groupId);
  const handleToggleCollapse = useCallback(() => {
    const prev = contextValue.collapsedGroups$.value;
    contextValue.collapsedGroups$.next(
      prev.includes(groupId)
        ? prev.filter((id) => id !== groupId)
        : [...prev, groupId],
    );
  }, [groupId, contextValue]);

  const selectedCount = group?.items.filter((id) =>
    selectedDocIds.includes(id),
  ).length;
  const collapsed = collapsedGroups.includes(groupId);
  const groupLabel = (
    <SurfaceListHeaderTitle data-myoxus-ui-role="surface-list-group-title">
      {children}
    </SurfaceListHeaderTitle>
  );

  if (view === "list") {
    return (
      <Group
        {...props}
        className={className}
        data-myoxus-ui-role="surface-list-group-label"
        wrap="nowrap"
      >
        {groupLabel}
        {selectMode ? (
          <MyoxusText
            component="span"
            tone="secondary"
            typographySlot="nav"
            data-myoxus-ui-role="surface-list-group-meta"
          >
            {selectedCount}/{group?.items.length}
          </MyoxusText>
        ) : null}
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
      {selectMode ? (
        <MyoxusText
          component="span"
          tone="secondary"
          typographySlot="nav"
          data-myoxus-ui-role="surface-list-group-meta"
        >
          {selectedCount}/{group?.items.length}
        </MyoxusText>
      ) : null}
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
}) => {
  return (
    <DocGroupHeader
      actions={actions}
      className={className}
      groupId={groupId}
      {...props}
    >
      {icon ? (
        <SurfaceListItemIcon size="sm">{icon}</SurfaceListItemIcon>
      ) : null}
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
};
