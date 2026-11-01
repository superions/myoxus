// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Box,
  Center,
  Divider,
  Grid,
  Group,
  ScrollArea,
  Stack,
} from "@mantine/core";
import { myoxusWebBreakpoints } from "@myoxus/theme";
import type {
  ComponentProps,
  HTMLAttributes,
  PropsWithChildren,
  ReactNode,
} from "react";
import { forwardRef } from "react";

export type WorkbenchHeaderFrameProps = Omit<
  ComponentProps<typeof Grid>,
  "children" | "left" | "right" | "title"
> & {
  left?: ReactNode;
  title?: ReactNode;
  right?: ReactNode;
  "data-myoxus-ui-role"?: string;
};

export function WorkbenchHeaderFrame({
  left,
  title,
  right,
  "data-myoxus-ui-role": uiRole = "workbench-header-frame",
  ...props
}: WorkbenchHeaderFrameProps) {
  const hasLeft = left != null;
  const hasRight = right != null;
  const onlyTitle = !hasLeft && !hasRight;
  const balanceWithoutLeft = !hasLeft && hasRight;

  return (
    <Box data-myoxus-ui-role={uiRole} flex="1 1 auto" miw={0} w="100%">
      <Grid
        {...props}
        align="center"
        breakpoints={myoxusWebBreakpoints}
        columns={12}
        data-myoxus-ui-role={`${uiRole}:grid`}
        gap="xs"
        type="container"
        w="100%"
      >
        {!onlyTitle ? (
          <Grid.Col
            span={balanceWithoutLeft ? { base: 2, sm: 4 } : { base: 12, sm: 4 }}
            order={balanceWithoutLeft ? { base: 1, sm: 1 } : { base: 3, sm: 1 }}
          >
            <Group
              data-myoxus-ui-role="workbench-header-frame-left"
              wrap="nowrap"
            >
              {left}
            </Group>
          </Grid.Col>
        ) : null}
        <Grid.Col
          span={
            onlyTitle
              ? { base: 12, sm: 4 }
              : balanceWithoutLeft
                ? { base: 8, sm: 4 }
                : { base: 9, sm: 4 }
          }
          offset={onlyTitle ? { sm: 4 } : undefined}
          order={balanceWithoutLeft ? { base: 2, sm: 2 } : { base: 1, sm: 2 }}
        >
          <Group
            data-myoxus-ui-role="workbench-header-frame-title"
            justify="center"
            wrap="nowrap"
          >
            {title}
          </Group>
        </Grid.Col>
        {!onlyTitle ? (
          <Grid.Col
            span={balanceWithoutLeft ? { base: 2, sm: 4 } : { base: 3, sm: 4 }}
            order={balanceWithoutLeft ? { base: 3, sm: 3 } : { base: 2, sm: 3 }}
          >
            <Group
              data-myoxus-ui-role="workbench-header-frame-right"
              justify="flex-end"
              wrap="nowrap"
            >
              {right}
            </Group>
          </Grid.Col>
        ) : null}
      </Grid>
    </Box>
  );
}

export function WorkbenchHeaderTitleCluster({
  children,
  "data-myoxus-ui-role": uiRole = "workbench-header-title-cluster",
  ...props
}: PropsWithChildren<
  ComponentProps<typeof Group> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <Group
      {...props}
      align="center"
      data-myoxus-ui-role={uiRole}
      justify="center"
      wrap="nowrap"
    >
      {children}
    </Group>
  );
}

type WorkbenchRouteChromeProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>;

export function WorkbenchRouteRoot({
  children,
  "data-myoxus-ui-role": uiRole = "workbench-route-root",
  ...props
}: WorkbenchRouteChromeProps) {
  return (
    <Stack
      {...props}
      data-myoxus-ui-role={uiRole}
      gap={0}
      h="100%"
      maw="100dvw"
      mih={0}
      miw={0}
      pos="relative"
      w="100%"
    >
      {children}
    </Stack>
  );
}

