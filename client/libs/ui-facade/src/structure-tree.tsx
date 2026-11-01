// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PropsWithChildren,
  type HTMLAttributes,
  forwardRef,
  type ElementType,
  type ReactNode,
  type ButtonHTMLAttributes,
  useState,
  type FocusEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Box,
  Group,
  Center,
  ActionIcon,
  Text,
  Stack,
  ThemeIcon as MantineThemeIcon,
} from "@mantine/core";
import { joinClassName } from "./helpers/class-name";
import {
  STRUCTURE_TREE_CLASS_NAMES,
  structureTreeIndentStyle,
} from "./structure-tree-contract";
import { mergeStyles } from "./css-utils";
import { useMediaQuery } from "@mantine/hooks";
import {
  NavigationLink,
  type MyoxusNavigationLinkProps,
  SIDEBAR_TREE_ICON_SIZE,
} from "./shell/navigation";
import { ChevronRightIcon, ChevronDownIcon } from "@myoxus/icons/react";
import {
  type IconButtonProps,
  IconButton,
  renderSizedIconElement,
} from "./button";
import { type DropTargetTreeInstruction } from "./dnd";
import {
  Collapse,
  MYOXUS_TEXT_TONE_COLOR,
  typographyFontFamilyVar,
  typographyFontWeightVar,
  typographyLetterSpacingVar,
} from "./typography";
import { cssVar } from "@myoxus/theme";
import { ColorSwatch } from "./color-swatch";

type StructureTreeDivProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    "data-myoxus-ui-role"?: string;
  }
>;

export const StructureTreeRoot = forwardRef<
  HTMLDivElement,
  StructureTreeDivProps
>(function StructureTreeRoot(
  {
    children,
    className,
    "data-myoxus-ui-role": uiRole = "structure-tree",
    ...props
  },
  ref,
) {
  return (
    <Box
      {...props}
      ref={ref}
      className={joinClassName(STRUCTURE_TREE_CLASS_NAMES.root, className)}
      data-myoxus-ui-role={uiRole}
      maw="100%"
      miw={0}
      w="100%"
    >
      {children}
    </Box>
  );
});

export const StructureTreeSectionRoot = forwardRef<
  HTMLDivElement,
  StructureTreeDivProps & { migration?: boolean }
>(function StructureTreeSectionRoot(
  {
    children,
    className,
    migration = false,
    "data-myoxus-ui-role": uiRole = "sidebar-section",
    ...props
  },
  ref,
) {
  return (
    <Box
      {...props}
      ref={ref}
      className={className}
      data-migration={migration ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Box>
  );
});

// Node depth controls multiple CSS effects: visual indent, touch separators and
// drop overlays. Keep the CSS variable projection here instead of leaking
// `style` objects or pixel math into desktop/mobile navigation products.
export const StructureTreeNodeRoot = forwardRef<
  HTMLDivElement,
  StructureTreeDivProps & {
    level: number;
    open?: boolean;
  }
>(function StructureTreeNodeRoot(
  {
    children,
    level,
    open,
    style,
    "data-myoxus-ui-role": uiRole = "structure-tree-node-root",
    ...props
  },
  ref,
) {
  return (
    <Box
      {...props}
      ref={ref}
      style={mergeStyles(structureTreeIndentStyle(level), style)}
      data-state={open === undefined ? undefined : open ? "open" : "closed"}
      data-myoxus-ui-role={uiRole}
      maw="100%"
      miw={0}
      w="100%"
    >
      {children}
    </Box>
  );
});

type StructureTreeRowProps = Omit<StructureTreeDivProps, "children"> &
  PropsWithChildren<{
    active?: boolean;
    component?: ElementType;
    disabled?: boolean;
    collapsible?: boolean;
    dragging?: boolean;
    label?: ReactNode;
    leftSection?: ReactNode;
    rightSection?: ReactNode;
    rightSectionAlwaysVisible?: boolean;
    type?: ButtonHTMLAttributes<HTMLButtonElement>["type"];
  }>;

export const StructureTreeRow = forwardRef<HTMLElement, StructureTreeRowProps>(
  function StructureTreeRow(
    {
      active,
      children,
      className,
      collapsible,
      component = "div",
      disabled,
      dragging,
      label,
      leftSection,
      onBlur,
      onFocus,
      onMouseEnter,
      onMouseLeave,
      rightSection,
      rightSectionAlwaysVisible = false,
      type,
      "data-myoxus-ui-role": uiRole = "structure-tree-row",
      ...props
    },
    ref,
  ) {
    const hoverCapable = useMediaQuery("(hover: hover)", undefined, {
      getInitialValueInEffect: false,
    });
    const [hovered, setHovered] = useState(false);
    const [focusWithin, setFocusWithin] = useState(false);
    const actionsVisible =
      rightSectionAlwaysVisible || !hoverCapable || hovered || focusWithin;

    return (
      <NavigationLink
        {...(props as Omit<MyoxusNavigationLinkProps, "label">)}
        active={active}
        className={joinClassName(STRUCTURE_TREE_CLASS_NAMES.row, className)}
        component={component}
        data-collapsible={collapsible ? true : undefined}
        data-disabled={disabled ? true : undefined}
        data-dragging={dragging ? true : undefined}
        data-myoxus-ui-role={uiRole}
        disabled={disabled}
        label={label ?? children}
        leftSection={leftSection}
        onBlur={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setFocusWithin(false);
          }
          onBlur?.(event as FocusEvent<HTMLDivElement>);
        }}
        onFocus={(event) => {
          setFocusWithin(
            event.target instanceof HTMLElement &&
              event.target.matches(":focus-visible"),
          );
          onFocus?.(event as FocusEvent<HTMLDivElement>);
        }}
        onMouseEnter={(event) => {
          setHovered(true);
          onMouseEnter?.(event as ReactMouseEvent<HTMLDivElement>);
        }}
        onMouseLeave={(event) => {
          setHovered(false);
          onMouseLeave?.(event as ReactMouseEvent<HTMLDivElement>);
        }}
        ref={ref}
        rightSection={
          rightSection ? (
            <Box
              component="span"
              inert={actionsVisible ? undefined : true}
              opacity={actionsVisible ? 1 : 0}
              data-myoxus-ui-role="structure-tree-contextual-actions"
            >
              {rightSection}
            </Box>
          ) : undefined
        }
        type={component === "button" ? (type ?? "button") : type}
        variant="sidebar"
      />
    );
  },
);

