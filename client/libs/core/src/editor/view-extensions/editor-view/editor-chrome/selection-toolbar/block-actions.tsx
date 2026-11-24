// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  Button,
  Group,
  IconButtonGroup,
  IconButton,
  ColorSwatch,
  Menu,
  MenuSectionLabel,
  MenuTrigger,
  MenuItem,
  MenuSeparator,
  MenuSub,
  Tooltip,
  MyoxusText,
} from "@myoxus/ui-facade";
import type { SelectionAction } from "@virgultum/editor/shared/services";
import {
  Fragment,
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
  type PointerEvent,
} from "react";
import { editorGlyph as selectionGlyph } from "../glyphs";

/** Mouse commands retain the editor caret/dispatcher; keyboard focus stays native. */
export function preserveEditorCommandFocus(event: PointerEvent<HTMLElement>) {
  if (event.button === 0) event.preventDefault();
}

export const ActionButton = forwardRef<
  HTMLButtonElement,
  { action: SelectionAction } & Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "prefix"
  >
>(function ActionButton({ action, onClick, ...props }, ref) {
  if (!action.run && !action.control)
    return <MyoxusText>{action.label}</MyoxusText>;
  const icon = selectionGlyph(action.icon);
  const click = (event: React.MouseEvent<HTMLButtonElement>) =>
    onClick
      ? onClick(event)
      : action.run?.(event.currentTarget, event.nativeEvent);
  if (
    icon &&
    !action.showLabel &&
    action.control?.type === "menu" &&
    action.icon !== "ArrowDownSmallIcon"
  )
    return (
      <MenuTrigger
        {...props}
        ref={ref}
        data-testid={action.id}
        aria-label={action.label}
        tooltip={action.label}
        disabled={action.disabled}
        aria-pressed={action.active}
        variant={
          action.variant === "destructive"
            ? "error"
            : action.active
              ? "secondary"
              : "plain"
        }
        prefix={icon}
        onPointerDown={preserveEditorCommandFocus}
        onClick={click}
      />
    );
  return icon && !action.showLabel ? (
    <IconButton
      {...props}
      ref={ref}
      data-testid={action.id}
      aria-label={action.label}
      tooltip={action.label}
      icon={icon}
      variant={
        action.variant === "destructive"
          ? "danger"
          : action.active
            ? "secondary"
            : "plain"
      }
      disabled={action.disabled}
      aria-pressed={action.active}
      onPointerDown={preserveEditorCommandFocus}
      onClick={click}
    />
  ) : (
    <Tooltip content={action.label}>
      <Button
        {...props}
        ref={ref}
        prefix={icon ?? undefined}
        data-testid={action.id}
        disabled={action.disabled}
        aria-pressed={action.active || undefined}
        onPointerDown={preserveEditorCommandFocus}
        onClick={click}
      >
        {action.label}
      </Button>
    </Tooltip>
  );
});

type ActionsProps = {
  actions: SelectionAction[];
  menu?: boolean;
  afterAction?: () => void;
  renderControl: (action: SelectionAction, menu: boolean) => ReactNode;
};
export function SelectionActions({
  actions,
  menu = false,
  afterAction,
  renderControl,
}: ActionsProps) {
  return (
    <>
      {actions.map((action, index) => {
        if (!action.control && action.actions?.length) {
          const ActionsGroup = action.actions.every(
            (item) =>
              item.icon &&
              !item.control &&
              !item.showLabel &&
              !item.actions?.length,
          )
            ? IconButtonGroup
            : Group;
          return (
            <Fragment key={action.id}>
              {menu && index > 0 ? <MenuSeparator /> : null}
              {menu ? (
                <SelectionActions
                  actions={action.actions}
                  menu
                  afterAction={afterAction}
                  renderControl={renderControl}
                />
              ) : (
                <ActionsGroup>
                  <SelectionActions
                    actions={action.actions}
                    afterAction={afterAction}
                    renderControl={renderControl}
                  />
                </ActionsGroup>
              )}
            </Fragment>
          );
        }
        const c = action.control;
        if (c?.type === "menu") {
          const items = (
            <SelectionActions
              actions={c.items}
              menu
              // A domain menu can own a native range (for example table cells).
              // Its close handler restores that range; generic focus would clear it.
              afterAction={c.onClose ? undefined : afterAction}
              renderControl={renderControl}
            />
          );
          return menu ? (
            <MenuSub
              key={action.id}
              triggerOptions={{
                disabled: action.disabled,
                prefix: selectionGlyph(action.icon),
                // Some tool submenus also have a direct parent command.
                onClick: action.run
                  ? (event) =>
                      action.run?.(event.currentTarget, event.nativeEvent)
                  : undefined,
                closeMenuOnClick: Boolean(action.run),
              }}
              subOptions={{
                onOpenChange: (open) => (open ? c.onOpen?.() : c.onClose?.()),
              }}
              items={items}
            >
              {action.label}
            </MenuSub>
          ) : (
            <Menu
              key={action.id}
              noPortal
              rootOptions={{
                onOpen: c.onOpen,
                // Restore the editing range after the menu's close commit and
                // before the next input event, even when frames are throttled.
                onClose: () =>
                  queueMicrotask(() => (c.onClose ?? afterAction)?.()),
                returnFocus: !c.onClose && !afterAction,
                clickOutsideEvents: ["click"],
              }}
              items={
                <>
                  <MenuSectionLabel>{action.label}</MenuSectionLabel>
                  {items}
                </>
              }
            >
              <ActionButton action={action} />
            </Menu>
          );
        }
        if (c)
          return (
            <Fragment key={action.id}>{renderControl(action, menu)}</Fragment>
          );
        return menu ? (
          <MenuItem
            data-testid={action.id}
            key={action.id}
            prefixIcon={
              action.swatch ? (
                <ColorSwatch color={action.swatch} />
              ) : (
                selectionGlyph(action.icon)
              )
            }
            suffix={action.shortcut}
            disabled={action.disabled}
            selected={action.active}
            type={action.variant === "destructive" ? "danger" : undefined}
            onSelect={(event) => {
              action.run?.(event.currentTarget, event.nativeEvent);
              // Retained editor commands may prevent the native event. Their
              // selection handling must not cancel the owning menu's dismissal.
              afterAction?.();
            }}
          >
            {action.label}
          </MenuItem>
        ) : (
          <ActionButton key={action.id} action={action} />
        );
      })}
    </>
  );
}