export function WorkbenchRouteHeader({
  children,
  showSwitch = false,
  "data-myoxus-ui-role": uiRole = "workbench-route-header",
  ...props
}: WorkbenchRouteChromeProps & { showSwitch?: boolean }) {
  return (
    <Box
      {...props}
      component="header"
      data-myoxus-ui-role={uiRole}
      pb="sm"
      w="100%"
    >
      <Center
        data-myoxus-ui-role={`${uiRole}:content`}
        mih="calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"
        pl={showSwitch ? "xs" : "lg"}
        pr="lg"
        py="xs"
        w="100%"
      >
        <Grid
          align="center"
          columns={12}
          data-myoxus-ui-role={`${uiRole}:grid`}
          gap={0}
          w="100%"
        >
          {children}
        </Grid>
      </Center>
      <Divider data-myoxus-ui-role={`${uiRole}:divider`} />
    </Box>
  );
}

export function WorkbenchRouteEdgeActionSlot({
  children,
  visible = true,
  "data-myoxus-ui-role": uiRole = "workbench-route-edge-action-slot",
  ...props
}: WorkbenchRouteChromeProps & { visible?: boolean }) {
  if (!visible) return null;
  return (
    <Grid.Col {...props} data-myoxus-ui-role={uiRole} span="content">
      {children}
    </Grid.Col>
  );
}

export function WorkbenchRouteHeaderSlot({
  children,
  "data-myoxus-ui-role": uiRole = "workbench-route-header-slot",
  ...props
}: WorkbenchRouteChromeProps) {
  return (
    <Grid.Col {...props} data-myoxus-ui-role={uiRole} span="auto">
      <Box
        data-myoxus-ui-role="workbench-route-header-slot-inner"
        display="grid"
        miw={0}
        px="lg"
        w="100%"
      >
        {children}
      </Box>
    </Grid.Col>
  );
}

export type WorkbenchRouteSurfaceProps = PropsWithChildren<
  Omit<ComponentProps<typeof ScrollArea>, "children" | "viewportRef"> & {
    context?: ReactNode;
    contextVisible?: boolean;
    viewportBounded?: boolean;
  }
>;

/**
 * Single page-scrolling owner for a Workbench route. The main target and an
 * optional contextual tool share one Mantine Grid so a tool never creates a
 * second page frame or reserves an invisible column.
 */
export const WorkbenchRouteSurface = forwardRef<
  HTMLDivElement,
  WorkbenchRouteSurfaceProps
>(function WorkbenchRouteSurface(
  {
    children,
    context,
    contextVisible = false,
    viewportBounded = false,
    viewportProps,
    ...props
  },
  ref,
) {
  return (
    <ScrollArea
      {...props}
      data-context-visible={contextVisible ? "true" : "false"}
      data-myoxus-ui-role="workbench-route-surface"
      flex="1 1 auto"
      h="100%"
      mih={0}
      miw={0}
      scrollbars="y"
      // Page-scrolling routes keep their intrinsic height so Firefox observes
      // content growth. Split panes explicitly opt into a bounded viewport and
      // let their own native ScrollAreas own the overflow instead.
      styles={{
        content: {
          display: "flex",
          flexDirection: "column",
          flex: viewportBounded ? "1 1 0" : "1 0 auto",
          minHeight: viewportBounded ? 0 : undefined,
          height: viewportBounded ? "100%" : undefined,
        },
      }}
      type="auto"
      viewportRef={ref}
      viewportProps={{
        ...viewportProps,
        // Column growth gives the content its intrinsic height while still
        // filling short routes and providing a definite height for canvases.
        style: {
          ...viewportProps?.style,
          display: "flex",
          flexDirection: "column",
          // Context tools measure their native scroll cap against this bounded
          // surface, not the window that also includes the Workbench header.
          containerType: "size",
        },
      }}
      w="100%"
    >
      <Grid
        align="flex-start"
        columns={12}
        data-myoxus-ui-role="workbench-route-surface-grid"
        display="flex"
        flex="1 1 auto"
        gap={0}
        mih={viewportBounded ? 0 : "100%"}
        h={viewportBounded ? "100%" : undefined}
        // Fill short routes, but let long content resize the observed wrapper.
        styles={{
          root: { flexDirection: "column" },
          inner: { flex: 1, minHeight: viewportBounded ? 0 : undefined },
        }}
      >
        <Grid.Col
          data-myoxus-ui-role="workbench-view-body-target-owner"
          display="flex"
          mih={viewportBounded ? 0 : "100%"}
          h={viewportBounded ? "100%" : undefined}
          miw={0}
          span={contextVisible ? { base: 12, md: 8 } : 12}
        >
          {children}
        </Grid.Col>
        {context}
      </Grid>
    </ScrollArea>
  );
});