export function StructureTreeLeading({
  children,
  className,
  ...props
}: StructureTreeDivProps) {
  return (
    <Group
      {...props}
      gap="xs"
      wrap="nowrap"
      className={joinClassName(STRUCTURE_TREE_CLASS_NAMES.leading, className)}
      data-myoxus-ui-role="structure-tree-row-leading"
    >
      {children}
    </Group>
  );
}

export function StructureTreeIconSlot({
  children,
  className,
  ...props
}: StructureTreeDivProps) {
  return (
    <Center
      {...props}
      component="span"
      className={joinClassName(STRUCTURE_TREE_CLASS_NAMES.icon, className)}
      data-myoxus-ui-role="structure-tree-row-icon"
      fz={SIDEBAR_TREE_ICON_SIZE}
      h={SIDEBAR_TREE_ICON_SIZE}
      lh={1}
      w={SIDEBAR_TREE_ICON_SIZE}
    >
      {children}
    </Center>
  );
}

export const StructureTreeCollapseButton = forwardRef<
  HTMLButtonElement,
  PropsWithChildren<
    ButtonHTMLAttributes<HTMLButtonElement> & {
      collapsed?: boolean;
      collapsible?: boolean;
      disabled?: boolean;
      "data-myoxus-ui-role"?: string;
    }
  >
>(function StructureTreeCollapseButton(
  {
    children,
    className,
    collapsed,
    collapsible = true,
    disabled,
    "data-myoxus-ui-role": uiRole = "button:structure-tree-collapse",
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <ActionIcon
      {...props}
      ref={ref}
      aria-hidden={collapsible ? props["aria-hidden"] : true}
      color="myoxus"
      className={className}
      component="button"
      data-collapsed={collapsed ? "true" : undefined}
      data-collapsible={collapsible ? "true" : "false"}
      data-disabled={disabled || !collapsible ? true : undefined}
      data-myoxus-ui-role={uiRole}
      disabled={disabled || !collapsible}
      size="md"
      tabIndex={collapsible ? props.tabIndex : -1}
      type={type}
      variant={collapsible ? "subtle" : "transparent"}
    >
      {children ??
        (collapsible ? (
          collapsed ? (
            <ChevronRightIcon aria-hidden="true" />
          ) : (
            <ChevronDownIcon aria-hidden="true" />
          )
        ) : null)}
    </ActionIcon>
  );
});

export function StructureTreeMain({
  children,
  className,
  ...props
}: StructureTreeDivProps) {
  return (
    <Group
      {...props}
      gap="xs"
      wrap="nowrap"
      className={joinClassName(STRUCTURE_TREE_CLASS_NAMES.main, className)}
      data-myoxus-ui-role="structure-tree-row-main"
    >
      {children}
    </Group>
  );
}

