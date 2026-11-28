// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { WorkspacePropertyService } from "@myoxus/core/modules/workspace-property";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import {
  Divider,
  MenuOptionButton,
  MenuOptionGroup,
  MenuSection,
  MenuSectionLabel,
} from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import { WorkspacePropertyName } from "../../properties";
import { WorkspacePropertyTypes } from "../../workspace-property-types";
import {
  type ExplorerPropertyEntry,
  generateExplorerPropertyList,
} from "../properties";
import type { ExplorerDisplayPreference } from "../types";

const PropertyToggleChip = ({
  entry,
  activeKeys,
  onToggle,
  required = false,
}: {
  entry: ExplorerPropertyEntry;
  activeKeys: readonly string[];
  onToggle: (key: string) => void;
  required?: boolean;
}) => {
  const t = useI18n();
  const { systemProperty, workspaceProperty } = entry;
  const key = systemProperty
    ? `system:${systemProperty.type}`
    : workspaceProperty
      ? `property:${workspaceProperty.id}`
      : null;

  const visibleInList =
    systemProperty?.showInDocList ||
    (workspaceProperty &&
      WorkspacePropertyTypes[workspaceProperty.type]?.showInDocList);

  if (!key || (!visibleInList && !required)) {
    return null;
  }

  return (
    <MenuOptionButton
      active={activeKeys.includes(key)}
      disabled={required}
      data-key={key}
      onClick={() => {
        track.allDocs.header.displayMenu.editDisplayMenu({
          control: "displayProperties",
          type: systemProperty?.type ?? "custom-property",
        });
        onToggle(key);
      }}
    >
      {workspaceProperty ? (
        <WorkspacePropertyName propertyInfo={workspaceProperty} />
      ) : systemProperty ? (
        t.t(systemProperty.name)
      ) : null}
    </MenuOptionButton>
  );
};

export const DisplayProperties = ({
  displayPreference,
  onDisplayPreferenceChange,
  systemPropertyKeys,
  requiredSystemProperties = [],
}: {
  displayPreference: ExplorerDisplayPreference;
  onDisplayPreferenceChange: (
    displayPreference: ExplorerDisplayPreference,
  ) => void;
  /** Restricts the catalogue when rendered inside scoped registers. */
  systemPropertyKeys?: readonly string[];
  requiredSystemProperties?: readonly string[];
}) => {
  const t = useI18n();
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

  const systemEntries = useMemo(
    () => entries.filter((entry) => Boolean(entry.systemProperty)),
    [entries],
  );
  const customEntries = useMemo(
    () => entries.filter((entry) => !entry.systemProperty),
    [entries],
  );

  const activeKeys = displayPreference.displayProperties ?? [];
  const showIcon = displayPreference.showDocIcon ?? false;
  const showPreview = displayPreference.showDocPreview ?? false;

  const togglePropertyKey = useCallback(
    (key: string) => {
      const next = activeKeys.includes(key)
        ? activeKeys.filter((item) => item !== key)
        : [...activeKeys, key];
      onDisplayPreferenceChange({
        ...displayPreference,
        displayProperties: next,
      });
    },
    [activeKeys, displayPreference, onDisplayPreferenceChange],
  );

  return (
    <MenuSection>
      <MenuSectionLabel>
        {t["com.myoxus.all-docs.display.properties"]()}
      </MenuSectionLabel>

      <MenuOptionGroup>
        {systemEntries.map((entry) => (
          <PropertyToggleChip
            key={entry.systemProperty!.type}
            entry={entry}
            activeKeys={activeKeys}
            onToggle={togglePropertyKey}
            required={requiredSystemProperties.includes(
              entry.systemProperty!.type,
            )}
          />
        ))}
      </MenuOptionGroup>

      <MenuOptionGroup>
        {customEntries.map((entry) => (
          <PropertyToggleChip
            key={entry.workspaceProperty?.id}
            entry={entry}
            activeKeys={activeKeys}
            onToggle={togglePropertyKey}
          />
        ))}
      </MenuOptionGroup>

      {displayPreference.view === "list" ? (
        <>
          <Divider space={4} size="thinner" />
          <MenuSectionLabel>
            {t["com.myoxus.all-docs.display.list-view"]()}
          </MenuSectionLabel>
          <MenuOptionGroup>
            <MenuOptionButton
              active={showIcon}
              onClick={() =>
                onDisplayPreferenceChange({
                  ...displayPreference,
                  showDocIcon: !showIcon,
                })
              }
            >
              {t["com.myoxus.all-docs.display.list-view.icon"]()}
            </MenuOptionButton>
            <MenuOptionButton
              active={showPreview}
              onClick={() =>
                onDisplayPreferenceChange({
                  ...displayPreference,
                  showDocPreview: !showPreview,
                })
              }
            >
              {t["com.myoxus.all-docs.display.list-view.body"]()}
            </MenuOptionButton>
          </MenuOptionGroup>
        </>
      ) : null}
    </MenuSection>
  );
};
