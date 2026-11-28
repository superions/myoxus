// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { GroupByParams } from "@myoxus/core/modules/collection-rules/types";
import { WorkspacePropertyService } from "@myoxus/core/modules/workspace-property";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import { Divider, MenuItem } from "@myoxus/ui-facade";
import { useMemo } from "react";

import { WorkspacePropertyName } from "../../properties";
import {
  isSupportedSystemPropertyType,
  SystemPropertyTypes,
} from "../../system-property-types";
import {
  isSupportedWorkspacePropertyType,
  WorkspacePropertyTypes,
} from "../../workspace-property-types";
import {
  type ExplorerPropertyEntry,
  generateExplorerPropertyList,
} from "../properties";

const WorkspaceGroupByLabel = ({ groupBy }: { groupBy: GroupByParams }) => {
  const propertyInfo = useLiveData(
    useService(WorkspacePropertyService).propertyInfo$(groupBy.key),
  );
  return propertyInfo ? (
    <WorkspacePropertyName propertyInfo={propertyInfo} />
  ) : null;
};

export const GroupByName = ({ groupBy }: { groupBy: GroupByParams }) => {
  const t = useI18n();
  if (groupBy.type === "property") {
    return <WorkspaceGroupByLabel groupBy={groupBy} />;
  }
  if (groupBy.type === "system") {
    const descriptor = isSupportedSystemPropertyType(groupBy.key)
      ? SystemPropertyTypes[groupBy.key]
      : null;
    return descriptor ? t.t(descriptor.name) : null;
  }
  return null;
};

const GroupByOption = ({
  entry,
  groupBy,
  onChange,
}: {
  entry: ExplorerPropertyEntry;
  groupBy?: GroupByParams;
  onChange?: (next: GroupByParams) => void;
}) => {
  const t = useI18n();
  const { systemProperty, workspaceProperty } = entry;

  const allowed = systemProperty
    ? "allowInGroupBy" in systemProperty && systemProperty.allowInGroupBy
    : workspaceProperty
      ? isSupportedWorkspacePropertyType(workspaceProperty.type) &&
        WorkspacePropertyTypes[workspaceProperty.type].allowInGroupBy
      : false;

  if (!allowed) {
    return null;
  }

  const nextValue: GroupByParams | null = systemProperty
    ? { type: "system", key: systemProperty.type }
    : workspaceProperty
      ? { type: "property", key: workspaceProperty.id }
      : null;

  const selected = Boolean(
    nextValue &&
    groupBy?.type === nextValue.type &&
    groupBy?.key === nextValue.key,
  );

  const label = workspaceProperty ? (
    <WorkspacePropertyName propertyInfo={workspaceProperty} />
  ) : systemProperty ? (
    t.t(systemProperty.name)
  ) : null;

  return (
    <MenuItem
      selected={selected}
      onClick={(event) => {
        event.preventDefault();
        track.allDocs.header.displayMenu.editDisplayMenu({
          control: "groupBy",
          type: systemProperty?.type ?? "custom-property",
        });
        if (nextValue) {
          onChange?.(nextValue);
        }
      }}
    >
      {label}
    </MenuItem>
  );
};

export const GroupByList = ({
  groupBy,
  onChange,
}: {
  groupBy?: GroupByParams;
  onChange?: (next: GroupByParams | undefined) => void;
}) => {
  const t = useI18n();
  const properties = useLiveData(
    useService(WorkspacePropertyService).sortedProperties$,
  );
  const entries = useMemo(
    () => generateExplorerPropertyList(properties),
    [properties],
  );

  return (
    <>
      {entries.map((entry) => (
        <GroupByOption
          key={entry.systemProperty?.type ?? entry.workspaceProperty?.id}
          entry={entry}
          groupBy={groupBy}
          onChange={onChange}
        />
      ))}
      <Divider size="thinner" space={4} />
      <MenuItem onClick={() => onChange?.(undefined)}>
        {t["com.myoxus.explorer.display-menu.grouping.remove"]()}
      </MenuItem>
    </>
  );
};