export function StructureTreeLabel({
  children,
  className,
  ...props
}: StructureTreeDivProps) {
  return (
    <Text
      {...props}
      component="span"
      className={joinClassName(STRUCTURE_TREE_CLASS_NAMES.label, className)}
      data-myoxus-ui-role="structure-tree-row-label"
      lineClamp={1}
    >
      {children}
    </Text>
  );
}

export function StructureTreeActions({
  children,
  className,
  ...props
}: StructureTreeDivProps) {
  return (
    <Group
      {...props}
      gap="xs"
      wrap="nowrap"
      className={joinClassName(STRUCTURE_TREE_CLASS_NAMES.actions, className)}
      data-myoxus-ui-role="structure-tree-row-actions"
    >
      {children}
    </Group>
  );
}

export function StructureTreeActionButton({
  className,
  size = "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
  ...props
}: IconButtonProps) {
  return (
    <IconButton
      {...props}
      className={joinClassName(
        STRUCTURE_TREE_CLASS_NAMES.operationButton,
        className,
      )}
      size={size}
    />
  );
}

export function StructureTreeRenameAnchor({
  className,
  ...props
}: StructureTreeDivProps) {
  return (
    <Box
      {...props}
      className={joinClassName(
        STRUCTURE_TREE_CLASS_NAMES.renameAnchor,
        className,
      )}
      data-myoxus-ui-role="structure-tree-rename-anchor"
    />
  );
}

// Product routers only provide navigation semantics. The Facade owns the link
// class and DOM role so tree links stay visually consistent across clients.
export type StructureTreeLinkProps<TTo = unknown> = PropsWithChildren<{
  component: ElementType;
  to: TTo;
  className?: string;
  draggable?: boolean;
  "data-myoxus-ui-role"?: string;
}>;

export const StructureTreeLink = forwardRef<
  HTMLElement,
  StructureTreeLinkProps
>(function StructureTreeLink(
  {
    children,
    className,
    component: LinkComponent,
    "data-myoxus-ui-role": uiRole = "structure-tree-link",
    ...props
  },
  ref,
) {
  return (
    <LinkComponent
      {...props}
      ref={ref}
      className={joinClassName(STRUCTURE_TREE_CLASS_NAMES.link, className)}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </LinkComponent>
  );
});

export const StructureTreeContent = forwardRef<
  HTMLDivElement,
  StructureTreeDivProps & {
    level?: number;
    open?: boolean;
    selfDraggedOver?: boolean;
    treeInstruction?: DropTargetTreeInstruction | null;
  }
>(function StructureTreeContent(
  {
    children,
    className,
    level,
    open,
    selfDraggedOver,
    style,
    treeInstruction,
    "data-myoxus-ui-role": uiRole = "structure-tree-content",
    ...props
  },
  ref,
) {
  return (
    <Box
      {...props}
      ref={ref}
      className={joinClassName(
        STRUCTURE_TREE_CLASS_NAMES.content,
        STRUCTURE_TREE_CLASS_NAMES.dropHighlight,
        className,
      )}
      style={mergeStyles(
        level === undefined ? undefined : structureTreeIndentStyle(level),
        style,
      )}
      data-open={open ? "true" : "false"}
      data-self-dragged-over={selfDraggedOver ? "true" : "false"}
      data-tree-instruction={treeInstruction?.type}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Box>
  );
});

export function StructureTreeChildren({
  children,
  className,
  hidden,
  "data-myoxus-ui-role": uiRole = "structure-tree-children",
  ...props
}: StructureTreeDivProps & {
  hidden?: boolean;
  "data-myoxus-ui-role"?: string;
}) {
  return (
    <Collapse expanded={!hidden}>
      <Box
        {...props}
        className={className}
        data-hidden={hidden ? "true" : undefined}
        data-myoxus-ui-role={uiRole}
      >
        {children}
      </Box>
    </Collapse>
  );
}

export function StructureTreeDragPreview({
  children,
  className,
  ...props
}: StructureTreeDivProps) {
  return (
    <Box
      {...props}
      className={joinClassName(
        STRUCTURE_TREE_CLASS_NAMES.dragPreview,
        className,
      )}
      data-myoxus-ui-role="structure-tree-drag-preview"
    >
      {children}
    </Box>
  );
}

export const StructureTreeDropEffect = forwardRef<
  HTMLDivElement,
  StructureTreeDivProps
