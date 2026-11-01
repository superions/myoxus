// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PropsWithChildren,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  Modal as MantineModal,
  Box,
  type TextInputProps,
  TextInput,
  UnstyledButton as MantineUnstyledButton,
  Group,
  ThemeIcon as MantineThemeIcon,
  Stack,
  Kbd as MantineKbd,
  Alert,
  Button as MantineButton,
  Loader,
  Center,
} from "@mantine/core";
import { type MyoxusTextProps, MyoxusText } from "./typography";
import { Loading, myoxusThemeToMantineColor } from "./feedback";
import { mergeStyles } from "./css-utils";
import { cssVar } from "@myoxus/theme";

export type CommandPaletteModalProps = PropsWithChildren<{
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  ariaLabel?: string;
}>;

export function CommandPaletteModal({
  open,
  onOpenChange,
  ariaLabel = "Command palette",
  children,
}: CommandPaletteModalProps) {
  return (
    <MantineModal
      opened={open}
      onClose={() => onOpenChange?.(false)}
      withCloseButton={false}
      trapFocus
      returnFocus
      keepMounted={false}
      attributes={
        {
          content: {
            "aria-label": ariaLabel,
            "data-myoxus-ui-role": "command-palette-dialog",
          },
          overlay: {
            "data-myoxus-ui-role": "command-palette-overlay",
          },
          inner: {
            "data-myoxus-ui-role": "command-palette-dialog-positioner",
          },
        } as Record<string, unknown>
      }
      data-myoxus-ui-role="command-palette-modal-root"
    >
      {children}
    </MantineModal>
  );
}

export const CommandPaletteRoot = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function CommandPaletteRoot({ className, ...props }, ref) {
  return (
    <Box
      {...props}
      ref={ref}
      className={className}
      data-myoxus-ui-role="command-palette"
    />
  );
});

export function CommandPaletteTitleRow({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <Box
      {...props}
      className={className}
      data-myoxus-ui-role="command-palette-title-row"
    />
  );
}

export function CommandPaletteTitle({
  className,
  children,
  ...props
}: MyoxusTextProps) {
  return (
    <MyoxusText
      {...props}
      className={className}
      component={props.component ?? "span"}
      tone={props.tone ?? "secondary"}
      typographySlot={props.typographySlot ?? "caption"}
      data-myoxus-ui-role="command-palette-title"
    >
      {children}
    </MyoxusText>
  );
}

export function CommandPaletteSearchRow({
  className,
  hasLabel = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { hasLabel?: boolean }) {
  return (
    <Box
      {...props}
      className={className}
      data-has-label={hasLabel ? "true" : undefined}
      data-myoxus-ui-role="command-palette-search-row"
    />
  );
}

export type CommandPaletteInputProps = Omit<
  TextInputProps,
  "onChange" | "size"
> & {
  onChange?: (value: string) => void;
  loading?: boolean;
};

export const CommandPaletteInput = forwardRef<
  HTMLInputElement,
  CommandPaletteInputProps
>(function CommandPaletteInput({ loading, onChange, ...props }, ref) {
  return (
    <TextInput
      {...props}
      ref={ref}
      data-myoxus-ui-role="command-palette-input"
      rightSection={
        loading ? (
          <Loading
            size={"calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"}
          />
        ) : (
          props.rightSection
        )
      }
      variant="unstyled"
      onChange={(event) => onChange?.(event.currentTarget.value)}
    />
  );
});

export const CommandPaletteList = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function CommandPaletteList({ className, style, ...props }, ref) {
  // Keep the listbox and scroll container on one node: keyboard selection owns
  // scrollTop and scrollIntoView, while Mantine ScrollArea would split the
  // semantic listbox from the imperative viewport ref.
  return (
    <Box
      {...props}
      ref={ref}
      className={className}
      mah={"400px"}
      px="xs"
      py="xs"
      style={mergeStyles({ overflowY: "auto" }, style)}
      data-myoxus-ui-role="command-palette-list"
    />
  );
});

export function CommandPaletteGroup(props: HTMLAttributes<HTMLDivElement>) {
  return (
    <Box
      {...props}
      data-myoxus-ui-role="command-palette-group"
      data-command-palette-group=""
    />
  );
}

export function CommandPaletteGroupHeading({
  className,
  children,
  ...props
}: MyoxusTextProps) {
  return (
    <MyoxusText
      {...props}
      className={className}
      component={props.component ?? "div"}
      tone={props.tone ?? "secondary"}
      typographySlot={props.typographySlot ?? "caption"}
      data-myoxus-ui-role="command-palette-group-heading"
    >
      {children}
    </MyoxusText>
  );
}

export type CommandPaletteItemTone = "default" | "danger";

export type CommandPaletteItemProps = HTMLAttributes<HTMLDivElement> & {
  selected?: boolean;
  disabled?: boolean;
  tone?: CommandPaletteItemTone;
};

export const CommandPaletteItem = forwardRef<
  HTMLDivElement,
  CommandPaletteItemProps
