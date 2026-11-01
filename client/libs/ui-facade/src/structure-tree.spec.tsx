// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { forwardRef, type PropsWithChildren } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  Collapse,
  SidebarSectionContent,
  STRUCTURE_TREE_CLASS_NAMES,
  STRUCTURE_TREE_INDENT_VAR,
  StructureTreeActionButton,
  StructureTreeActions,
  StructureTreeChildren,
  StructureTreeCollapseButton,
  StructureTreeColorIcon,
  StructureTreeContent,
  StructureTreeDragPreview,
  StructureTreeEmptyChild,
  StructureTreeEmptySection,
  StructureTreeEmptySectionIcon,
  StructureTreeEmptySectionMessage,
  StructureTreeIconSlot,
  StructureTreeLabel,
  StructureTreeLeading,
  StructureTreeLink,
  StructureTreeMain,
  StructureTreeNodeRoot,
  StructureTreeRoot,
  StructureTreeRow,
  StructureTreeSectionRoot,
} from "./index";
import { MyoxusUIProvider } from "./provider";

const TestNavigationLink = forwardRef<
  HTMLAnchorElement,
  PropsWithChildren<{
    className?: string;
    draggable?: boolean;
    to: string;
  }>
>(function TestNavigationLink({ children, to, ...props }, ref) {
  return (
    <a {...props} href={to} ref={ref}>
      {children}
    </a>
  );
});

afterEach(() => {
  cleanup();
});

describe("StructureTree facade primitives", () => {
  test("renders tree row, actions, drag preview and placeholders through facade roles", () => {
    const toggle = vi.fn();
    const action = vi.fn();

    render(
      <MyoxusUIProvider>
        <StructureTreeRoot data-testid="tree-root">
          <StructureTreeNodeRoot data-testid="node-root" level={2} open>
            <StructureTreeContent
              data-testid="content"
              open
              selfDraggedOver={false}
              treeInstruction={null}
            >
              <StructureTreeLink
                component={TestNavigationLink}
                to="/project-plan"
              >
                <StructureTreeRow
                  active
                  collapsible
                  data-testid="row"
                  leftSection={
                    <StructureTreeLeading>
                      <StructureTreeCollapseButton
                        aria-label="Toggle"
                        collapsed
                        collapsible
                        onClick={toggle}
                      />
                      <StructureTreeCollapseButton
                        collapsible={false}
                        data-testid="leaf-toggle"
                      />
                      <StructureTreeIconSlot>
                        <StructureTreeColorIcon color="var(--myoxus-icon-color)" />
                      </StructureTreeIconSlot>
                    </StructureTreeLeading>
                  }
                  label={
                    <StructureTreeMain>
                      <StructureTreeLabel>Project plan</StructureTreeLabel>
                    </StructureTreeMain>
                  }
                  rightSection={
                    <StructureTreeActions>
                      <StructureTreeActionButton
                        aria-label="More"
                        icon={<span>...</span>}
                        onClick={action}
                      />
                    </StructureTreeActions>
                  }
                />
              </StructureTreeLink>
              <StructureTreeRow
                data-placeholder="true"
                data-testid="touch-row"
                data-touch="true"
                leftSection={
                  <StructureTreeIconSlot>
                    <span aria-hidden>+</span>
                  </StructureTreeIconSlot>
                }
                label={
                  <StructureTreeLabel>Touch placeholder</StructureTreeLabel>
                }
              />
              <StructureTreeDragPreview>Preview</StructureTreeDragPreview>
              <StructureTreeEmptyChild>Empty child</StructureTreeEmptyChild>
            </StructureTreeContent>
            <StructureTreeChildren data-testid="children" hidden>
              Hidden children
            </StructureTreeChildren>
          </StructureTreeNodeRoot>
          <StructureTreeSectionRoot data-testid="section-root" migration>
            <Collapse expanded>
              <SidebarSectionContent data-testid="section-content">
                Section body
              </SidebarSectionContent>
            </Collapse>
          </StructureTreeSectionRoot>
          <StructureTreeEmptySection data-testid="empty-section">
            <StructureTreeEmptySectionIcon>
              <svg />
            </StructureTreeEmptySectionIcon>
            <StructureTreeEmptySectionMessage>
              No items
            </StructureTreeEmptySectionMessage>
          </StructureTreeEmptySection>
        </StructureTreeRoot>
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("row").dataset.myoxusUiRole).toBe(
      "structure-tree-row",
    );
    expect(screen.getByTestId("touch-row").dataset.touch).toBe("true");
    expect(screen.getByTestId("touch-row").dataset.placeholder).toBe("true");
    const treeIconSlot = screen
      .getByTestId("touch-row")
      .querySelector<HTMLElement>(
        '[data-myoxus-ui-role="structure-tree-row-icon"]',
      );
    expect(treeIconSlot?.style.fontSize).toBe("var(--mantine-spacing-lg)");
    expect(treeIconSlot?.style.width).toBe("var(--mantine-spacing-lg)");
    expect(treeIconSlot?.style.height).toBe("var(--mantine-spacing-lg)");
    expect(screen.getByTestId("node-root").getAttribute("style")).toContain(
      `${STRUCTURE_TREE_INDENT_VAR}: calc(var(--mantine-spacing-md) + var(--mantine-spacing-md))`,
    );
    for (const element of [
      screen.getByTestId("tree-root"),
      screen.getByTestId("node-root"),
    ]) {
      expect(element.getAttribute("style")).toContain("width: 100%");
      expect(element.getAttribute("style")).toContain("min-width: 0rem");
      expect(element.getAttribute("style")).toContain("max-width: 100%");
    }
    expect(screen.getByRole("link").className).toContain(
      STRUCTURE_TREE_CLASS_NAMES.link,
    );
    expect(screen.getByTestId("children").dataset.hidden).toBe("true");
    const toggleButton = screen.getByRole("button", { name: "Toggle" });
    expect(toggleButton.dataset.collapsible).toBe("true");
    expect(toggleButton.querySelector("svg")).not.toBeNull();
    const leafToggle = screen.getByTestId("leaf-toggle");
    expect(leafToggle.dataset.collapsible).toBe("false");
    expect(leafToggle.getAttribute("aria-hidden")).toBe("true");
    expect(leafToggle.getAttribute("tabindex")).toBe("-1");
    expect(leafToggle.querySelector("svg")).toBeNull();
    expect(screen.getByTestId("section-root").dataset.migration).toBe("true");
    expect(screen.getByTestId("section-root").className).not.toContain(
      "myoxus-structure-tree-migration-section",
    );
    expect(screen.getByTestId("section-content").dataset.myoxusUiRole).toBe(
      "sidebar-section-content",
    );
    expect(screen.getByText("Project plan")).not.toBeNull();
    expect(screen.getByText("Preview").dataset.myoxusUiRole).toBe(
      "structure-tree-drag-preview",
    );
    expect(screen.getByText("Empty child").dataset.myoxusUiRole).toBe(
      "structure-tree-empty-child",
    );
    expect(screen.getByTestId("empty-section").dataset.myoxusUiRole).toBe(
      "structure-tree-empty-section",
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    expect(toggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(action).toHaveBeenCalledTimes(1);
  });
});
