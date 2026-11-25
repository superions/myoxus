// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared Admin shell primitives.
 *
 * Top-level pages should compose these instead of hand-rolling their own
 * Header + scroll container + sticky sub-navigation. This keeps route chrome,
 * content width and surface rhythm visually consistent across the Admin UI.
 */
import {
  PageContentRail,
  type PageContentWidth,
  PageFrame,
  PageFrameBody,
  PageScrollViewport,
  SettingsPageHeader,
  TabsList,
  TabsTrigger,
  VisuallyHidden,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";

type AdminPageWidth = PageContentWidth;

export type AdminSubnavItem = {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
  testId?: string;
};

export function AdminPageFrame({
  title,
  actions,
  children,
  routeAnchor,
  testId = "admin-page-frame",
}: {
  title: string;
  /** Page-wide actions/status stay with the stable title, outside tab panels. */
  actions?: ReactNode;
  children: ReactNode;
  /** Stable route-level anchor consumed by the live Admin UI facade E2E matrix. */
  routeAnchor?: string;
  testId?: string;
}) {
  return (
    <PageFrame
      data-admin-page-frame="true"
      data-admin-route-anchor={routeAnchor}
      data-admin-shell
      data-testid={testId}
      data-myoxus-ui-role="admin-page-frame"
    >
      <VisuallyHidden aria-hidden data-testid="admin-page-title">
        {title}
      </VisuallyHidden>
      <VisuallyHidden aria-hidden data-testid="header">
        {title}
      </VisuallyHidden>
      <PageContentRail width="data" scroll>
        <SettingsPageHeader title={title} actions={actions} />
      </PageContentRail>
      <PageFrameBody data-myoxus-ui-role="admin-page-frame-body">
        {children}
      </PageFrameBody>
    </PageFrame>
  );
}

export function AdminPageScroll({
  children,
  gap,
  width = "data",
}: {
  children: ReactNode;
  gap?: "spacious";
  width?: AdminPageWidth;
}) {
  return (
    <PageScrollViewport data-myoxus-ui-role="admin-page-scroll">
      <PageContentRail
        width={width}
        scroll
        spacious={gap === "spacious"}
        data-myoxus-ui-role="admin-page-scroll-rail"
      >
        {children}
      </PageContentRail>
    </PageScrollViewport>
  );
}

export function AdminSubnav({
  children,
  items,
  width = "data",
}: {
  children?: ReactNode;
  items?: readonly AdminSubnavItem[];
  width?: AdminPageWidth;
}) {
  const content = items ? (
    <TabsList data-testid="admin-page-subnav-list">
      {items.map((item) => (
        <TabsTrigger
          key={item.value}
          value={item.value}
          disabled={item.disabled}
          data-testid={item.testId}
          leftSection={item.icon}
          rightSection={item.badge}
        >
          {item.label}
        </TabsTrigger>
      ))}
    </TabsList>
  ) : (
    children
  );

  return (
    <PageContentRail
      width={width}
      data-testid="admin-page-subnav"
      data-myoxus-ui-role="admin-page-subnav"
    >
      {content}
    </PageContentRail>
  );
}
