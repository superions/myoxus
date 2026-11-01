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
import { generateExplorerPropertyList } from "../properties";
import type { ExplorerDisplayPreference } from "../types";

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
  /** Omission retains the full Explorer catalogue; scoped registers admit only their native keys. */
  systemPropertyKeys?: readonly string[];
  requiredSystemProperties?: readonly string[];
}) => {
  const t = useI18n();
  const workspacePropertyService = useService(WorkspacePropertyService);
  const propertyList = useLiveData(workspacePropertyService.sortedProperties$);
  const explorerPropertyList = useMemo(() => {
    return generateExplorerPropertyList(propertyList).filter(
      (property) =>
        !systemPropertyKeys ||
        (property.systemProperty &&
          systemPropertyKeys.includes(property.systemProperty.type)),
    );
  }, [propertyList, systemPropertyKeys]);

  const displayProperties = displayPreference.displayProperties;
  const showIcon = displayPreference.showDocIcon ?? false;
  const showBody = displayPreference.showDocPreview ?? false;

  const handleDisplayPropertiesChange = useCallback(
    (displayProperties: string[]) => {
      onDisplayPreferenceChange({ ...displayPreference, displayProperties });
    },
    [displayPreference, onDisplayPreferenceChange],
  );

  const handlePropertyClick = useCallback(
    (key: string) => {
      handleDisplayPropertiesChange(
        displayProperties && displayProperties.includes(key)
          ? displayProperties.filter((k) => k !== key)
          : [...(displayProperties || []), key],
      );
    },
    [displayProperties, handleDisplayPropertiesChange],
  );

  const toggleIcon = useCallback(() => {
    onDisplayPreferenceChange({
      ...displayPreference,
      showDocIcon: !showIcon,
    });
  }, [displayPreference, onDisplayPreferenceChange, showIcon]);

  const toggleBody = useCallback(() => {
    onDisplayPreferenceChange({
      ...displayPreference,
      showDocPreview: !showBody,
    });
  }, [displayPreference, onDisplayPreferenceChange, showBody]);

  return (
    <MenuSection>
      <MenuSectionLabel>
        {t["com.myoxus.all-docs.display.properties"]()}
      </MenuSectionLabel>
      <MenuOptionGroup>
        {explorerPropertyList
          .filter((p) => p.systemProperty)
          .map((property) => {
            return (
              <PropertyRenderer
                key={
                  property.systemProperty?.type ??
                  property.workspaceProperty?.id
                }
                property={property}
                displayProperties={displayProperties ?? []}
                handlePropertyClick={handlePropertyClick}
                required={requiredSystemProperties.includes(
                  property.systemProperty!.type,
                )}
              />
            );
          })}
      </MenuOptionGroup>
      <MenuOptionGroup>
        {explorerPropertyList
          .filter((p) => !p.systemProperty)
          .map((property) => {
            return (
              <PropertyRenderer
                key={
                  property.systemProperty?.type ??
                  property.workspaceProperty?.id
                }
                property={property}
                displayProperties={displayProperties ?? []}
                handlePropertyClick={handlePropertyClick}
              />
            );
          })}
      </MenuOptionGroup>
      {displayPreference.view === "list" ? (
        <>
          <Divider space={4} size="thinner" />
          <MenuSectionLabel>
            {t["com.myoxus.all-docs.display.list-view"]()}
          </MenuSectionLabel>
          <MenuOptionGroup>
            <MenuOptionButton active={showIcon} onClick={toggleIcon}>
              {t["com.myoxus.all-docs.display.list-view.icon"]()}
            </MenuOptionButton>
            <MenuOptionButton active={showBody} onClick={toggleBody}>
              {t["com.myoxus.all-docs.display.list-view.body"]()}
            </MenuOptionButton>
          </MenuOptionGroup>
        </>
      ) : null}
    </MenuSection>
  );
};

const PropertyRenderer = ({
  property,
  displayProperties,
  handlePropertyClick,
  required = false,
}: {
  property: ReturnType<typeof generateExplorerPropertyList>[number];
  displayProperties: string[];
  handlePropertyClick: (key: string) => void;
  required?: boolean;
}) => {
  const t = useI18n();
  const { systemProperty, workspaceProperty } = property;
  const key = systemProperty
    ? `system:${systemProperty.type}`
    : workspaceProperty
      ? `property:${workspaceProperty?.id}`
      : null;
  const activeKey = systemProperty
    ? `system:${systemProperty.type}`
    : workspaceProperty
      ? `property:${workspaceProperty?.id}`
      : null;
  const isActive = activeKey && displayProperties.includes(activeKey);

  const showInDocList =
    systemProperty?.showInDocList ||
    (workspaceProperty &&
      WorkspacePropertyTypes[workspaceProperty.type]?.showInDocList);

  if (!key || (!showInDocList && !required)) {
    return null;
  }
  return (
    <MenuOptionButton
      key={key}
      active={!!isActive}
      disabled={required}
      onClick={() => {
        track.allDocs.header.displayMenu.editDisplayMenu({
          control: "displayProperties",
          type: systemProperty?.type ?? "custom-property",
        });
        handlePropertyClick(key);
      }}
      data-key={key}
    >
      {workspaceProperty ? (
        <WorkspacePropertyName propertyInfo={workspaceProperty} />
      ) : systemProperty ? (
        t.t(systemProperty.name)
      ) : null}
    </MenuOptionButton>
  );
};
