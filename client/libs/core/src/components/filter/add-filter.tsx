import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { WorkspacePropertyService } from "@myoxus/core/modules/workspace-property";
import { useI18n } from "@myoxus/i18n";
import {
  ArrowLeftBigIcon,
  CloudWorkspaceIcon,
  FavoriteIcon,
  PlusIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  IconButton,
  Menu,
  MenuDetailRow,
  MenuInlineText,
  MenuItem,
  MenuScrollableSection,
  MenuSeparator,
} from "@myoxus/ui-facade";
import { useMemo } from "react";

import { generateExplorerPropertyList } from "../explorer/properties";
import { WorkspacePropertyIcon, WorkspacePropertyName } from "../properties";
import { WorkspacePropertyTypes } from "../workspace-property-types";

export const AddFilterMenu = ({
  onAdd,
  onBack,
  includeAllPagesOnly,
}: {
  onAdd: (params: FilterParams) => void;
  onBack?: () => void;
  includeAllPagesOnly?: boolean;
}) => {
  const t = useI18n();
  const workspacePropertyService = useService(WorkspacePropertyService);
  const workspaceProperties = useLiveData(
    workspacePropertyService.sortedProperties$,
  );
  const explorerPropertyList = useMemo(
    () =>
      generateExplorerPropertyList(workspaceProperties, {
        includeAllPagesOnly,
      }),
    [includeAllPagesOnly, workspaceProperties],
  );

  return (
    <>
      <MenuDetailRow justify="start" data-myoxus-ui-role="filter-menu-header">
        {onBack && (
          <IconButton
            aria-label="Back"
            icon={<ArrowLeftBigIcon />}
            onClick={onBack}
          />
        )}
        <MenuInlineText truncate={false}>
          {t["com.myoxus.filter"]()}
        </MenuInlineText>
      </MenuDetailRow>

      <MenuSeparator />
      <MenuItem
        data-myoxus-ui-role="filter-menu-favorite-option"
        prefixIcon={<FavoriteIcon />}
        key={"favorite"}
        onClick={() => {
          onAdd({
            type: "system",
            key: "favorite",
            method: "is",
            value: "true",
          });
        }}
      >
        {t["Favorited"]()}
      </MenuItem>
      <MenuItem
        prefixIcon={<CloudWorkspaceIcon />}
        key={"shared"}
        onClick={() => {
          onAdd({
            type: "system",
            key: "shared",
            method: "is",
            value: "true",
          });
        }}
      >
        {t["com.myoxus.filter.is-public"]()}
      </MenuItem>
      <MenuScrollableSection data-myoxus-ui-role="filter-menu-options">
        {explorerPropertyList.map(({ systemProperty, workspaceProperty }) => {
          if (systemProperty) {
            const defaultFilter =
              "defaultFilter" in systemProperty && systemProperty.defaultFilter;
            if (!defaultFilter) {
              return null;
            }
            return (
              <MenuItem
                prefixIcon={<systemProperty.icon />}
                key={systemProperty.type}
                onClick={() => {
                  onAdd({
                    type: "system",
                    key: systemProperty.type,
                    ...defaultFilter,
                  });
                }}
              >
                {t.t(systemProperty.name)}
              </MenuItem>
            );
          } else if (workspaceProperty) {
            const type = WorkspacePropertyTypes[workspaceProperty.type];
            const defaultFilter = type?.defaultFilter;
            if (!defaultFilter) {
              return null;
            }
            return (
              <MenuItem
                prefixIcon={
                  <WorkspacePropertyIcon propertyInfo={workspaceProperty} />
                }
                key={workspaceProperty.id}
                onClick={() => {
                  onAdd({
                    type: "property",
                    key: workspaceProperty.id,
                    ...defaultFilter,
                  });
                }}
              >
                <WorkspacePropertyName propertyInfo={workspaceProperty} />
              </MenuItem>
            );
          }
          return null;
        })}
      </MenuScrollableSection>
    </>
  );
};

export const AddFilter = ({
  onAdd,
  variant = "icon-button",
  includeAllPagesOnly,
}: {
  onAdd: (params: FilterParams) => void;
  variant?: "icon-button" | "button";
  includeAllPagesOnly?: boolean;
}) => {
  const t = useI18n();
  return (
    <Menu
      items={
        <AddFilterMenu
          includeAllPagesOnly={includeAllPagesOnly}
          onAdd={onAdd}
        />
      }
      contentOptions={{
        panelWidth: "default",
      }}
    >
      {variant === "icon-button" ? (
        <IconButton
          aria-label={t["com.myoxus.filter.add-filter"]()}
          icon={<PlusIcon />}
        />
      ) : (
        <Button prefix={<PlusIcon />}>
          {t["com.myoxus.filter.add-filter"]()}
        </Button>
      )}
    </Menu>
  );
};
