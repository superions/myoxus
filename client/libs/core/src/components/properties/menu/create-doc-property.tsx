import type { DocCustomPropertyInfo } from "@myoxus/core/modules/db";
import {
  WorkspacePropertyService,
  type WorkspacePropertyType,
} from "@myoxus/core/modules/workspace-property";
import { generateUniqueNameInSequence } from "@myoxus/core/utils/unique-name";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  MenuInlineText,
  MenuItem,
  MenuPanel,
  MenuSectionLabel,
  MenuSeparator,
} from "@myoxus/ui-facade";
import { useCallback } from "react";

import {
  isSupportedWorkspacePropertyType,
  WorkspacePropertyTypes,
} from "../../workspace-property-types";

export const CreatePropertyMenuItems = ({
  at = "before",
  onCreated,
}: {
  at?: "before" | "after";
  onCreated?: (property: DocCustomPropertyInfo) => void;
}) => {
  const t = useI18n();
  const workspacePropertyService = useService(WorkspacePropertyService);
  const properties = useLiveData(workspacePropertyService.properties$);

  const onAddProperty = useCallback(
    (option: { type: WorkspacePropertyType; name: string }) => {
      if (!isSupportedWorkspacePropertyType(option.type)) {
        return;
      }
      const typeDefined = WorkspacePropertyTypes[option.type];
      const nameExists = properties.some((meta) => meta.name === option.name);
      const allNames = properties
        .map((meta) => meta.name)
        .filter((name): name is string => name !== null && name !== undefined);
      const name = nameExists
        ? generateUniqueNameInSequence(option.name, allNames)
        : option.name;
      const uniqueId = typeDefined.uniqueId;
      const newProperty = workspacePropertyService.createProperty({
        id: uniqueId,
        name,
        type: option.type,
        index: workspacePropertyService.indexAt(at),
        isDeleted: false,
      });
      onCreated?.(newProperty);
    },
    [at, onCreated, workspacePropertyService, properties],
  );

  return (
    <MenuPanel panelWidth="wide">
      <MenuSectionLabel role="heading" aria-level={2}>
        {t["com.myoxus.page-properties.create-property.menu.header"]()}
      </MenuSectionLabel>
      <MenuSeparator />
      {Object.entries(WorkspacePropertyTypes).flatMap(([type, info]) => {
        if (type === "unknown") return [];
        const name = t.t(info.name);
        const uniqueId = info.uniqueId;
        const isUniqueExist = uniqueId
          ? properties.some(
              (meta) => meta.id === uniqueId || meta.type === type,
            )
          : false;
        const Icon = info.icon;
        return [
          <MenuItem
            key={type}
            prefixIcon={<Icon />}
            disabled={isUniqueExist}
            suffix={
              isUniqueExist ? (
                <MenuInlineText tone="secondary">
                  {t["com.myoxus.page-properties.create-property.added"]()}
                </MenuInlineText>
              ) : undefined
            }
            onClick={() => {
              onAddProperty({
                name: name,
                type: type as WorkspacePropertyType,
              });
            }}
            data-testid="create-property-menu-item"
            data-property-type={type}
          >
            {name}
          </MenuItem>,
        ];
      })}
    </MenuPanel>
  );
};
