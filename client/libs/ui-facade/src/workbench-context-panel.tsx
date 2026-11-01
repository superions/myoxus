// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Drawer, Grid, ScrollArea, Stack } from "@mantine/core";
import {
  type ComponentProps,
  type HTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

import { useResponsiveMdQuery } from "./responsive";

export type WorkbenchContextPanelSurfaceProps = PropsWithChildren<
  Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
    compact?: boolean;
    opened: boolean;
    onOpenChange: (opened: boolean) => void;
    drawerTitle: ReactNode;
    closeButtonLabel: string;
    returnFocusRef?: RefObject<HTMLElement | null>;
  }
>;

/**
 * Responsive context owner for a Workbench surface. Desktop uses an intrinsic
 * sticky Grid column; compact layouts use Mantine's modal Drawer contract.
 * Product routes provide only state, localized labels and content.
 */
export function WorkbenchContextPanelSurface({
  children,
  compact: compactOverride,
  opened,
  onOpenChange,
  drawerTitle,
  closeButtonLabel,
  returnFocusRef,
  ...props
}: WorkbenchContextPanelSurfaceProps) {
  const viewportCompact = useResponsiveMdQuery();
  const compact = compactOverride ?? viewportCompact;
  const [closeButton, setCloseButton] = useState<HTMLButtonElement | null>(
    null,
  );
  const wasOpenedRef = useRef(opened);

  useEffect(() => {
    if (wasOpenedRef.current && !opened) returnFocusRef?.current?.focus();
    wasOpenedRef.current = opened;
  }, [opened, returnFocusRef]);

  useEffect(() => {
    if (!compact || !opened) return;
    const ownerDocument = closeButton?.ownerDocument;
    if (!closeButton || !ownerDocument) return;

    // Editors may restore their selection after the Drawer mounts. Keep that
    // late focus handoff inside the active modal boundary.
    const focusFrame = requestAnimationFrame(() => closeButton.focus());
    const keepFocusInDrawer = (event: FocusEvent) => {
      const dialog = closeButton.closest('[role="dialog"]');
      if (
        dialog &&
        event.target instanceof Node &&
        !dialog.contains(event.target)
      ) {
        closeButton.focus();
      }
    };
    ownerDocument.addEventListener("focusin", keepFocusInDrawer, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      ownerDocument.removeEventListener("focusin", keepFocusInDrawer, true);
    };
  }, [closeButton, compact, opened]);

  if (compact) {
    const closeButtonProps: NonNullable<
      ComponentProps<typeof Drawer>["closeButtonProps"]
    > & { "data-autofocus": true } = {
      "aria-label": closeButtonLabel,
      "data-autofocus": true,
      ref: setCloseButton,
    };

    return (
      <Drawer
        closeButtonProps={closeButtonProps}
        data-myoxus-ui-role="workbench-context-panel-drawer"
        opened={opened}
        onClose={() => onOpenChange(false)}
        onEnterTransitionEnd={() => closeButton?.focus()}
        position="right"
        returnFocus
        title={drawerTitle}
        trapFocus
        withCloseButton
      >
        <Stack
          {...props}
          data-myoxus-ui-role="workbench-context-panel-surface"
          gap="md"
        >
          {children}
        </Stack>
      </Drawer>
    );
  }

  if (!opened) return null;

  return (
    <Grid.Col
      data-myoxus-ui-role="workbench-context-panel-shell"
      span={{ md: 4 }}
      visibleFrom="md"
    >
      <Stack
        data-myoxus-ui-role="workbench-context-panel-rail"
        p="xs"
        pos="sticky"
        top={0}
      >
        <ScrollArea.Autosize
          {...props}
          data-myoxus-ui-role="workbench-context-panel-surface"
          mah="calc(100cqh - var(--mantine-spacing-xs) * 2)"
          offsetScrollbars
          scrollbars="y"
          styles={{ content: { minWidth: "100%" } }}
        >
          <Stack gap="sm" data-myoxus-ui-role="workbench-tool-scroll-content">
            {children}
          </Stack>
        </ScrollArea.Autosize>
      </Stack>
    </Grid.Col>
  );
}

export type WorkbenchContextPanelLayoutProps = PropsWithChildren<{
  compact?: boolean;
  context: ReactNode;
  contextOpened: boolean;
  contextTitle: ReactNode;
  closeButtonLabel: string;
  onContextOpenChange: (opened: boolean) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}>;

/**
 * Responsive Workbench split owner. Mantine's native Grid breakpoint keeps a
 * desktop context rail adjacent to the workarea; the same context is portalled
 * into the modal Drawer on compact viewports.
 */
export function WorkbenchContextPanelLayout({
  children,
  compact,
  context,
  contextOpened,
  contextTitle,
  closeButtonLabel,
  onContextOpenChange,
  returnFocusRef,
}: WorkbenchContextPanelLayoutProps) {
  return (
    <Grid
      align="flex-start"
      columns={12}
      data-context-visible={contextOpened ? "true" : "false"}
      data-myoxus-ui-role="workbench-context-panel-layout"
      gap={0}
    >
      <Grid.Col
        data-myoxus-ui-role="workbench-context-panel-target-owner"
        miw={0}
        span={contextOpened && !compact ? { base: 12, md: 8 } : 12}
      >
        {children}
      </Grid.Col>
      <WorkbenchContextPanelSurface
        closeButtonLabel={closeButtonLabel}
        compact={compact}
        drawerTitle={contextTitle}
        opened={contextOpened}
        onOpenChange={onContextOpenChange}
        returnFocusRef={returnFocusRef}
      >
        {context}
      </WorkbenchContextPanelSurface>
    </Grid>
  );
}
