import {
  type BaseStructureTreeNodeProps,
  StructureTreeContext,
} from "@myoxus/core/components/structure-tree";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import { extractEmojiIcon } from "@myoxus/core/utils";
import { MoreHorizontalIcon } from "@myoxus/icons/react";
import {
  Collapse,
  MobileMenu,
  StructureTreeCollapseButton,
  StructureTreeContent,
  StructureTreeIconSlot,
  StructureTreeLabel,
  StructureTreeLink,
  StructureTreeMain,
  StructureTreeNodeRoot,
  StructureTreeRow,
} from "@myoxus/ui-facade";
import {
  Fragment,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

import { SwipeMenu } from "../../swipe-menu";

interface StructureTreeNodeProps extends BaseStructureTreeNodeProps {}

export const StructureTreeNode = ({
  children,
  icon: Icon,
  name: rawName,
  onClick,
  to,
  active,
  disabled,
  collapsed,
  extractEmojiAsIcon,
  setCollapsed,
  operations = [],
  postfix,
  childrenOperations = [],
  childrenPlaceholder,
  linkComponent: LinkComponent = WorkbenchLink,
  ...otherProps
}: StructureTreeNodeProps) => {
  const context = useContext(StructureTreeContext);
  const level = context?.level ?? 0;
  // If no onClick or to is provided, clicking on the node will toggle the collapse state
  const clickForCollapse = !onClick && !to && !disabled;
  const [childCount, setChildCount] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const { emoji, name } = useMemo(() => {
    if (!extractEmojiAsIcon || !rawName) {
      return {
        emoji: null,
        name: rawName,
      };
    }
    const { emoji, rest } = extractEmojiIcon(rawName);
    return {
      emoji,
      name: rest,
    };
  }, [extractEmojiAsIcon, rawName]);

  const { menuOperations } = useMemo(() => {
    const sorted = [...operations].sort((a, b) => a.index - b.index);
    return {
      menuOperations: sorted.filter(({ inline }) => !inline),
      inlineOperations: sorted.filter(({ inline }) => !!inline),
    };
  }, [operations]);

  const contextValue = useMemo(() => {
    return {
      operations: childrenOperations,
      level: (context?.level ?? 0) + 1,
      registerChild: () => {
        setChildCount((c) => c + 1);
        return () => setChildCount((c) => c - 1);
      },
    };
  }, [childrenOperations, context?.level]);

  const handleCollapsedChange = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault(); // for links
      setCollapsed(!collapsed);
    },
    [collapsed, setCollapsed],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.defaultPrevented) {
        return;
      }
      if (!clickForCollapse) {
        onClick?.();
      } else {
        setCollapsed(!collapsed);
      }
    },
    [clickForCollapse, collapsed, onClick, setCollapsed],
  );

  const renderedIcon = emoji ?? (Icon && <Icon collapsed={collapsed} />);
  const iconSlot =
    menuOperations.length > 0 ? (
      <div
        onClick={(e) => {
          // keep the icon-triggered mobile menu from navigating the row link
          e.preventDefault();
        }}
      >
        <MobileMenu
          items={menuOperations.map(({ view, index }) => (
            <Fragment key={index}>{view}</Fragment>
          ))}
        >
          <StructureTreeIconSlot data-testid="menu-trigger">
            {renderedIcon}
          </StructureTreeIconSlot>
        </MobileMenu>
      </div>
    ) : (
      <StructureTreeIconSlot>{renderedIcon}</StructureTreeIconSlot>
    );

  const collapseControl = (
    <StructureTreeCollapseButton
      aria-label={collapsed === false ? "Collapse" : "Expand"}
      collapsed={collapsed !== false}
      collapsible
      disabled={disabled}
      onClick={handleCollapsedChange}
      data-testid="structure-tree-collapsed-button"
    />
  );

  const content = (
    <StructureTreeRow
      onClick={handleClick}
      active={active}
      collapsible
      data-touch="true"
      disabled={disabled}
      label={
        <StructureTreeMain>
          <StructureTreeLabel>{name}</StructureTreeLabel>
          {postfix}
        </StructureTreeMain>
      }
      leftSection={iconSlot}
      rightSection={collapseControl}
    />
  );

  return (
    <StructureTreeNodeRoot
      open={!collapsed}
      level={level}
      ref={rootRef}
      {...otherProps}
    >
      <SwipeMenu
        onExecute={useCallback(() => setMenuOpen(true), [])}
        menu={
          <MobileMenu
            rootOptions={useMemo(
              () => ({ open: menuOpen, onOpenChange: setMenuOpen }),
              [menuOpen],
            )}
            items={menuOperations.map(({ view, index }) => (
              <Fragment key={index}>{view}</Fragment>
            ))}
          >
            <MoreHorizontalIcon size="calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))" />
          </MobileMenu>
        }
      >
        <StructureTreeContent open={!collapsed}>
          {to ? (
            <StructureTreeLink
              component={LinkComponent}
              to={to}
              draggable={false}
            >
              {content}
            </StructureTreeLink>
          ) : (
            <div>{content}</div>
          )}
        </StructureTreeContent>
      </SwipeMenu>
      <Collapse expanded={!collapsed}>
        {childCount === 0 && !collapsed ? childrenPlaceholder : null}
        <StructureTreeContext.Provider value={contextValue}>
          {collapsed ? null : children}
        </StructureTreeContext.Provider>
      </Collapse>
    </StructureTreeNodeRoot>
  );
};