>(function StructureTreeDropEffect({ children, className, ...props }, ref) {
  return (
    <Text
      {...props}
      component="div"
      ref={ref}
      c={MYOXUS_TEXT_TONE_COLOR.primary}
      className={joinClassName(
        STRUCTURE_TREE_CLASS_NAMES.dropEffect,
        className,
      )}
      ff={typographyFontFamilyVar("body-small")}
      fw={typographyFontWeightVar("body-small")}
      lts={typographyLetterSpacingVar("body-small")}
      size="body-small"
      data-myoxus-ui-role="structure-tree-drop-effect"
    >
      {children}
    </Text>
  );
});

export function StructureTreeDropEffectIcon({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLSpanElement>>) {
  return (
    <Box
      {...props}
      component="span"
      className={className}
      data-myoxus-ui-role="structure-tree-drop-effect-icon"
    >
      {renderSizedIconElement(children, {
        forceSize: true,
        size: "calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))",
      })}
    </Box>
  );
}

export const StructureTreeEmptyChild = forwardRef<
  HTMLDivElement,
  StructureTreeDivProps & { dropTarget?: boolean }
>(function StructureTreeEmptyChild(
  { children, className, dropTarget = false, ...props },
  ref,
) {
  return (
    <Text
      {...props}
      component="div"
      ref={ref}
      c={MYOXUS_TEXT_TONE_COLOR.secondary}
      className={joinClassName(
        dropTarget ? STRUCTURE_TREE_CLASS_NAMES.dropTarget : undefined,
        className,
      )}
      ff={typographyFontFamilyVar("body-small")}
      fw={typographyFontWeightVar("body-small")}
      lts={typographyLetterSpacingVar("body-small")}
      size="body-small"
      ta="left"
      data-myoxus-ui-role="structure-tree-empty-child"
    >
      {children}
    </Text>
  );
});

export const StructureTreeEmptySection = forwardRef<
  HTMLDivElement,
  StructureTreeDivProps
>(function StructureTreeEmptySection({ children, className, ...props }, ref) {
  return (
    <Stack
      {...props}
      ref={ref}
      align="center"
      className={className}
      gap="xs"
      data-myoxus-ui-role="structure-tree-empty-section"
    >
      {children}
    </Stack>
  );
});

export function StructureTreeEmptySectionIcon({
  children,
  className,
  ...props
}: StructureTreeDivProps) {
  return (
    <MantineThemeIcon
      {...props}
      className={className}
      color="myoxus"
      radius="xl"
      variant="light"
      data-myoxus-ui-role="structure-tree-empty-section-icon"
    >
      {renderSizedIconElement(children, {
        forceSize: true,
        size: "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
      })}
    </MantineThemeIcon>
  );
}

export function StructureTreeEmptySectionMessage({
  children,
  className,
  ...props
}: StructureTreeDivProps) {
  return (
    <Text
      {...props}
      component="p"
      c={MYOXUS_TEXT_TONE_COLOR.secondary}
      className={className}
      ff={typographyFontFamilyVar("body-small")}
      fw={typographyFontWeightVar("body-small")}
      lts={typographyLetterSpacingVar("body-small")}
      size="body-small"
      ta="center"
      data-myoxus-ui-role="structure-tree-empty-section-message"
    >
      {children}
    </Text>
  );
}

export function StructureTreeEmptySectionAction({
  children,
  className,
  ...props
}: StructureTreeDivProps) {
  return (
    <Box
      {...props}
      className={className}
      data-myoxus-ui-role="structure-tree-empty-section-action"
    >
      {children}
    </Box>
  );
}

export function StructureTreeColorIcon({
  color = cssVar("iconSecondary"),
  className,
}: {
  color?: string;
  className?: string;
}) {
  return (
    <ColorSwatch
      className={className}
      color={color}
      data-myoxus-ui-role="structure-tree-color-icon"
      shape="circle"
      size={"var(--mantine-spacing-xs)"}
    />
  );
}

export function StructureTreeLoading({
  children,
  className,
  ...props
}: StructureTreeDivProps) {
  return (
    <Group
      {...props}
      className={className}
      justify="space-between"
      wrap="nowrap"
      data-myoxus-ui-role="structure-tree-loading"
    >
      {children}
    </Group>
  );
}

export function StructureTreeInlineEmphasis({ children }: PropsWithChildren) {
  return (
    <Text
      component="strong"
      fw={typographyFontWeightVar("label-compact")}
      span
      data-myoxus-ui-role="structure-tree-inline-emphasis"
    >
      {children}
    </Text>
  );
}
