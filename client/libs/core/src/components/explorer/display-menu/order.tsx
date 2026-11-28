// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { OrderByParams } from "@myoxus/core/modules/collection-rules/types";
import { WorkspacePropertyService } from "@myoxus/core/modules/workspace-property";
import { useI18n } from "@myoxus/i18n";
import { SortDownIcon, SortUpIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import { MenuItem } from "@myoxus/ui-facade";
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

const WorkspaceOrderByLabel = ({ orderBy }: { orderBy: OrderByParams }) => {
  const propertyInfo = useLiveData(
    useService(WorkspacePropertyService).propertyInfo$(orderBy.key),
  );
  return propertyInfo ? (
    <WorkspacePropertyName propertyInfo={propertyInfo} />
  ) : null;
};

export const OrderByName = ({ orderBy }: { orderBy: OrderByParams }) => {
  const t = useI18n();
  if (orderBy.type === "property") {
    return <WorkspaceOrderByLabel orderBy={orderBy} />;
  }
  if (orderBy.type === "system") {
    const descriptor = isSupportedSystemPropertyType(orderBy.key)
      ? SystemPropertyTypes[orderBy.key]
      : null;
    return descriptor ? t.t(descriptor.name) : null;
  }
  return null;
};

const OrderByOption = ({
  entry,
  orderBy,
  onChange,
}: {
  entry: ExplorerPropertyEntry;
  orderBy?: OrderByParams;
  onChange?: (next: OrderByParams) => void;
}) => {
  const t = useI18n();
  const { systemProperty, workspaceProperty } = entry;

  const allowed = systemProperty
    ? "allowInOrderBy" in systemProperty && systemProperty.allowInOrderBy
    : workspaceProperty
      ? isSupportedWorkspacePropertyType(workspaceProperty.type) &&
        WorkspacePropertyTypes[workspaceProperty.type].allowInOrderBy
      : false;

  if (!allowed) {
    return null;
  }

  const targetType = systemProperty ? "system" : "property";
  const targetKey = systemProperty?.type ?? workspaceProperty?.id;
  if (!targetKey) {
    return null;
  }

  const active = orderBy?.type === targetType && orderBy?.key === targetKey;
  const nextOrder: OrderByParams = {
    type: targetType,
    key: targetKey,
    desc: active ? !orderBy.desc : false,
  };

  const label = workspaceProperty ? (
    <WorkspacePropertyName propertyInfo={workspaceProperty} />
  ) : systemProperty ? (
    t.t(systemProperty.name)
  ) : null;

  return (
    <MenuItem
      selected={active}
      suffixIcon={
        active ? orderBy.desc ? <SortDownIcon /> : <SortUpIcon /> : null
      }
      onClick={(event) => {
        event.preventDefault();
        track.allDocs.header.displayMenu.editDisplayMenu({
          control: "orderBy",
          type: systemProperty?.type ?? "custom-property",
        });
        onChange?.(nextOrder);
      }}
    >
      {label}
    </MenuItem>
  );
};

export const OrderByList = ({
  orderBy,
  onChange,
  systemPropertyKeys,
}: {
  orderBy?: OrderByParams;
  onChange?: (next: OrderByParams) => void;
  /** Restricts the canonical system-property selector for scoped registers. */
  systemPropertyKeys?: readonly string[];
}) => {
  const properties = useLiveData(
    useService(WorkspacePropertyService).sortedProperties$,
  );
  const entries = useMemo(
    () =>
      generateExplorerPropertyList(properties).filter(
        (entry) =>
          !systemPropertyKeys ||
          (entry.systemProperty &&
            systemPropertyKeys.includes(entry.systemProperty.type)),
      ),
    [properties, systemPropertyKeys],
  );

  return (
    <>
      {entries.map((entry) => (
        <OrderByOption
          key={entry.systemProperty?.type ?? entry.workspaceProperty?.id}
          entry={entry}
          orderBy={orderBy}
          onChange={onChange}
        />
      ))}
    </>
  );
};
