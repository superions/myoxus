import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Collapse,
  SidebarSectionContent,
  SidebarSectionHeader,
  StructureTreeSectionRoot,
} from "@myoxus/ui-facade";
import { type ReactNode, useCallback } from "react";

interface CollapsibleSectionProps {
  path: string[];
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
  testId?: string;
  headerTestId?: string;
}

interface CollapsibleSectionTriggerProps {
  label: string;
  collapsed?: boolean;
  actions?: ReactNode;
  testId?: string;
  setCollapsed?: (collapsed: boolean) => void;
}

function CollapsibleSectionTrigger({
  actions,
  label,
  collapsed,
  setCollapsed,
  testId,
}: CollapsibleSectionTriggerProps) {
  const collapsible = collapsed !== undefined;
  return (
    <SidebarSectionHeader
      actions={actions}
      collapsed={collapsed}
      disclosurePlacement="start"
      label={label}
      onCollapsedChange={setCollapsed}
      data-testid={testId}
      data-myoxus-ui-role={
        collapsible
          ? "button:mobile-navigation-section-header"
          : "mobile-navigation-section-header"
      }
    />
  );
}

export const CollapsibleSection = ({
  path,
  title,
  actions,
  testId,
  headerTestId,
  children,
}: CollapsibleSectionProps) => {
  const structureTreeStateService = useService(StructureTreeStateService);
  const collapsed = useLiveData(structureTreeStateService.collapsed$(path));

  const setCollapsed = useCallback(
    (v: boolean) => structureTreeStateService.setCollapsed(path, v),
    [structureTreeStateService, path],
  );

  return (
    <StructureTreeSectionRoot data-collapsed={collapsed} data-testid={testId}>
      <CollapsibleSectionTrigger
        label={title}
        actions={actions}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        testId={headerTestId}
      />
      <Collapse expanded={!collapsed}>
        <SidebarSectionContent data-testid="collapsible-section-content">
          {children}
        </SidebarSectionContent>
      </Collapse>
    </StructureTreeSectionRoot>
  );
};