>(function CommandPaletteItem(
  {
    className,
    disabled = false,
    onClick,
    onMouseEnter,
    selected = false,
    tone = "default",
    children,
    ...props
  },
  ref,
) {
  return (
    <MantineUnstyledButton
      {...props}
      ref={ref}
      component="div"
      bg={
        selected
          ? tone === "danger"
            ? cssVar("backgroundErrorColor")
            : cssVar("backgroundSecondaryColor")
          : undefined
      }
      className={className}
      display="block"
      opacity={disabled ? 0.56 : undefined}
      px="sm"
      py="xs"
      role={props.role ?? "option"}
      tabIndex={props.tabIndex ?? -1}
      aria-selected={props["aria-selected"] ?? selected}
      aria-disabled={props["aria-disabled"] ?? (disabled || undefined)}
      data-selected={selected ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      data-tone={tone === "danger" ? "danger" : undefined}
      data-myoxus-ui-role={`command-palette-item:${tone}`}
      onClick={(event) => {
        if (!disabled) onClick?.(event);
      }}
      onMouseEnter={(event) => {
        if (!disabled) onMouseEnter?.(event);
      }}
    >
      <Group gap="sm" wrap="nowrap">
        {children}
      </Group>
    </MantineUnstyledButton>
  );
});

export function CommandPaletteItemIcon({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <MantineThemeIcon
      {...props}
      variant="transparent"
      size="md"
      className={className}
      data-myoxus-ui-role="command-palette-item-icon"
    >
      {children}
    </MantineThemeIcon>
  );
}

export function CommandPaletteItemBody({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <Stack
      {...props}
      flex={1}
      gap={0}
      miw={0}
      className={className}
      data-myoxus-ui-role="command-palette-item-body"
    />
  );
}

export function CommandPaletteItemTitle({
  className,
  children,
  ...props
}: MyoxusTextProps) {
  return (
    <MyoxusText
      {...props}
      className={className}
      component={props.component ?? "div"}
      truncate={props.truncate ?? true}
      tone={props.tone ?? "primary"}
      typographySlot={props.typographySlot ?? "body"}
      data-myoxus-ui-role="command-palette-item-title"
    >
      {children}
    </MyoxusText>
  );
}

export function CommandPaletteItemSubtitle({
  className,
  children,
  ...props
}: MyoxusTextProps) {
  return (
    <MyoxusText
      {...props}
      className={className}
      component={props.component ?? "div"}
      truncate={props.truncate ?? true}
      tone={props.tone ?? "secondary"}
      typographySlot={props.typographySlot ?? "caption"}
      data-myoxus-ui-role="command-palette-item-subtitle"
    >
      {children}
    </MyoxusText>
  );
}

export function CommandPaletteTimestamp({
  className,
  children,
  ...props
}: MyoxusTextProps) {
  return (
    <MyoxusText
      {...props}
      className={className}
      component={props.component ?? "div"}
      ta="end"
      tone={props.tone ?? "secondary"}
      typographySlot={props.typographySlot ?? "caption"}
      data-myoxus-ui-role="command-palette-timestamp"
    >
      {children}
    </MyoxusText>
  );
}

export function CommandPaletteShortcut({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <Group
      {...props}
      gap={4}
      wrap="nowrap"
      className={className}
      data-myoxus-ui-role="command-palette-shortcut"
    />
  );
}

export function CommandPaletteShortcutKey({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <MantineKbd
      {...props}
      className={className}
      size="sm"
      data-myoxus-ui-role="command-palette-shortcut-key"
    >
      {children}
    </MantineKbd>
  );
}

export function CommandPaletteHighlight({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <Box
      {...props}
      component="span"
      className={className}
      data-myoxus-ui-role="command-palette-highlight"
    />
  );
}

export function CommandPaletteHighlightKeyword({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <Box
      {...props}
      component="span"
      className={className}
      data-myoxus-ui-role="command-palette-highlight-keyword"
    />
  );
}

export function CommandPaletteError({
  className,
  children,
  ...props
}: MyoxusTextProps) {
  return (
    <MyoxusText
      {...props}
      className={className}
      component={props.component ?? "p"}
      tone={props.tone ?? "danger"}
      typographySlot={props.typographySlot ?? "caption"}
      data-myoxus-ui-role="command-palette-error"
    >
      {children}
    </MyoxusText>
  );
}

export type CommandPaletteGroupStatusProps = {
  error?: ReactNode;
  loading?: boolean;
  loadingLabel: ReactNode;
  retryLabel: ReactNode;
  onRetry?: () => void;
};

/**
 * Source-local command-palette feedback. Keeping this inside the Facade gives
 * every async discovery source the same Mantine Alert/Loader semantics without
 * product-owned status rows or palette CSS.
 */
export function CommandPaletteGroupStatus({
  error,
  loading = false,
  loadingLabel,
  retryLabel,
  onRetry,
}: CommandPaletteGroupStatusProps) {
  if (error) {
    return (
      <Alert
        color={myoxusThemeToMantineColor("error")}
        data-myoxus-ui-role="command-palette-group-error"
      >
        <Group justify="space-between" wrap="nowrap">
          <MyoxusText tone="danger" typographySlot="caption">
            {error}
          </MyoxusText>
          {onRetry ? (
            <MantineButton onClick={onRetry} variant="subtle">
              {retryLabel}
            </MantineButton>
          ) : null}
        </Group>
      </Alert>
    );
  }

  if (!loading) return null;
  return (
    <Group gap="xs" data-myoxus-ui-role="command-palette-group-loading">
      <Loader aria-hidden="true" />
      <MyoxusText tone="secondary" typographySlot="caption">
        {loadingLabel}
      </MyoxusText>
    </Group>
  );
}

export function CommandPaletteEmpty({ children }: PropsWithChildren) {
  return (
    <Center data-myoxus-ui-role="command-palette-empty">
      <MyoxusText tone="secondary" typographySlot="body">
        {children}
      </MyoxusText>
    </Center>
  );
}
