import { useI18n } from "@myoxus/i18n";
import {
  Menu,
  MenuItem,
  MenuOptionButton,
  MenuOptionGroup,
  MenuPanel,
  MenuSectionLabel,
  MenuSeparator,
  MenuSub,
  MenuSummaryRow,
  MenuTrigger,
} from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import type { PageDisplayProperties, PageGroupByType } from "../types";
import { useAllDocDisplayProperties } from "../use-all-doc-display-properties";

type GroupOption = {
  value: PageGroupByType;
  label: string;
};

export function getGroupOptions(t: ReturnType<typeof useI18n>) {
  return [
    {
      value: "createDate",
      label: t["Created"](),
    },
    {
      value: "updatedDate",
      label: t["Updated"](),
    },
    {
      value: "tag",
      label: t["com.myoxus.page.display.grouping.group-by-tag"](),
    },
    {
      value: "favourites",
      label: t["com.myoxus.page.display.grouping.group-by-favourites"](),
    },
    {
      value: "none",
      label: t["com.myoxus.page.display.grouping.no-grouping"](),
    },
  ] satisfies GroupOption[];
}

export const PageDisplayMenu = () => {
  const t = useI18n();
  const [workspaceProperties, setProperties] = useAllDocDisplayProperties();
  const handleSelect = useCallback(
    (value: PageGroupByType) => {
      setProperties("groupBy", value);
    },
    [setProperties],
  );
  const handleSetDocDisplayProperties = useCallback(
    (key: keyof PageDisplayProperties) => {
      setProperties("displayProperties", {
        ...workspaceProperties.displayProperties,
        [key]: !workspaceProperties.displayProperties[key],
      });
    },
    [setProperties, workspaceProperties.displayProperties],
  );
  const propertyOptions: Array<{
    key: keyof PageDisplayProperties;
    onClick: () => void;
    label: string;
  }> = useMemo(() => {
    return [
      {
        key: "bodyNotes",
        onClick: () => handleSetDocDisplayProperties("bodyNotes"),
        label: t["com.myoxus.page.display.display-properties.body-notes"](),
      },
      {
        key: "tags",
        onClick: () => handleSetDocDisplayProperties("tags"),
        label: t["Tags"](),
      },
      {
        key: "createDate",
        onClick: () => handleSetDocDisplayProperties("createDate"),
        label: t["Created"](),
      },
      {
        key: "updatedDate",
        onClick: () => handleSetDocDisplayProperties("updatedDate"),
        label: t["Updated"](),
      },
    ];
  }, [handleSetDocDisplayProperties, t]);

  const items = useMemo(() => {
    const groupOptions: GroupOption[] = getGroupOptions(t);

    const subItems = groupOptions.map((option) => (
      <MenuItem
        key={option.value}
        onSelect={() => handleSelect(option.value)}
        selected={workspaceProperties.groupBy === option.value}
        data-testid={`group-by-${option.value}`}
      >
        {option.label}
      </MenuItem>
    ));

    const currentGroupType = groupOptions.find(
      (option) => option.value === workspaceProperties.groupBy,
    )?.label;

    return (
      <MenuPanel panelWidth="comfortable">
        <MenuSub
          subContentOptions={{
            alignOffset: -8,
            sideOffset: 12,
          }}
          items={subItems}
        >
          <MenuSummaryRow
            label={t["com.myoxus.page.display.grouping"]()}
            value={currentGroupType}
            data-testid="page-display-grouping-menuItem"
          />
        </MenuSub>
        <MenuSeparator />
        <MenuSectionLabel>
          {t["com.myoxus.page.display.list-option"]()}
        </MenuSectionLabel>
        <MenuSectionLabel>
          {t["com.myoxus.page.display.display-properties"]()}
        </MenuSectionLabel>
        <MenuOptionGroup>
          {propertyOptions.map((option) => (
            <MenuOptionButton
              key={option.label}
              onClick={option.onClick}
              active={!!workspaceProperties.displayProperties[option.key]}
              data-testid={`property-${option.key}`}
            >
              {option.label}
            </MenuOptionButton>
          ))}
        </MenuOptionGroup>
      </MenuPanel>
    );
  }, [
    handleSelect,
    propertyOptions,
    t,
    workspaceProperties.displayProperties,
    workspaceProperties.groupBy,
  ]);
  return (
    <Menu items={items} contentOptions={{ align: "end" }}>
      <MenuTrigger
        data-myoxus-ui-role="page-display-menu-trigger"
        data-testid="page-display-menu-button"
      >
        {t["com.myoxus.page.display"]()}
      </MenuTrigger>
    </Menu>
  );
};
