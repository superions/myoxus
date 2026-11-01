// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type PropsWithChildren, type HTMLAttributes, forwardRef } from "react";
import { type MyoxusUiRoleProp } from "./helpers/ui-role";
import {
  Box,
  Group,
  Paper,
  Transition as MantineTransition,
} from "@mantine/core";
import { cssVar } from "@myoxus/theme";
import { type RowInputProps, RowInput } from "./input";
import { type MyoxusTextProps, MyoxusText } from "./typography";
import {
  type MyoxusIconButtonProps,
  IconButton,
  IconButtonGroup,
} from "./button";

type FindInPageRoleProps<T extends HTMLElement> = PropsWithChildren<
  HTMLAttributes<T> & MyoxusUiRoleProp
>;

const findInPageInlineSize = `min(calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 10), calc(100vw - (calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs)) * 2)))`;

// The absolutely positioned input and canvas mirror share this measured host.
// Its height is renderer geometry, independent of the surrounding action chrome.
const findInPageControlSize =
  "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-2xs))";

export function FindInPageAnchor({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "find-in-page-anchor",
  ...props
}: FindInPageRoleProps<HTMLDivElement>) {
  return (
    <Box
      {...props}
      data-find-in-page-anchor=""
      data-myoxus-ui-role={uiRole}
      style={{
        insetBlockStart: `calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 2)`,
        insetInlineEnd:
          "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs))",
        position: "fixed",
        zIndex: cssVar("zIndexModal"),
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export function FindInPagePanel({
  children,
  opened,
  style,
  "data-myoxus-ui-role": uiRole = "find-in-page-panel",
  ...props
}: FindInPageRoleProps<HTMLDivElement> & { opened: boolean }) {
  return (
    <MantineTransition
      mounted={opened}
      transition="pop-top-right"
      duration={120}
    >
      {(transitionStyle) => (
        <Paper
          {...props}
          component={Group}
          withBorder
          shadow="md"
          p="sm"
          gap="sm"
          justify="space-between"
          wrap="nowrap"
          data-myoxus-ui-role={uiRole}
          style={{
            inlineSize: findInPageInlineSize,
            willChange: "transform, opacity",
            zIndex: `calc(${cssVar("zIndexModal")} + 1)`,
            ...transitionStyle,
            ...style,
          }}
        >
          {children}
        </Paper>
      )}
    </MantineTransition>
  );
}

export function FindInPageSearchBox({
  active = false,
  children,
  style,
  "data-myoxus-ui-role": uiRole = "find-in-page-search-box",
  ...props
}: FindInPageRoleProps<HTMLDivElement> & { active?: boolean }) {
  return (
    <Box
      {...props}
      data-active={active ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      style={{
        alignItems: "center",
        background: cssVar("backgroundSecondaryColor"),
        border: `calc(var(--mantine-scale) * 1px) solid ${
          active ? cssVar("primaryColor") : cssVar("borderColor")
        }`,
        borderRadius: "var(--mantine-radius-sm)",
        display: "flex",
        flex: "1 1 auto",
        gap: "var(--mantine-spacing-sm)",
        minBlockSize: findInPageControlSize,
        minInlineSize: 0,
        paddingInline: "var(--mantine-spacing-sm)",
        position: "relative",
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export function FindInPageSearchIconSlot({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "find-in-page-search-icon",
  ...props
}: FindInPageRoleProps<HTMLSpanElement>) {
  return (
    <Box
      {...props}
      component="span"
      data-myoxus-ui-role={uiRole}
      style={{
        color: cssVar("iconColor"),
        display: "inline-flex",
        flex: "0 0 auto",
        fontSize: "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        lineHeight: 0,
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export function FindInPageInputMain({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "find-in-page-input-main",
  ...props
}: FindInPageRoleProps<HTMLDivElement>) {
  return (
    <Box
      {...props}
      data-myoxus-ui-role={uiRole}
      style={{
        alignItems: "center",
        display: "flex",
        flex: "1 1 auto",
        minBlockSize: findInPageControlSize,
        minInlineSize: 0,
        position: "relative",
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export const FindInPageTextInput = forwardRef<
  HTMLInputElement,
  RowInputProps & { searching?: boolean }
>(function FindInPageTextInput(
  { inputStyle, searching = false, style, ...props },
  ref,
) {
  return (
    <Box
      data-myoxus-ui-role="find-in-page-input-shell"
      style={{
        inset: 0,
        minInlineSize: 0,
        position: "absolute",
        visibility: searching ? "hidden" : "visible",
        ...style,
      }}
    >
      <RowInput
        {...props}
        ref={ref}
        block
        noBorder
        data-myoxus-ui-role="find-in-page-input"
        inputStyle={{
          background: "transparent",
          borderColor: "transparent",
          boxShadow: "none",
          color: "transparent",
          minBlockSize: findInPageControlSize,
          padding: 0,
          ...inputStyle,
        }}
        style={{
          height: "100%",
          width: "100%",
        }}
      />
    </Box>
  );
});

export const FindInPageCanvasText = forwardRef<
  HTMLCanvasElement,
  Omit<FindInPageRoleProps<HTMLCanvasElement>, "children">
>(function FindInPageCanvasText(
  {
    style,
    "data-myoxus-ui-role": uiRole = "find-in-page-canvas-text",
    ...props
  },
  ref,
) {
  return (
    <canvas
      {...props}
      ref={ref}
      data-myoxus-ui-role={uiRole}
      style={{
        color: cssVar("textPrimaryColor"),
        fontFamily:
          "var(--mantine-font-family-body-small, var(--mantine-font-family))",
        fontSize:
          "var(--mantine-font-size-body-small, var(--mantine-font-size-md))",
        fontWeight:
          "var(--mantine-font-weight-body-small, var(--mantine-font-weight-regular))",
        height: "100%",
        inset: 0,
        lineHeight:
          "var(--mantine-line-height-body-small, var(--mantine-line-height-md))",
        pointerEvents: "none",
        position: "absolute",
        width: "100%",
        ...style,
      }}
    />
  );
});

export function FindInPageCount({
  "aria-live": ariaLive,
  children,
  style,
  "data-myoxus-ui-role": uiRole = "find-in-page-count",
  ...props
}: MyoxusTextProps &
  MyoxusUiRoleProp & {
    "aria-live"?: HTMLAttributes<HTMLElement>["aria-live"];
  }) {
  return (
    <MyoxusText
      {...props}
      aria-live={ariaLive ?? "polite"}
      component={props.component ?? "div"}
      fallbackSlot={props.fallbackSlot ?? "body-small"}
      tone={props.tone ?? "secondary"}
      typographySlot={props.typographySlot ?? "caption"}
      data-myoxus-ui-role={uiRole}
      style={{
        flex: "0 0 auto",
        userSelect: "none",
        ...style,
      }}
    >
      {children}
    </MyoxusText>
  );
}

export function FindInPageNavGroup({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "find-in-page-nav-group",
  ...props
}: FindInPageRoleProps<HTMLDivElement>) {
  return (
    <IconButtonGroup
      {...props}
      data-myoxus-ui-role={uiRole}
      style={{ flex: "0 0 auto", ...style }}
    >
      {children}
    </IconButtonGroup>
  );
}

export function FindInPageNavButton({
  edge,
  style,
  ...props
}: MyoxusIconButtonProps & { edge?: "start" | "end" }) {
  return (
    <IconButton
      {...props}
      data-myoxus-ui-role={
        props["data-myoxus-ui-role"] ?? "find-in-page-nav-button"
      }
      data-edge={edge}
      style={style}
    />
  );
}

export function FindInPageCloseButton(props: MyoxusIconButtonProps) {
  return (
    <IconButton
      {...props}
      data-myoxus-ui-role={
        props["data-myoxus-ui-role"] ?? "find-in-page-close-button"
      }
    />
  );
}
