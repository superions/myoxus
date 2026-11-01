// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { useMantineTheme, Group, Stack, Box } from "@mantine/core";
import {
  useResponsiveSmQuery,
  useResponsiveQuery,
  maxWidthQueryForBreakpoint,
} from "./responsive";
import {
  type HTMLAttributes,
  Children,
  forwardRef,
  type PropsWithChildren,
  type ReactNode,
  type Ref,
} from "react";

export type PeekViewModalMode = "fit" | "full" | "max";

export type PeekViewModalResponsiveSize = "compact" | "medium" | "regular";

function usePeekViewModalResponsiveSize(
  mobileEdition = false,
): PeekViewModalResponsiveSize {
  const theme = useMantineTheme();
  const compact = useResponsiveSmQuery(mobileEdition);
  const medium = useResponsiveQuery(
    maxWidthQueryForBreakpoint(theme.breakpoints.md),
  );

  if (compact) return "compact";
  if (medium) return "medium";
  return "regular";
}

export type PeekViewControlsProps = HTMLAttributes<HTMLDivElement>;

export function PeekViewControls({
  children,
  className,
  style,
  ...props
}: PeekViewControlsProps) {
  const responsiveSize = usePeekViewModalResponsiveSize(
    BUILD_CONFIG.isMobileEdition,
  );
  const controls = Children.toArray(children);

  if (responsiveSize === "compact") {
    const [closeAction, ...utilityActions] = controls;

    return (
      <Group
        {...props}
        className={className}
        gap={"var(--mantine-spacing-xs)"}
        justify={utilityActions.length > 0 ? "space-between" : "flex-end"}
        style={style}
        wrap="nowrap"
        data-myoxus-ui-role="peek-view-controls"
      >
        {utilityActions.length > 0 ? (
          <Group gap={"var(--mantine-spacing-xs)"} wrap="nowrap">
            {utilityActions.reverse()}
          </Group>
        ) : null}
        {closeAction}
      </Group>
    );
  }

  return (
    <Stack
      {...props}
      className={className}
      gap={"var(--mantine-spacing-xs)"}
      style={style}
      data-myoxus-ui-role="peek-view-controls"
    >
      {controls}
    </Stack>
  );
}

export type PeekViewModalOverlayProps = HTMLAttributes<HTMLDivElement> & {
  animationState?: string;
};

export const PeekViewModalOverlay = forwardRef<
  HTMLDivElement,
  PeekViewModalOverlayProps
>(function PeekViewModalOverlay(
  { animationState, className, style, ...props },
  ref,
) {
  return (
    <Box
      {...props}
      ref={ref}
      className={className}
      style={style}
      data-animation-state={animationState}
      data-myoxus-ui-role="peek-view-modal-overlay"
    />
  );
});

export type PeekViewModalFrameProps = PropsWithChildren<{
  mode: PeekViewModalMode;
  animationState?: string;
  mobile?: boolean;
  fullWidthLayout?: boolean;
  dialogFrame?: boolean;
  controls?: ReactNode;
  controlsHidden?: boolean;
  contentRef?: Ref<HTMLDivElement>;
  contentClipRef?: Ref<HTMLDivElement>;
  controlsRef?: Ref<HTMLDivElement>;
  "data-testid"?: string;
}>;

export const PeekViewModalFrame = forwardRef<
  HTMLDivElement,
  PeekViewModalFrameProps
>(function PeekViewModalFrame(
  {
    children,
    mode,
    animationState,
    mobile = false,
    fullWidthLayout = false,
    dialogFrame = true,
    controls,
    controlsHidden = false,
    contentRef,
    contentClipRef,
    controlsRef,
    "data-testid": dataTestId,
  },
  ref,
) {
  const responsiveSize = usePeekViewModalResponsiveSize(mobile);

  return (
    <Box
      ref={ref}
      data-mode={mode}
      data-mobile={mobile ? "true" : undefined}
      data-peek-view-wrapper
      data-responsive-size={responsiveSize}
      data-myoxus-ui-role="peek-view-modal-wrapper"
    >
      <Box
        ref={contentClipRef}
        data-animation-state={animationState}
        data-full-width-layout={fullWidthLayout ? "true" : undefined}
        data-mobile={mobile ? "true" : undefined}
        data-responsive-size={responsiveSize}
        data-myoxus-ui-role="peek-view-modal-container"
      >
        <Box data-myoxus-ui-role="peek-view-modal-clip">
          <Box
            data-dialog-frame={dialogFrame ? "true" : undefined}
            data-testid={dataTestId}
            role="dialog"
            aria-modal="true"
            data-myoxus-ui-role="peek-view-modal-content"
          >
            <Box hidden data-myoxus-ui-role="peek-view-modal-hidden-sentinel" />
            <Box
              ref={contentRef}
              data-myoxus-ui-role="peek-view-modal-content-sizer"
            >
              {children}
            </Box>
          </Box>
        </Box>
        {controls ? (
          <Box
            ref={controlsRef}
            data-animation-hidden={controlsHidden ? "true" : undefined}
            data-myoxus-ui-role="peek-view-modal-controls"
          >
            {controls}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
});
