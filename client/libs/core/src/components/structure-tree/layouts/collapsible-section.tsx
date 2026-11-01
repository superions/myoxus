/**
 * `CollapsibleSection` — reusable layout primitive for structure tree sections.
 *
 * Wraps the shared Myoxus sidebar-section Facade roles with a semantic header
 * and collapsible content body. The collapsed/expanded state is
 * persisted via `StructureTreeStateService.setCollapsed(path, ...)` so the panel
 * remembers its layout across re-renders and page reloads.
 *
 * @param path            - Unique string array key used as the persistence
 *                          path in `StructureTreeStateService` (e.g. `['favorites']`).
 * @param title           - Display label shown in the section header.
 * @param actions         - Optional right-side slot in the header (e.g. an
 *                          "Add" icon button).
 * @param children        - Content shown when the section is expanded.
 * @param headerRef       - Forwarded ref to the header `<div>` for external
 *                          measurement or focus management.
 */
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Collapse,
  SidebarSectionContent,
  SidebarSectionHeader,
  StructureTreeSectionRoot,
} from "@myoxus/ui-facade";
import {
  type PropsWithChildren,
  type ReactNode,
  type RefObject,
  useCallback,
} from "react";

interface CollapsibleSectionProps extends PropsWithChildren {
  path: string[];
  title: string;
  actions?: ReactNode;
  migration?: boolean;

  testId?: string;

  headerRef?: RefObject<HTMLDivElement>;
  headerTestId?: string;
  headerDropTarget?: boolean;
  disclosurePlacement?: "end" | "start";
}

export const CollapsibleSection = ({
  path,
  title,
  actions,
  children,
  migration = false,

  testId,

  headerRef,
  headerTestId,
  headerDropTarget = false,
  disclosurePlacement,
}: CollapsibleSectionProps) => {
  const structureTreeStateService = useService(StructureTreeStateService);

  const collapsed = useLiveData(structureTreeStateService.collapsed$(path));

  const setCollapsed = useCallback(
    (v: boolean) => {
      structureTreeStateService.setCollapsed(path, v);
    },
    [structureTreeStateService, path],
  );

  return (
    <StructureTreeSectionRoot
      data-collapsed={collapsed}
      migration={migration}
      data-testid={testId}
    >
      <SidebarSectionHeader
        actions={actions}
        data-testid={headerTestId}
        dropTarget={headerDropTarget}
        disclosurePlacement={disclosurePlacement}
        label={title}
        onCollapsedChange={setCollapsed}
        collapsed={collapsed}
        ref={headerRef}
      />
      <Collapse expanded={!collapsed}>
        <SidebarSectionContent data-testid="collapsible-section-content">
          {children}
        </SidebarSectionContent>
      </Collapse>
    </StructureTreeSectionRoot>
  );
};
