// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
/**
 * Live Admin UI facade closeout sweep.
 *
 * This is deliberately a running-stack gate, not a component snapshot. It reads
 * the canonical route matrix, opens every authenticated Admin route, captures
 * review screenshots, checks runtime CSS variables and fails on fatal browser
 * errors. The assertions are semantic so the test catches old framework/default
 * chrome without binding the product to brittle pixel snapshots.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import type {
  APIRequestContext,
  BrowserContext,
  Page,
  TestInfo,
} from "@playwright/test";

import {
  type AdminRuntimeError,
  formatAdminRuntimeErrors,
  installAdminRuntimeErrorCollector,
  waitForAdminRuntimeReady,
} from "../../fixtures/admin-ui-runtime-errors";
import {
  ADMIN_FRONTEND_BASE,
  API_BASE,
  injectRequestSessionCookies,
} from "../../fixtures/auth";
import { expect, test } from "../../fixtures/index";

type ThemeMode = "light" | "dark" | "system";
type EffectiveThemeProfile = {
  themeMode: ThemeMode;
  theme: { slug: string };
};
type AdminLocaleConfig = {
  admin: {
    adminConfigValues: {
      modules: Array<{
        module: string;
        groups: Array<{
          fields: Array<{ path: string; value: unknown }>;
        }>;
      }>;
    };
  };
};
type MatrixRoute = {
  id: string;
  module: string;
  path: string;
  routeKind: "authenticated" | "fullscreen" | "redirect";
  tabs: string[];
  drawers: string[];
  testAnchors: string[];
};
type RouteMatrix = {
  routes: MatrixRoute[];
};

const MATRIX_PATH = path.resolve(
  process.cwd(),
  "docs/dev/clients/adminfrontend/admin-ui-facade-route-matrix.json",
);
const QA_DIR = path.resolve(
  process.cwd(),
  process.env.MYOXUS_ADMIN_UI_QA_DIR ??
    "playwright/.qa/admin-ui-facade-closeout",
);
const ADMIN_BUNDLE_DIRS = [
  path.resolve(process.cwd(), "client/admin/workspaces/admin/dist"),
  path.resolve(process.cwd(), "client/frontends/static/admin"),
] as const;
const ADMIN_VISUAL_BASELINE_LOCALE = "de";
const ADMIN_VISUAL_BASELINE_THEME_SLUG = "stuttgart";
const MAIN_ENTRY_BASELINE_BYTES = 1_980_000;
const MAIN_ENTRY_MAX_BYTES = Math.ceil(MAIN_ENTRY_BASELINE_BYTES * 1.08);

const matrix = JSON.parse(readFileSync(MATRIX_PATH, "utf8")) as RouteMatrix;
const authenticatedRoutes = matrix.routes.filter(
  (route) => route.routeKind === "authenticated",
);
const routeById = new Map(matrix.routes.map((route) => [route.id, route]));
const themeModes: ThemeMode[] = ["light", "dark", "system"];
const REVIEW_COMMIT = currentGitCommit();
const DETAIL_SURFACE_SCENARIOS: DetailSurfaceScenario[] = [
  {
    routeId: "workspaces",
    surfaceId: "workspace-details",
    expectedDrawer: "workspace details",
    rootSelector: '[data-testid="workspace-detail-aside"]',
    scrollSelector:
      '[data-myoxus-ui-role="admin-page-scroll"] .mantine-ScrollArea-viewport',
    open: async (page) => {
      const row = page.locator('[data-testid^="workspace-soft-row-"]').first();
      await expect(
        row,
        "workspaces detail gate requires a seeded workspace",
      ).toBeVisible({ timeout: 15_000 });
      await row.click();
      await expect(
        page.getByTestId("workspace-drawer-panel-basics"),
      ).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    routeId: "queue",
    surfaceId: "queue-job-details",
    expectedDrawer: "job details",
    rootSelector: '[data-myoxus-ui-role="shell-right-panel"]',
    scrollSelector: '[data-myoxus-ui-role="shell-panel-scroll"]',
    open: async (page) => {
      const row = page.locator('[data-myoxus-ui-role="queue-row"]').first();
      await expect(
        row,
        "queue detail gate requires queue rows from the server",
      ).toBeVisible({ timeout: 15_000 });
      await row.click();
      await expect(
        page.locator('[data-myoxus-ui-role="shell-panel-scroll"]'),
      ).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    routeId: "templates",
    surfaceId: "template-details",
    expectedDrawer: "template details",
    rootSelector: '[role="dialog"]',
    scrollSelector: '[role="dialog"] [data-myoxus-ui-role="drawer-content"]',
    open: async (page) => {
      await page.getByTestId("templates-row-menu-trigger").first().click();
      await page.getByTestId("templates-row-menu-details").click();
      await expect(page.locator('[role="dialog"]')).toBeVisible({
        timeout: 15_000,
      });
    },
  },
  {
    routeId: "pdf-export",
    surfaceId: "pdf-template-details",
    expectedDrawer: "template details",
    rootSelector: '[role="dialog"]',
    scrollSelector: '[role="dialog"] [data-myoxus-ui-role="drawer-content"]',
    open: async (page) => {
      const heading = page
        .locator(
          '[data-myoxus-ui-role="surface-list"] [data-myoxus-ui-role="settings-inline-action"]',
        )
        .first();
      await expect(
        heading,
        "pdf-export detail gate requires bundled templates",
      ).toBeVisible({ timeout: 15_000 });
      await heading.click();
      await expect(page.locator('[role="dialog"]')).toBeVisible({
        timeout: 15_000,
      });
    },
  },
  {
    routeId: "organization",
    surfaceId: "unit-inspector",
    expectedDrawer: "unit inspector",
    rootSelector:
      '[data-testid="organization-units-detail"] [data-testid="unit-detail"]',
    scrollSelector:
      '[data-myoxus-ui-role="admin-page-scroll"] .mantine-ScrollArea-viewport',
    open: async (page) => {
      await page.getByTestId("organization-tab-units").click();
      const row = page
        .locator('[data-testid^="organization-unit-row-"]')
        .first();
      await expect(
        row,
        "organization detail gate requires seeded OUs",
      ).toBeVisible({ timeout: 15_000 });
      await row
        .locator('[data-myoxus-ui-role="button:list-primary-action"]')
        .click();
      await expect(
        page
          .locator(
            '[data-testid="organization-units-detail"] [data-testid="unit-detail"]',
          )
          .first(),
      ).toBeVisible({ timeout: 15_000 });
    },
  },
];
const WIDTH_BUDGET_BY_ROUTE: Record<
  string,
  { expectedRail: "data" | "wide" | "full"; reason: string }
> = {
  "audit-log": {
    expectedRail: "data",
    reason: "wide audit table and JSON diff drawer need data-density width",
  },
  dashboard: {
    expectedRail: "data",
    reason: "dashboard metric grid uses the broad data rail",
  },
  design: {
    expectedRail: "data",
    reason: "theme previews need room while surrounding controls stay unified",
  },
  documents: {
    expectedRail: "data",
    reason: "document admin tables and status/value lists share the data rail",
  },
  "git-sync": {
    expectedRail: "data",
    reason: "profile, operation and storage grids share the data rail",
  },
  organization: {
    expectedRail: "data",
    reason: "organization list plus inspector and organigram need data width",
  },
  "pdf-export": {
    expectedRail: "data",
    reason: "template, font, ICC and job tables share the data rail",
  },
  performance: {
    expectedRail: "data",
    reason: "metric charts and tuning tables share the data rail",
  },
  queue: {
    expectedRail: "data",
    reason: "queue rows and worker settings use broad operational tables",
  },
  storage: {
    expectedRail: "data",
    reason: "storage tables and backend cards use data-density width",
  },
  system: {
    expectedRail: "data",
    reason: "system categories, live stats and log panels use data width",
  },
  templates: {
    expectedRail: "data",
    reason: "catalog, assignments and versions use data-density width",
  },
  typography: {
    expectedRail: "data",
    reason: "font library and typography previews need data width",
  },
  security: {
    expectedRail: "wide",
    reason: "forms should remain readable without table-like full spread",
  },
  workspaces: {
    expectedRail: "data",
    reason: "master/detail workspace management intentionally uses data width",
  },
  ai: {
    expectedRail: "data",
    reason: "provider cards and usage/policy grids use the shared data rail",
  },
};

type EvidencePhase = "initial" | "bottom";
type EvidenceViewport = "desktop" | "narrow";
type RouteEvidenceRecord = {
  routeId: string;
  themeMode: ThemeMode;
  phase: EvidencePhase;
  viewport: EvidenceViewport;
  screenshot: string;
  metadata: string;
  reviewedAt: string;
  fixedByCommit: string;
};
type DetailSurfaceScenario = {
  routeId: string;
  surfaceId: string;
  expectedDrawer: string;
  open: (page: Page) => Promise<void>;
  rootSelector: string;
  scrollSelector?: string;
};
type DetailSurfaceSnapshot = {
  routeId: string;
  surfaceId: string;
  expectedDrawer: string;
  rootExists: boolean;
  rootVisible: boolean;
  rootLabel: string;
  scrollRoot: string;
  clientHeight: number;
  scrollHeight: number;
  scrollable: boolean;
  bottomScrollTop: number;
  bottomReached: boolean;
  bottomContentVisible: boolean;
  horizontalOverflow: number;
  focusableControlCount: number;
  lastFocusableVisible: boolean;
  queueRows?: {
    compactToggleCount: number;
    visibleActionLabels: string[];
    oversizedActionButtons: string[];
  };
  findings: string[];
};

const capturedRouteEvidence = new Map<string, RouteEvidenceRecord[]>();

function currentGitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function adminRelativePath(matrixPath: string): string {
  const withoutPrefix = matrixPath.replace(/^\/adminfrontend/, "") || "/";
  return withoutPrefix.replace(/\/\*$/, "");
}

function cssString(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function contactSheetName(value: string) {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function routeEvidenceKey(
  routeId: string,
  themeMode: ThemeMode,
  viewport: EvidenceViewport,
) {
  return `${themeMode}:${viewport}:${routeId}`;
}

function resolveAdminBundleDir(): string {
  const bundleDir = ADMIN_BUNDLE_DIRS.find((candidate) =>
    existsSync(path.join(candidate, "assets-manifest.json")),
  );
  expect(
    bundleDir,
    `admin bundle manifest must exist in one of: ${ADMIN_BUNDLE_DIRS.join(", ")}`,
  ).toBeTruthy();
  return bundleDir!;
}

async function signInAsAdmin(
  context: BrowserContext,
  request: APIRequestContext,
) {
  await injectRequestSessionCookies(context, request);
}

async function installAdminVisualBaselineLocale(context: BrowserContext) {
  await context.addInitScript((locale) => {
    Object.defineProperty(navigator, "language", {
      configurable: true,
      get: () => locale,
    });
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      get: () => [locale],
    });
    const applyDocumentLanguage = () => {
      if (document.documentElement) {
        document.documentElement.lang = locale;
      }
    };
    applyDocumentLanguage();
    document.addEventListener("DOMContentLoaded", applyDocumentLanguage, {
      once: true,
    });
  }, ADMIN_VISUAL_BASELINE_LOCALE);
}

async function installAdminVisualBrowserHelpers(context: BrowserContext) {
  await context.addInitScript(() => {
    const visible = (node: Element) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const hasOwnLoadingText = (node: Element) =>
      Array.from(node.childNodes).some((child) => {
        if (child.nodeType !== Node.TEXT_NODE) return false;
        const text = (child.textContent ?? "").trim();
        return /^(loading|wird geladen|lädt|laedt)(\.{0,3})?$/i.test(text);
      });
    Object.defineProperty(window, "__myoxusAdminVisualHelpers", {
      configurable: true,
      value: { hasOwnLoadingText, visible },
    });
  });
}

async function gql<T>(
  request: APIRequestContext,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await request.post(`${API_BASE}/graphql`, {
    data: { query, variables },
    headers: { "Content-Type": "application/json" },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const body = await response.json();
  expect(body.errors ?? []).toEqual([]);
  return body.data as T;
}

async function readEffectiveThemeProfile(
  request: APIRequestContext,
): Promise<EffectiveThemeProfile> {
  const data = await gql<{
    admin: { effectiveThemeProfile: EffectiveThemeProfile };
  }>(
    request,
    `query AdminUiFacadeSweepEffectiveThemeProfile {
      admin {
        effectiveThemeProfile {
          themeMode
          theme { slug }
        }
      }
    }`,
  );
  return data.admin.effectiveThemeProfile;
}

async function setThemeProfile(
  request: APIRequestContext,
  input: { themeSlug: string; themeMode: ThemeMode },
): Promise<void> {
  const data = await gql<{ admin: { setThemeProfile: EffectiveThemeProfile } }>(
    request,
    `mutation AdminUiFacadeSweepSetThemeProfile($input: SetThemeProfileInput!) {
      admin {
        setThemeProfile(input: $input) {
          themeMode
          theme { slug }
        }
      }
    }`,
    { input },
  );
  expect(data.admin.setThemeProfile.theme.slug).toBe(input.themeSlug);
  expect(data.admin.setThemeProfile.themeMode).toBe(input.themeMode);
}

async function readAdminLocale(request: APIRequestContext): Promise<string> {
  const data = await gql<AdminLocaleConfig>(
    request,
    `query AdminUiFacadeSweepLocale {
      admin {
        adminConfigValues {
          modules {
            module
            groups { fields { path value } }
          }
        }
      }
    }`,
  );
  const value = data.admin.adminConfigValues.modules
    .find((module) => module.module === "admin_i18n")
    ?.groups.flatMap((group) => group.fields)
    .find((field) => field.path === "admin_i18n.default_locale")?.value;
  if (typeof value !== "string") {
    throw new Error("admin_i18n.default_locale is missing from Admin config");
  }
  return value;
}

async function setAdminLocale(
  request: APIRequestContext,
  locale: string,
): Promise<void> {
  const data = await gql<{
    admin: {
      adminUpdateConfig: {
        applied: boolean;
        fieldErrors: Array<{ path: string; message: string }>;
      };
    };
  }>(
    request,
    `mutation AdminUiFacadeSweepSetLocale($updates: [UpdateAppConfigInput!]!) {
      admin {
        adminUpdateConfig(updates: $updates) {
          applied
          fieldErrors { path message }
        }
      }
    }`,
    {
      updates: [{ module: "admin_i18n", key: "default_locale", value: locale }],
    },
  );
  expect(data.admin.adminUpdateConfig.fieldErrors).toEqual([]);
  expect(data.admin.adminUpdateConfig.applied).toBe(true);
}

function routeAnchorSelector(route: MatrixRoute) {
  const selectors = route.testAnchors.flatMap((anchor) => [
    `[data-admin-route-anchor="${anchor}"]`,
    `[data-testid="${anchor}"]`,
  ]);
  return selectors.join(", ");
}

async function openAdminRoute(page: Page, route: MatrixRoute) {
  await page.goto(`${ADMIN_FRONTEND_BASE}${adminRelativePath(route.path)}`, {
    waitUntil: "load",
    timeout: 20_000,
  });
  const anchorSelector = routeAnchorSelector(route);
  await waitForAdminRuntimeReady(page, anchorSelector);
  await page.waitForFunction(
    ({ anchorSelector: selector }) => {
      const { visible } = (
        window as typeof window & {
          __myoxusAdminVisualHelpers: {
            visible: (node: Element) => boolean;
          };
        }
      ).__myoxusAdminVisualHelpers;
      const anchor = document.querySelector(selector);
      const heading = Array.from(
        document.querySelectorAll(
          "h1, .org-h1, [data-myoxus-ui-role='settings-page-title']",
        ),
      ).find(visible);
      const scrollRoot = document.querySelector(
        '[data-myoxus-ui-role="admin-page-scroll"]',
      );
      return Boolean(anchor && heading && scrollRoot);
    },
    { anchorSelector },
    { timeout: 30_000 },
  );
  await waitForAdminBrandingApiCss(page);
}

async function waitForAdminBrandingApiCss(page: Page) {
  await page.waitForFunction(
    () => {
      const style = document.getElementById(
        "myoxus-branding-css",
      ) as HTMLStyleElement | null;
      if (style?.dataset.myoxusBrandingSource !== "api") {
        return false;
      }
      const rootStyle = getComputedStyle(document.documentElement);
      return [
        "--myoxus-text-primary-color",
        "--myoxus-background-primary-color",
        "--myoxus-typography-h1-size",
        "--myoxus-typography-h1-family",
      ].every((name) => rootStyle.getPropertyValue(name).trim() !== "");
    },
    { timeout: 15_000 },
  );
}

async function resetAdminPageScroll(page: Page) {
  await page.evaluate(async () => {
    const scrollRoot = document.querySelector(
      '[data-myoxus-ui-role="admin-page-scroll"]',
    ) as HTMLElement | null;
    const scroll =
      (scrollRoot?.querySelector(
        ".mantine-ScrollArea-viewport",
      ) as HTMLElement | null) ?? scrollRoot;
    if (scroll) scroll.scrollTop = 0;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

type RouteVisualSnapshot = {
  routeId: string;
  themeMode: ThemeMode;
  anchorVisible: boolean;
  url: string;
  tabLabel: string;
  horizontalOverflow: number;
  heading: {
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    color: string;
  } | null;
  panelCount: number;
  buttonCount: number;
  chromeCount: number;
  roleCounts: Record<string, number>;
  suspiciousDefaultButtons: string[];
  lowContrastControls: string[];
  styleBudget: {
    buttonTextSignatureCount: number;
    buttonIconSignatureCount: number;
    typographySignatureCount: number;
    chromeTypographySignatureCount: number;
    buttonRoleSignatures: Record<
      string,
      Array<{ signature: string; count: number; examples: string[] }>
    >;
    headingRoleSignatures: Record<
      string,
      Array<{ signature: string; count: number; examples: string[] }>
    >;
    typographyRoleSignatures: Record<
      string,
      Array<{ signature: string; count: number; examples: string[] }>
    >;
    findings: string[];
  };
  scrollContainer: {
    exists: boolean;
    innerViewportNode: string;
    clientHeight: number;
    viewportHeight: number;
    scrollHeight: number;
    scrollable: boolean;
    initialScrollTop: number;
    bottomScrollTop: number;
    bottomReached: boolean;
    bottomContentVisible: boolean;
    bottomContentLabel: string;
    overflowY: string;
  };
  railWidth: number;
  railLeft: number;
  railRight: number;
  stickyFixedChildCount: number;
  tableWidthPx: number;
  firstVisiblePanel: string;
  lastVisiblePanel: string;
  cssVariables: Record<string, string>;
};

type InitialRouteVisualSnapshot = {
  routeId: string;
  themeMode: ThemeMode;
  anchorVisible: boolean;
  headingText: string;
  sidebarActiveNavigation: {
    count: number;
    candidates: Array<{
      label: string;
      href: string;
      left: number;
      right: number;
      top: number;
      bottom: number;
    }>;
    exists: boolean;
    label: string;
    href: string;
    matchesCurrentRoute: boolean;
    visibleInRail: boolean;
    top: number;
    bottom: number;
    railTop: number;
    railBottom: number;
  };
  topLevelSubnav: {
    exists: boolean;
    tabCount: number;
    surfaceBorderBottomWidth: string;
    tabsListBorderStyle: string;
    tabsListBorderRadius: string;
    firstTabBorderRadius: string;
    surfaceTop: number;
    surfaceBottom: number;
    tabsListTop: number;
    tabsListBottom: number;
    tabsListLeft: number;
    tabsListRight: number;
    tabsListWidth: number;
    tabsListClientWidth: number;
    tabsListScrollWidth: number;
    tabsListMaskImage: string;
    tabsListScrollbarWidth: string;
    railWidth: number;
    tabsListHeight: number;
    tabsListWithinSurface: boolean;
    mobileTriggerExists: boolean;
    mobileTriggerBottom: number;
    mobileTriggerRight: number;
    overlapsMobileTrigger: boolean;
  };
  mobileTrigger: {
    exists: boolean;
    bottom: number;
    firstContentTop: number;
    overlapsFirstContent: boolean;
  };
  loneIconShoulders: string[];
  svgOnlyHeaderActions: string[];
  directHeaderIcons: string[];
  truncatedSelectLabels: string[];
  tabHeadingNumberConflicts: string[];
  scrollContainer: {
    exists: boolean;
    clientHeight: number;
    viewportHeight: number;
    initialScrollTop: number;
    overflowY: string;
  };
  aboveFold: {
    visibleRailChildren: number;
    visiblePanelCount: number;
    visibleButtonCount: number;
    visibleTextLength: number;
    firstContentGap: number | null;
    heroTrailingWhitespace: number | null;
    textSample: string;
    loadingTextCount: number;
    skeletonCount: number;
  };
  auditLog: {
    rawPrimaryEventLabels: string[];
    wrappedCategoryBadges: string[];
  };
};

type RouteEvidenceSnapshot = RouteVisualSnapshot | InitialRouteVisualSnapshot;

async function waitForAdminRouteAboveFoldContent(
  page: Page,
  route: MatrixRoute,
) {
  try {
    await page.waitForFunction(
      ({ routeId }) => {
        const { hasOwnLoadingText, visible } = (
          window as typeof window & {
            __myoxusAdminVisualHelpers: {
              hasOwnLoadingText: (node: Element) => boolean;
              visible: (node: Element) => boolean;
            };
          }
        ).__myoxusAdminVisualHelpers;
        const scrollRoot = document.querySelector(
          '[data-myoxus-ui-role="admin-page-scroll"]',
        );
        const viewport =
          scrollRoot?.querySelector(".mantine-ScrollArea-viewport") ??
          scrollRoot;
        const viewportRect = viewport?.getBoundingClientRect();
        const rail = scrollRoot?.querySelector(
          '[data-myoxus-ui-role="admin-page-scroll-rail"]',
        );
        const children = rail ? Array.from(rail.children).filter(visible) : [];
        const aboveFoldChildren = viewportRect
          ? children.filter((child) => {
              const rect = child.getBoundingClientRect();
              return (
                rect.bottom > viewportRect.top + 8 &&
                rect.top < viewportRect.bottom - 8
              );
            })
          : children;
        const sample = aboveFoldChildren
          .map((child) => child.textContent?.trim().replace(/\s+/g, " ") ?? "")
          .join(" ")
          .trim();
        const loadingTextCount = Array.from(document.body.querySelectorAll("*"))
          .filter(visible)
          .filter(hasOwnLoadingText).length;
        const skeletonCount = Array.from(
          document.querySelectorAll(
            ".mantine-Skeleton-root, [data-myoxus-ui-role='skeleton']",
          ),
        ).filter(visible).length;
        const hasAboveFoldContent =
          aboveFoldChildren.length > 0 && sample.length >= 24;

        if (!hasAboveFoldContent || loadingTextCount > 0 || skeletonCount > 0) {
          document.documentElement.dataset.adminVisualWaitState =
            JSON.stringify({
              routeId,
              scrollRoot: Boolean(scrollRoot),
              viewport: Boolean(viewport),
              rail: Boolean(rail),
              childCount: children.length,
              aboveFoldChildren: aboveFoldChildren.length,
              sample: sample.slice(0, 180),
              sampleLength: sample.length,
              loadingTextCount,
              skeletonCount,
            });
        } else {
          delete document.documentElement.dataset.adminVisualWaitState;
        }
        return (
          hasAboveFoldContent && loadingTextCount === 0 && skeletonCount === 0
        );
      },
      { routeId: route.id },
      { timeout: 30_000 },
    );
  } catch (error) {
    const waitState = await page.evaluate(
      () => document.documentElement.dataset.adminVisualWaitState ?? "{}",
    );
    throw new Error(
      `${route.id} did not become visually ready above the fold: ${waitState}\n${String(
        error,
      )}`,
    );
  }
}

async function readInitialRouteVisualSnapshot(
  page: Page,
  route: MatrixRoute,
  themeMode: ThemeMode,
): Promise<InitialRouteVisualSnapshot> {
  return page.evaluate(
    ({ routeId, anchorSelector, themeMode }) => {
      const { hasOwnLoadingText, visible } = (
        window as typeof window & {
          __myoxusAdminVisualHelpers: {
            hasOwnLoadingText: (node: Element) => boolean;
            visible: (node: Element) => boolean;
          };
        }
      ).__myoxusAdminVisualHelpers;
      const scrollRoot = document.querySelector(
        '[data-myoxus-ui-role="admin-page-scroll"]',
      ) as HTMLElement | null;
      const mantineViewport = scrollRoot?.querySelector(
        ".mantine-ScrollArea-viewport",
      ) as HTMLElement | null;
      const scroll = mantineViewport ?? scrollRoot;
      const rail = scrollRoot?.querySelector(
        '[data-myoxus-ui-role="admin-page-scroll-rail"]',
      ) as HTMLElement | null;
      const viewportRect = scroll?.getBoundingClientRect() ?? null;
      const visibleChildren = rail
        ? Array.from(rail.children).filter(visible)
        : [];
      const aboveFoldChildren = viewportRect
        ? visibleChildren.filter((child) => {
            const rect = child.getBoundingClientRect();
            return (
              rect.bottom > viewportRect.top + 8 &&
              rect.top < viewportRect.bottom - 8
            );
          })
        : visibleChildren;
      const aboveFoldText = aboveFoldChildren
        .map((child) => child.textContent?.trim().replace(/\s+/g, " ") ?? "")
        .join(" ")
        .trim();
      const firstRect = aboveFoldChildren[0]?.getBoundingClientRect();
      const heroCard = Array.from(
        document.querySelectorAll<HTMLElement>(".admin-role-surface-panel"),
      )
        .filter(visible)
        .find((card) => card.querySelector("h1, .org-h1"));
      const heroHeader = heroCard?.querySelector<HTMLElement>(
        ".admin-role-section-header",
      );
      const heroCardContent = heroCard?.querySelector<HTMLElement>(
        ".admin-role-surface-panel-content",
      );
      const heroCardRect = heroCard?.getBoundingClientRect();
      const heroHeaderRect = heroHeader?.getBoundingClientRect();
      const heroHeaderIsStandalone = Boolean(
        heroCardContent &&
        heroHeader &&
        Array.from(heroCardContent.children).findLast(visible) === heroHeader,
      );
      const heading = Array.from(
        document.querySelectorAll(
          "h1, .org-h1, [data-myoxus-ui-role='settings-page-title']",
        ),
      ).find(visible);
      const buttons = Array.from(
        document.querySelectorAll("button, [role='button']"),
      ).filter(visible);
      const panelSelector =
        ".admin-role-surface-panel, [data-myoxus-ui-role='card'], [data-myoxus-ui-role='settings-panel'], .admin-ui-bordered-panel, .admin-ui-soft-list";
      const panels = Array.from(
        document.querySelectorAll(panelSelector),
      ).filter(visible);
      const loadingTextCount = Array.from(document.body.querySelectorAll("*"))
        .filter(visible)
        .filter(hasOwnLoadingText).length;
      const skeletonCount = Array.from(
        document.querySelectorAll(
          ".mantine-Skeleton-root, [data-myoxus-ui-role='skeleton']",
        ),
      ).filter(visible).length;
      const rawPrimaryEventLabels = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="audit-event-label"]',
        ),
      )
        .filter(visible)
        .map((node) => ({
          label: node.textContent?.trim().replace(/\s+/g, " ") ?? "",
          eventKey: node.dataset.eventKey ?? "",
        }))
        .filter(
          ({ label, eventKey }) =>
            label === eventKey ||
            /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/.test(label),
        )
        .map(({ label }) => label);
      const wrappedCategoryBadges = Array.from(
        document.querySelectorAll<HTMLElement>(".admin-audit-category-badge"),
      )
        .filter(visible)
        .flatMap((node) => {
          const style = getComputedStyle(node);
          const fontSize = Number.parseFloat(style.fontSize) || 10;
          const lineHeight =
            Number.parseFloat(style.lineHeight) || Math.round(fontSize * 1.35);
          const rect = node.getBoundingClientRect();
          const text = node.textContent?.trim().replace(/\s+/g, " ") ?? "";
          const wrapped = rect.height > lineHeight * 1.65;
          return wrapped
            ? [`${text || "unnamed category"} (${Math.round(rect.height)}px)`]
            : [];
        });
      const scrollStyle = scroll ? getComputedStyle(scroll) : null;
      const navRail = document.querySelector<HTMLElement>(
        '[data-myoxus-ui-role="sidebar-nav-list"]',
      );
      const activeNavs = Array.from(
        navRail?.querySelectorAll<HTMLElement>(
          '[data-myoxus-ui-role="navigation-link"][data-active]',
        ) ?? [],
      ).filter(visible);
      const activeNav = activeNavs[0] ?? null;
      const activeRect = activeNav?.getBoundingClientRect();
      const navRailRect = navRail?.getBoundingClientRect();
      const activeHref = activeNav
        ? new URL(activeNav.getAttribute("href") ?? "", window.location.href)
            .pathname
        : "";
      const currentPath = window.location.pathname;
      const matchesCurrentRoute = Boolean(
        activeHref &&
        (currentPath === activeHref ||
          currentPath.startsWith(`${activeHref}/`)),
      );
      const visibleInRail = Boolean(
        activeRect &&
        navRailRect &&
        activeRect.top >= navRailRect.top - 2 &&
        activeRect.bottom <= navRailRect.bottom + 2,
      );
      const subnav = document.querySelector<HTMLElement>(
        '[data-testid="admin-page-subnav"]',
      );
      const tabsList = subnav?.querySelector<HTMLElement>(
        '[data-myoxus-ui-role="tabs-list"]',
      );
      const tabs = subnav
        ? Array.from(
            subnav.querySelectorAll<HTMLElement>(
              '[data-myoxus-ui-role="tabs-trigger"]',
            ),
          )
        : [];
      const firstTab = tabs[0] ?? null;
      const activeTabLabel =
        (
          subnav?.querySelector<HTMLElement>(
            [
              '[data-myoxus-ui-role="tabs-trigger"][aria-selected="true"]',
              '[data-myoxus-ui-role="tabs-trigger"][data-active="true"]',
              '[role="tab"][aria-selected="true"]',
            ].join(","),
          ) ?? null
        )?.textContent
          ?.trim()
          .replace(/\s+/g, " ") ?? "";
      const subnavStyle = subnav ? getComputedStyle(subnav) : null;
      const tabsListStyle = tabsList ? getComputedStyle(tabsList) : null;
      const firstTabStyle = firstTab ? getComputedStyle(firstTab) : null;
      const subnavRect = subnav?.getBoundingClientRect();
      const tabsListRect = tabsList?.getBoundingClientRect();
      const subnavRailRect = subnav
        ?.querySelector<HTMLElement>(
          '[data-myoxus-ui-role="admin-page-subnav-rail"]',
        )
        ?.getBoundingClientRect();
      const mobileTrigger = document.querySelector<HTMLElement>(
        ".admin-mobile-sidebar-trigger",
      );
      const mobileTriggerRect = mobileTrigger?.getBoundingClientRect();
      const rectsOverlap = (
        first: DOMRect | undefined,
        second: DOMRect | undefined,
      ) =>
        Boolean(
          first &&
          second &&
          first.left < second.right &&
          first.right > second.left &&
          first.top < second.bottom &&
          first.bottom > second.top,
        );
      const loneIconShoulders = Array.from(
        document.querySelectorAll<HTMLElement>(".admin-role-section-shoulder"),
      )
        .filter(visible)
        .filter((node) => {
          const text = node.textContent?.trim().replace(/\s+/g, " ") ?? "";
          return text.length === 0 && Boolean(node.querySelector("svg"));
        })
        .map((node) => {
          const header = node.closest(".admin-role-section-header");
          const title =
            header
              ?.querySelector("h1,h2,h3,h4,h5")
              ?.textContent?.trim()
              .replace(/\s+/g, " ") ?? "unknown";
          return title;
        });
      const svgOnlyHeaderActions = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".admin-ui-section-header-action",
        ),
      )
        .filter(visible)
        .filter((node) => {
          const text = node.textContent?.trim().replace(/\s+/g, " ") ?? "";
          return text.length === 0 && Boolean(node.querySelector("svg"));
        })
        .map((node) => {
          const header = node.closest(".admin-ui-section-header-row");
          const title =
            header
              ?.querySelector("h1,h2,h3,h4,h5")
              ?.textContent?.trim()
              .replace(/\s+/g, " ") ?? "unknown";
          return title;
        });
      const directHeaderIcons = Array.from(
        document.querySelectorAll<HTMLElement>(".admin-ui-section-header-row"),
      )
        .filter(visible)
        .flatMap((row) =>
          Array.from(row.children)
            .filter(
              (child) =>
                child.tagName.toLowerCase() === "svg" &&
                visible(child) &&
                !child.getAttribute("aria-label") &&
                !child.textContent?.trim(),
            )
            .map(() => {
              const title =
                row
                  .querySelector("h1,h2,h3,h4,h5")
                  ?.textContent?.trim()
                  .replace(/\s+/g, " ") ?? "unknown";
              return title;
            }),
        );
      const truncatedSelectLabels = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-myoxus-ui-role="settings-select"]',
        ),
      )
        .filter(visible)
        .flatMap((root) => {
          const control =
            root.querySelector<HTMLElement>(
              ".mantine-Select-input, input, button, [role='combobox']",
            ) ?? root;
          const text =
            (
              control.textContent ||
              (control instanceof HTMLInputElement ? control.value : "") ||
              control.getAttribute("value") ||
              control.getAttribute("placeholder") ||
              ""
            )
              .trim()
              .replace(/\s+/g, " ") || "unnamed select";
          if (control.scrollWidth <= control.clientWidth + 2) return [];
          return [`${text} (${control.clientWidth}/${control.scrollWidth})`];
        });
      const tabHeadingNumberConflicts = activeTabLabel
        ? Array.from(
            document.querySelectorAll<HTMLElement>(
              ".admin-role-section-header",
            ),
          )
            .filter(visible)
            .filter((header) =>
              Boolean(header.querySelector(".admin-role-section-kicker")),
            )
            .flatMap((header) => {
              const headingText =
                header
                  .querySelector<HTMLElement>("h1,h2,h3,h4,h5")
                  ?.textContent?.trim()
                  .replace(/\s+/g, " ") ?? "";
              return headingText.localeCompare(activeTabLabel, undefined, {
                sensitivity: "base",
              }) === 0
                ? [`${activeTabLabel} uses a numbered tab-intro header`]
                : [];
            })
        : [];

      return {
        routeId,
        themeMode,
        anchorVisible: Boolean(document.querySelector(anchorSelector)),
        headingText: heading?.textContent?.trim().replace(/\s+/g, " ") ?? "",
        sidebarActiveNavigation: {
          count: activeNavs.length,
          candidates: activeNavs.map((node) => {
            const rect = node.getBoundingClientRect();
            return {
              label: node.textContent?.trim().replace(/\s+/g, " ") ?? "",
              href: new URL(
                node.getAttribute("href") ?? "",
                window.location.href,
              ).pathname,
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            };
          }),
          exists: Boolean(activeNav),
          label: activeNav?.textContent?.trim().replace(/\s+/g, " ") ?? "",
          href: activeHref,
          matchesCurrentRoute,
          visibleInRail,
          top: activeRect?.top ?? 0,
          bottom: activeRect?.bottom ?? 0,
          railTop: navRailRect?.top ?? 0,
          railBottom: navRailRect?.bottom ?? 0,
        },
        topLevelSubnav: {
          exists: Boolean(subnav),
          tabCount: tabs.length,
          surfaceBorderBottomWidth: subnavStyle?.borderBottomWidth ?? "",
          tabsListBorderStyle: tabsListStyle?.borderStyle ?? "",
          tabsListBorderRadius: tabsListStyle?.borderRadius ?? "",
          firstTabBorderRadius: firstTabStyle?.borderRadius ?? "",
          surfaceTop: subnavRect?.top ?? 0,
          surfaceBottom: subnavRect?.bottom ?? 0,
          tabsListTop: tabsListRect?.top ?? 0,
          tabsListBottom: tabsListRect?.bottom ?? 0,
          tabsListLeft: tabsListRect?.left ?? 0,
          tabsListRight: tabsListRect?.right ?? 0,
          tabsListWidth: tabsListRect?.width ?? 0,
          tabsListClientWidth: tabsList?.clientWidth ?? 0,
          tabsListScrollWidth: tabsList?.scrollWidth ?? 0,
          tabsListMaskImage:
            tabsListStyle?.maskImage ||
            (tabsListStyle as unknown as { webkitMaskImage?: string } | null)
              ?.webkitMaskImage ||
            "",
          tabsListScrollbarWidth: tabsListStyle?.scrollbarWidth ?? "",
          railWidth: subnavRailRect?.width ?? 0,
          tabsListHeight: tabsListRect?.height ?? 0,
          tabsListWithinSurface: Boolean(
            subnavRect &&
            tabsListRect &&
            tabsListRect.top >= subnavRect.top - 1 &&
            tabsListRect.bottom <= subnavRect.bottom + 1,
          ),
          mobileTriggerExists: Boolean(mobileTrigger),
          mobileTriggerBottom: mobileTriggerRect?.bottom ?? 0,
          mobileTriggerRight: mobileTriggerRect?.right ?? 0,
          overlapsMobileTrigger: rectsOverlap(tabsListRect, mobileTriggerRect),
        },
        mobileTrigger: {
          exists: Boolean(mobileTrigger),
          bottom: mobileTriggerRect?.bottom ?? 0,
          firstContentTop: firstRect?.top ?? 0,
          overlapsFirstContent: rectsOverlap(firstRect, mobileTriggerRect),
        },
        loneIconShoulders,
        svgOnlyHeaderActions,
        directHeaderIcons,
        truncatedSelectLabels,
        tabHeadingNumberConflicts,
        scrollContainer: {
          exists: Boolean(scrollRoot),
          clientHeight: scroll?.clientHeight ?? 0,
          viewportHeight: window.innerHeight,
          initialScrollTop: scroll?.scrollTop ?? 0,
          overflowY: scrollStyle?.overflowY ?? "",
        },
        aboveFold: {
          visibleRailChildren: aboveFoldChildren.length,
          visiblePanelCount: panels.filter((panel) => {
            if (!viewportRect) return true;
            const rect = panel.getBoundingClientRect();
            return (
              rect.bottom > viewportRect.top + 8 &&
              rect.top < viewportRect.bottom - 8
            );
          }).length,
          visibleButtonCount: buttons.filter((button) => {
            if (!viewportRect) return true;
            const rect = button.getBoundingClientRect();
            return (
              rect.bottom > viewportRect.top + 8 &&
              rect.top < viewportRect.bottom - 8
            );
          }).length,
          visibleTextLength: aboveFoldText.length,
          firstContentGap:
            viewportRect && firstRect ? firstRect.top - viewportRect.top : null,
          heroTrailingWhitespace:
            heroHeaderIsStandalone && heroCardRect && heroHeaderRect
              ? heroCardRect.bottom - heroHeaderRect.bottom
              : null,
          textSample: aboveFoldText.slice(0, 220),
          loadingTextCount,
          skeletonCount,
        },
        auditLog: { rawPrimaryEventLabels, wrappedCategoryBadges },
      } satisfies InitialRouteVisualSnapshot;
    },
    {
      routeId: route.id,
      anchorSelector: routeAnchorSelector(route),
      themeMode,
    },
  );
}

async function readRouteVisualSnapshot(
  page: Page,
  route: MatrixRoute,
  themeMode: ThemeMode,
): Promise<RouteVisualSnapshot> {
  return page.evaluate(
    async ({ routeId, anchorSelector, themeMode }) => {
      const nextFrame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const { visible } = (
        window as typeof window & {
          __myoxusAdminVisualHelpers: {
            visible: (node: Element) => boolean;
          };
        }
      ).__myoxusAdminVisualHelpers;
      const canUseAuthoringPreviewException =
        routeId === "design" ||
        routeId.startsWith("design:") ||
        routeId === "typography" ||
        routeId.startsWith("typography:");
      const previewSurfaceSelector = [
        "[data-admin-visual-role='authoring-preview']",
        ".admin-theme-gallery-card",
        ".admin-theme-gallery-card-preview",
        ".admin-theme-gallery-preview-pill",
        ".admin-theme-gallery-preview-swatch",
        ".admin-design-preview-grid",
        ".admin-design-preview-tile",
        ".admin-design-color-preview-card",
        ".admin-design-font-preview-grid",
        ".admin-design-font-family-preview",
        ".admin-typography-preview-box",
        "[data-testid='colors-tab-preview']",
        "[data-testid='typography-preview-pane']",
      ].join(",");
      const isInsideAuthoringPreview = (node: Element) =>
        canUseAuthoringPreviewException &&
        Boolean(node.closest(previewSurfaceSelector));
      const roundedPx = (value: number) => String(Math.round(value));
      const textOf = (node: Element) =>
        (
          node.getAttribute("aria-label") ??
          node.textContent?.trim().replace(/\s+/g, " ") ??
          node.tagName.toLowerCase()
        ).slice(0, 80);
      const addSignature = (
        target: Record<
          string,
          Map<string, { count: number; examples: Set<string> }>
        >,
        role: string,
        signature: string,
        example: string,
      ) => {
        target[role] ??= new Map();
        const existing = target[role].get(signature) ?? {
          count: 0,
          examples: new Set<string>(),
        };
        existing.count += 1;
        if (existing.examples.size < 3) existing.examples.add(example);
        target[role].set(signature, existing);
      };
      const serializeSignatures = (
        source: Record<
          string,
          Map<string, { count: number; examples: Set<string> }>
        >,
      ) =>
        Object.fromEntries(
          Object.entries(source)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([role, signatures]) => [
              role,
              Array.from(signatures.entries())
                .map(([signature, value]) => ({
                  signature,
                  count: value.count,
                  examples: Array.from(value.examples),
                }))
                .sort((left, right) =>
                  left.signature.localeCompare(right.signature),
                ),
            ]),
        );
      const buttonSemanticRole = (button: Element) => {
        const facadeRole = (button as HTMLElement).dataset.myoxusUiRole ?? "";
        const className = String(button.getAttribute("class") ?? "");
        const text = textOf(button);
        if (facadeRole === "tabs-trigger") return "tabs-trigger";
        if (facadeRole === "accordion-control") return "accordion-control";
        if (facadeRole === "settings-inline-action") {
          return "button:compact:inline-link";
        }
        if (facadeRole === "radio-selection-card") {
          return "button:card-option";
        }
        if (facadeRole === "removable-badge-remove") {
          return "button:compact:chip-remove";
        }
        if (button.closest('[data-myoxus-ui-role="form-multi-select-root"]')) {
          return "button:compact:chip-remove";
        }
        if (facadeRole === "navigation-link") {
          return button.closest('[data-myoxus-ui-role="sidebar-nav-root"]')
            ? "button:navigation"
            : "button:card-row";
        }
        if (facadeRole.startsWith("button:")) return facadeRole;
        if (className.includes("admin-workspace-list-card")) {
          return "button:card-row";
        }
        if (className.includes("admin-settings-secret-toggle")) {
          return "button:compact:input-addon";
        }
        if (className.includes("admin-ui-input-end-action")) {
          return "button:compact:input-addon";
        }
        if (className.includes("admin-settings-chip-remove")) {
          return "button:compact:chip-remove";
        }
        if (className.includes("admin-ui-chip-remove")) {
          return "button:compact:chip-remove";
        }
        if (className.includes("admin-ui-token-chip-action")) {
          return "button:compact:chip-remove";
        }
        if (className.includes("admin-ui-soft-item-trigger")) {
          return "button:card-row";
        }
        if (className.includes("admin-ui-collapse-trigger")) {
          return "button:collapse-row";
        }
        if (className.includes("admin-ui-suggestion-option")) {
          return "button:compact:list-option";
        }
        if (
          className.includes("admin-org-unit-row-main") ||
          className.includes("admin-org-member-row") ||
          className.includes("admin-org-membership-row") ||
          className.includes("admin-org-organigram-node")
        ) {
          return "button:card-row";
        }
        if (className.includes("admin-org-catalog-card")) {
          return "button:card-option";
        }
        if (className.includes("admin-org-policy-stage-card")) {
          return "button:card-option";
        }
        if (className.includes("admin-org-row-link")) {
          return "button:compact:inline-link";
        }
        if (className.includes("admin-org-row-danger-link")) {
          return "button:compact:inline-danger";
        }
        if (
          className.includes("admin-org-text-button") ||
          className.includes("admin-org-magic-link-button") ||
          className.includes("admin-org-file-download")
        ) {
          return "button:compact:inline-link";
        }
        if (className.includes("admin-pdf-list-heading-button")) {
          return "button:list-heading";
        }
        if (className.includes("admin-typography-family-trigger")) {
          return "button:compact:font-family-trigger";
        }
        if (className.includes("admin-typography-weight-option")) {
          return "button:compact:font-weight";
        }
        if (className.includes("admin-role-drop-zone-pick")) {
          return "button:compact:upload-pick";
        }
        if (className.includes("admin-role-drop-zone")) {
          return "button:upload-target";
        }
        if (className.includes("mantine-ActionIcon")) {
          return "button:compact:icon";
        }
        if (className.includes("myoxus-ui-number-input-control")) {
          return "button:compact:number-stepper";
        }
        if (
          className.includes("mantine-Button") ||
          className.includes("admin-action-button") ||
          className.includes("admin-theme-gallery-mode") ||
          className.includes("admin-theme-gallery-filter") ||
          className.includes("admin-settings-savebar-button") ||
          className.includes("admin-workspace-button-compact")
        ) {
          return text.length > 0 ? "button:compact" : "button:compact:icon";
        }
        return "button:unknown";
      };
      const buttonSignature = (button: Element) => {
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return [
          `h=${roundedPx(rect.height)}`,
          `fs=${style.fontSize}`,
          `fw=${style.fontWeight}`,
          `lh=${style.lineHeight}`,
          `br=${roundedPx(parseFloat(style.borderTopLeftRadius) || 0)}`,
        ].join("|");
      };
      const headingRole = (headingNode: Element) => {
        const className = String(headingNode.getAttribute("class") ?? "");
        if (
          className.includes("admin-org-detail-title") ||
          className.includes("admin-org-card-title") ||
          className.includes("admin-org-policy-toggle-title") ||
          className.includes("admin-org-organigram-title")
        ) {
          return "heading:subsection";
        }
        if (headingNode.matches("h1, .org-h1")) return "heading:page";
        const tag = headingNode.tagName.toLowerCase();
        if (tag === "h2") return "heading:section";
        if (
          tag === "h3" ||
          tag === "h4" ||
          tag === "h5" ||
          headingNode.matches(".org-h2, .org-h3, .org-h4, .org-h5")
        ) {
          return "heading:subsection";
        }
        return "heading:custom";
      };
      const headingSignature = (headingNode: Element) => {
        const style = getComputedStyle(headingNode);
        return [
          `ff=${style.fontFamily}`,
          `fs=${style.fontSize}`,
          `fw=${style.fontWeight}`,
          `lh=${style.lineHeight}`,
          `fontStyle=${style.fontStyle}`,
          `ls=${style.letterSpacing}`,
          `tt=${style.textTransform}`,
        ].join("|");
      };
      const typographyRole = (node: Element) => {
        if (node.closest(".admin-sidebar")) return "chrome:sidebar";
        if (node.closest("[data-testid='admin-page-subnav']")) {
          return "chrome:subnav";
        }
        const button = node.closest("button, [role='button']");
        if (button) return buttonSemanticRole(button);
        const heading = node.closest(
          "h1, h2, h3, h4, h5, .org-h1, .org-h2, .org-h3, .org-h4, .org-h5, .admin-org-detail-title, .admin-org-card-title, .admin-org-policy-toggle-title, .admin-org-organigram-title, [data-myoxus-ui-role='settings-page-title']",
        );
        if (heading) return headingRole(heading);
        if (node.closest('[data-myoxus-ui-role="mono-text"]')) {
          return "text:mono";
        }
        if (node.closest('[data-myoxus-ui-role="settings-select-root"]')) {
          return "text:option";
        }
        if (node.closest('[data-myoxus-ui-role="form-multi-select-root"]')) {
          return "text:option";
        }
        if (
          node.closest(
            ".mantine-Checkbox-root, .mantine-Checkbox-label, .mantine-Radio-root, .mantine-Radio-label, [data-myoxus-ui-role='checkbox'], [data-myoxus-ui-role='settings-radio-label'], [data-myoxus-ui-role='settings-segmented-label'], [role='checkbox']",
          )
        ) {
          return "text:option";
        }
        if (
          node.closest(
            "label, .mantine-InputWrapper-label, .admin-ui-field-label, .admin-settings-label, .admin-settings-config-label, .admin-org-field-label, .admin-org-inline-eyebrow, .admin-role-field-label, .admin-doc-metric-label, .admin-doc-pager-count, .admin-doc-checkbox-label, .admin-design-font-metric-label, .admin-design-font-sidecar-label, .admin-typography-details-summary",
          )
        ) {
          return "text:label";
        }
        if (
          node.closest(
            ".admin-doc-metric-value, .admin-doc-bucket-count, .admin-dashboard-highlight-value, .admin-dashboard-inline-metric-value, .admin-role-shoulder-stat-value, .admin-settings-suffix, .admin-ui-meta-inline, .admin-design-font-library-summary-value, .admin-typography-definition-value",
          )
        ) {
          return "text:metric";
        }
        if (
          node.closest(
            ".admin-ui-stat-hint, .admin-ui-callout-warning, .admin-ui-callout-error, .admin-ui-callout-success, .admin-ui-error-text, .admin-settings-field-error",
          )
        ) {
          return "text:status";
        }
        if (
          node.closest(
            ".admin-role-section-description, .admin-ui-panel-description, .admin-ui-copy, .admin-ui-copy-xs, .admin-ui-soft-note, .admin-typography-muted-text, .admin-typography-edit-notice-row, .admin-org-description, .admin-org-card-description, .admin-org-card-text, .admin-org-panel-hint, .admin-org-placeholder-hint, .admin-org-detail-subtitle, .admin-org-request-summary",
          )
        ) {
          return "text:description";
        }
        if (
          node.closest(
            ".mantine-Badge-root, [data-myoxus-ui-role='badge'], [data-myoxus-ui-role^='badge:'], .admin-role-status-dot, .admin-audit-category-badge, .admin-audit-row-field-chip, .admin-audit-row-field-more, .admin-design-font-weight-chip",
          )
        ) {
          return "text:badge";
        }
        if (node.closest("th, .mantine-Table-th")) {
          return "text:table-heading";
        }
        if (node.closest(".admin-ui-table-td--mono")) {
          return "text:table-mono";
        }
        if (node.closest(".admin-audit-event-label")) {
          return "text:table-strong";
        }
        if (node.closest(".admin-audit-row-diff-label")) {
          return "text:table-meta";
        }
        if (node.closest(".admin-audit-row-summary-value")) {
          return "text:table-value";
        }
        if (
          node.closest(
            ".admin-ui-meta, .admin-ui-eyebrow, .admin-ui-meta-inline, .admin-settings-suffix, .admin-org-meta, .admin-org-eyebrow, .admin-org-summary-text, .admin-org-audit-hint, .admin-org-source-label, .admin-org-fact-label, .admin-org-fact-value, .admin-org-member-email, .admin-org-membership-meta, .admin-org-activity-meta, .admin-org-request-meta, .admin-org-file-size, .admin-org-workspace-id, .admin-org-workspace-owner, .admin-org-workspace-storage, .admin-org-workspace-quota-mode, .admin-card-meta, .admin-page-metric, .admin-page-hero-stat, .admin-role-section-kicker, .admin-role-shoulder-stat, .admin-doc-card-description, .admin-doc-list-subtitle, .admin-doc-list-meta, .admin-doc-muted-text, .admin-doc-empty-inline, .admin-dashboard-card-index, .admin-dashboard-card-link, .admin-dashboard-chart-axis, .admin-dashboard-updated-at, .admin-dashboard-signal-labels, .admin-dashboard-shared-link-workspace, .admin-dashboard-inline-metric-label, .admin-design-font-family-meta, .admin-design-font-family-meta-value, .admin-design-font-sidecar-value, .admin-typography-card-index, .admin-typography-definition-label",
          )
        ) {
          return "text:meta";
        }
        if (
          node.closest(
            "table, .mantine-Table-root, .admin-table, .admin-ui-table",
          )
        ) {
          return "text:table";
        }
        return "text:body";
      };
      const typographySignature = (node: Element) => {
        const style = getComputedStyle(node);
        return [
          `ff=${style.fontFamily}`,
          `fs=${style.fontSize}`,
          `fw=${style.fontWeight}`,
          `lh=${style.lineHeight}`,
          `fontStyle=${style.fontStyle}`,
          `ls=${style.letterSpacing}`,
          `tt=${style.textTransform}`,
        ].join("|");
      };
      const parseCssColor = (value: string) => {
        const rgb = value.match(
          /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i,
        );
        if (rgb) {
          return {
            r: Number(rgb[1]),
            g: Number(rgb[2]),
            b: Number(rgb[3]),
            a: rgb[4] === undefined ? 1 : Number(rgb[4]),
          };
        }
        const srgb = value.match(
          /^color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+))?\)$/i,
        );
        if (srgb) {
          return {
            r: Number(srgb[1]) * 255,
            g: Number(srgb[2]) * 255,
            b: Number(srgb[3]) * 255,
            a: srgb[4] === undefined ? 1 : Number(srgb[4]),
          };
        }
        return null;
      };
      const relativeLuminance = (color: {
        r: number;
        g: number;
        b: number;
      }) => {
        const linear = (channel: number) => {
          const value = channel / 255;
          return value <= 0.03928
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
        };
        return (
          0.2126 * linear(color.r) +
          0.7152 * linear(color.g) +
          0.0722 * linear(color.b)
        );
      };
      const contrastRatio = (
        foreground: { r: number; g: number; b: number },
        background: { r: number; g: number; b: number },
      ) => {
        const fg = relativeLuminance(foreground);
        const bg = relativeLuminance(background);
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      };
      const rootStyle = getComputedStyle(document.documentElement);
      const heading = Array.from(
        document.querySelectorAll(
          "h1, .org-h1, [data-myoxus-ui-role='settings-page-title']",
        ),
      ).find(visible);
      const scrollRoot = document.querySelector(
        '[data-myoxus-ui-role="admin-page-scroll"]',
      ) as HTMLElement | null;
      const mantineViewport = scrollRoot?.querySelector(
        ".mantine-ScrollArea-viewport",
      ) as HTMLElement | null;
      const scroll = mantineViewport ?? scrollRoot;
      const rails = Array.from(
        document.querySelectorAll(
          '[data-myoxus-ui-role="admin-page-scroll-rail"], [data-myoxus-ui-role="admin-page-subnav-rail"]',
        ),
      )
        .filter(visible)
        .map((rail) => rail.getBoundingClientRect());
      const primaryRail =
        (scrollRoot?.querySelector(
          '[data-myoxus-ui-role="admin-page-scroll-rail"]',
        ) as HTMLElement | null) ??
        (Array.from(
          document.querySelectorAll(
            '[data-myoxus-ui-role="admin-page-scroll-rail"]',
          ),
        ).find(visible) as HTMLElement | undefined) ??
        null;
      const railChildren = primaryRail
        ? Array.from(primaryRail.children).filter(visible)
        : [];
      const panelSelector =
        ".admin-role-surface-panel, [data-myoxus-ui-role='card'], [data-myoxus-ui-role='settings-panel'], .admin-ui-bordered-panel, .admin-ui-soft-list";
      const visiblePanels = Array.from(
        document.querySelectorAll<HTMLElement>(panelSelector),
      ).filter(visible);
      const stickyFixedChildCount = primaryRail
        ? Array.from(primaryRail.querySelectorAll<HTMLElement>("*")).filter(
            (node) => {
              const position = getComputedStyle(node).position;
              return position === "sticky" || position === "fixed";
            },
          ).length
        : 0;
      const tableWidthPx = Math.max(
        0,
        ...Array.from(
          document.querySelectorAll<HTMLElement>(
            "table, [role='table'], .admin-ui-table-scroll",
          ),
        )
          .filter(visible)
          .map(
            (node) => node.scrollWidth || node.getBoundingClientRect().width,
          ),
      );
      const activeTabLabel =
        document
          .querySelector<HTMLElement>(
            [
              '[data-myoxus-ui-role="tabs-trigger"][aria-selected="true"]',
              '[data-myoxus-ui-role="tabs-trigger"][data-active="true"]',
              '[role="tab"][aria-selected="true"]',
            ].join(","),
          )
          ?.textContent?.trim()
          .replace(/\s+/g, " ") ?? "";
      const bottomContent =
        (railChildren.at(-1) as HTMLElement | undefined) ?? primaryRail;
      const scrollStyle = scroll ? getComputedStyle(scroll) : null;
      const initialScrollTop = scroll?.scrollTop ?? 0;
      const scrollable = scroll
        ? scroll.scrollHeight > scroll.clientHeight + 2
        : false;
      let bottomScrollTop = initialScrollTop;
      let bottomReached = !scrollable;
      let bottomContentVisible = !scrollable;
      let bottomContentLabel = "";
      if (scroll) {
        scroll.scrollTop = Math.max(0, scroll.scrollHeight);
        await nextFrame();
        await nextFrame();
        bottomScrollTop = scroll.scrollTop;
        bottomReached =
          !scrollable ||
          bottomScrollTop >= scroll.scrollHeight - scroll.clientHeight - 8;
        const viewportRect = scroll.getBoundingClientRect();
        const bottomRect = bottomContent?.getBoundingClientRect();
        bottomContentVisible =
          !bottomRect ||
          (bottomRect.bottom <= viewportRect.bottom + 8 &&
            bottomRect.bottom >= viewportRect.top - 8 &&
            bottomRect.top <= viewportRect.bottom - 8);
        bottomContentLabel =
          bottomContent?.textContent
            ?.trim()
            .replace(/\s+/g, " ")
            .slice(0, 120) ?? "";
      }
      const headingStyle = heading ? getComputedStyle(heading) : null;
      const buttons = Array.from(
        document.querySelectorAll("button, [role='button']"),
      ).filter(visible);
      const roleCounts = Array.from(
        document.querySelectorAll("[data-myoxus-ui-role]"),
      ).reduce<Record<string, number>>((acc, node) => {
        const role = node.dataset.myoxusUiRole ?? "unknown";
        acc[role] = (acc[role] ?? 0) + 1;
        return acc;
      }, {});
      const suspiciousDefaultButtons = buttons
        // Design and typography authoring pages intentionally render theme/font
        // previews with local colors and type styles. Those demo surfaces are
        // validated by their own preview tests, while this sweep guards the
        // surrounding Admin chrome and real controls.
        .filter((button) => !isInsideAuthoringPreview(button))
        .filter((button) => {
          const style = getComputedStyle(button);
          const className = String(button.getAttribute("class") ?? "");
          const facadeRole = button.dataset.myoxusUiRole ?? "";
          const looksSemantic =
            facadeRole.startsWith("button:") ||
            facadeRole === "tabs-trigger" ||
            className.includes("admin-") ||
            className.includes("mantine-") ||
            className.includes("admin-role-");
          const defaultBorder =
            style.borderStyle === "outset" || style.borderStyle === "inset";
          const defaultFace = [
            "buttonface",
            "rgb(239, 239, 239)",
            "rgb(240, 240, 240)",
          ].includes(style.backgroundColor.toLowerCase());
          return !looksSemantic || (defaultBorder && defaultFace);
        })
        .slice(0, 12)
        .map((button) => {
          const label =
            button.getAttribute("aria-label") ??
            button.textContent?.trim().replace(/\s+/g, " ") ??
            button.tagName.toLowerCase();
          return `${button.tagName.toLowerCase()}:${label}`;
        });
      const buttonRoleSignatureMaps: Record<
        string,
        Map<string, { count: number; examples: Set<string> }>
      > = {};
      const headingRoleSignatureMaps: Record<
        string,
        Map<string, { count: number; examples: Set<string> }>
      > = {};
      const typographyRoleSignatureMaps: Record<
        string,
        Map<string, { count: number; examples: Set<string> }>
      > = {};
      const typographySignatures = new Set<string>();
      const chromeTypographySignatures = new Set<string>();
      buttons
        .filter((button) => !isInsideAuthoringPreview(button))
        .forEach((button) => {
          addSignature(
            buttonRoleSignatureMaps,
            buttonSemanticRole(button),
            buttonSignature(button),
            textOf(button),
          );
        });
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "h1, h2, h3, h4, h5, .org-h1, [data-myoxus-ui-role='settings-page-title']",
        ),
      )
        .filter(visible)
        .filter((headingNode) => !isInsideAuthoringPreview(headingNode))
        .forEach((headingNode) => {
          addSignature(
            headingRoleSignatureMaps,
            headingRole(headingNode),
            headingSignature(headingNode),
            textOf(headingNode),
          );
        });
      const textWalker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const text = node.textContent?.trim().replace(/\s+/g, " ") ?? "";
            if (text.length === 0) return NodeFilter.FILTER_REJECT;
            const element = node.parentElement;
            if (!element) return NodeFilter.FILTER_REJECT;
            if (!visible(element)) return NodeFilter.FILTER_REJECT;
            if (element.closest("[aria-hidden='true'], script, style")) {
              return NodeFilter.FILTER_REJECT;
            }
            if (
              element.closest(
                ".admin-brand-logo, .admin-user-avatar, .admin-user-avatar--small",
              )
            ) {
              return NodeFilter.FILTER_REJECT;
            }
            if (element.closest(".admin-sidebar-brand")) {
              return NodeFilter.FILTER_REJECT;
            }
            if (isInsideAuthoringPreview(element)) {
              return NodeFilter.FILTER_REJECT;
            }
            if (element.closest("input, textarea, select")) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        },
      );
      for (
        let textNode = textWalker.nextNode();
        textNode;
        textNode = textWalker.nextNode()
      ) {
        const element = textNode.parentElement;
        if (!element) continue;
        const role = typographyRole(element);
        const signature = typographySignature(element);
        const example = (textNode.textContent ?? "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80);
        addSignature(typographyRoleSignatureMaps, role, signature, example);
        typographySignatures.add(signature);
        if (role.startsWith("chrome:")) {
          chromeTypographySignatures.add(signature);
        }
      }
      const buttonRoleSignatures = serializeSignatures(buttonRoleSignatureMaps);
      const headingRoleSignatures = serializeSignatures(
        headingRoleSignatureMaps,
      );
      const typographyRoleSignatures = serializeSignatures(
        typographyRoleSignatureMaps,
      );
      const styleBudgetFindings: string[] = [];
      const buttonTextSignatures = new Set<string>();
      const buttonIconSignatures = new Set<string>();
      Object.entries(buttonRoleSignatures).forEach(([role, signatures]) => {
        if (role === "button:unknown") {
          styleBudgetFindings.push(
            `unknown button role: ${signatures
              .flatMap((entry) => entry.examples)
              .join(", ")}`,
          );
        }
        const maxRoleSignatures =
          role === "tabs-trigger" || role.includes(":icon") ? 2 : 3;
        if (signatures.length > maxRoleSignatures) {
          styleBudgetFindings.push(
            `${role} has ${signatures.length} visual signatures`,
          );
        }
        signatures.forEach((entry) => {
          if (role.includes(":icon")) {
            buttonIconSignatures.add(entry.signature);
          } else {
            buttonTextSignatures.add(entry.signature);
          }
        });
      });
      Object.entries(headingRoleSignatures).forEach(([role, signatures]) => {
        const maxHeadingSignatures = role === "heading:page" ? 1 : 3;
        if (signatures.length > maxHeadingSignatures) {
          styleBudgetFindings.push(
            `${role} has ${signatures.length} typography signatures`,
          );
        }
      });
      if (buttonTextSignatures.size > 7) {
        styleBudgetFindings.push(
          `text buttons use ${buttonTextSignatures.size} geometry/typography signatures`,
        );
      }
      if (buttonIconSignatures.size > 4) {
        styleBudgetFindings.push(
          `icon buttons use ${buttonIconSignatures.size} geometry/typography signatures`,
        );
      }
      Object.entries(typographyRoleSignatures).forEach(([role, signatures]) => {
        const maxTypographyRoleSignatures =
          role === "text:body" || role === "text:meta"
            ? 4
            : role === "text:metric"
              ? 2
              : role === "text:status"
                ? 2
                : role === "text:description"
                  ? 4
                  : role === "text:option"
                    ? 3
                    : role.startsWith("text:table-")
                      ? 2
                      : role === "text:table"
                        ? 4
                        : role.startsWith("button:card") ||
                            role === "button:surface-list-action"
                          ? 4
                          : role.startsWith("chrome:")
                            ? 6
                            : 2;
        if (signatures.length > maxTypographyRoleSignatures) {
          styleBudgetFindings.push(
            `${role} uses ${signatures.length} typography signatures`,
          );
        }
      });
      if (chromeTypographySignatures.size > 6) {
        styleBudgetFindings.push(
          `admin chrome uses ${chromeTypographySignatures.size} typography signatures`,
        );
      }
      const formControls = Array.from(
        new Set(
          Array.from(
            document.querySelectorAll(
              [
                "input:not([type='checkbox']):not([type='radio']):not([type='color']):not([type='file'])",
                "textarea",
                "select",
                ".mantine-Input-input",
              ].join(","),
            ),
          ),
        ),
      ).filter(visible);
      const lowContrastControls = formControls
        .filter((control) => !isInsideAuthoringPreview(control))
        .filter((control) => {
          if (
            control.hasAttribute("disabled") ||
            control.getAttribute("aria-disabled") === "true"
          ) {
            return false;
          }
          const style = getComputedStyle(control);
          const foreground = parseCssColor(style.color);
          const background = parseCssColor(style.backgroundColor);
          if (!foreground || !background || background.a < 0.6) {
            return false;
          }
          return contrastRatio(foreground, background) < 4.5;
        })
        .slice(0, 12)
        .map((control) => {
          const style = getComputedStyle(control);
          const label =
            control.getAttribute("aria-label") ??
            control.getAttribute("placeholder") ??
            control.textContent?.trim().replace(/\s+/g, " ") ??
            control.tagName.toLowerCase();
          return [
            control.tagName.toLowerCase(),
            label,
            `fg=${style.color}`,
            `bg=${style.backgroundColor}`,
          ].join(":");
        });

      return {
        routeId,
        themeMode,
        anchorVisible: Boolean(document.querySelector(anchorSelector)),
        url: window.location.href,
        tabLabel: activeTabLabel,
        horizontalOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        heading: headingStyle
          ? {
              fontFamily: headingStyle.fontFamily,
              fontSize: headingStyle.fontSize,
              fontWeight: headingStyle.fontWeight,
              color: headingStyle.color,
            }
          : null,
        panelCount: document.querySelectorAll(
          ".admin-role-surface-panel, [data-myoxus-ui-role='card'], [data-myoxus-ui-role='settings-panel'], .admin-ui-bordered-panel, .admin-ui-soft-list",
        ).length,
        buttonCount: buttons.length,
        chromeCount: Array.from(
          document.querySelectorAll(".admin-page-chrome"),
        ).filter(visible).length,
        roleCounts,
        suspiciousDefaultButtons,
        lowContrastControls,
        styleBudget: {
          buttonTextSignatureCount: buttonTextSignatures.size,
          buttonIconSignatureCount: buttonIconSignatures.size,
          typographySignatureCount: typographySignatures.size,
          chromeTypographySignatureCount: chromeTypographySignatures.size,
          buttonRoleSignatures,
          headingRoleSignatures,
          typographyRoleSignatures,
          findings: styleBudgetFindings,
        },
        scrollContainer: {
          exists: Boolean(scrollRoot),
          innerViewportNode: mantineViewport
            ? ".mantine-ScrollArea-viewport"
            : scroll
              ? scroll.tagName.toLowerCase()
              : "missing",
          clientHeight: scroll?.clientHeight ?? 0,
          viewportHeight: window.innerHeight,
          scrollHeight: scroll?.scrollHeight ?? 0,
          scrollable,
          initialScrollTop,
          bottomScrollTop,
          bottomReached,
          bottomContentVisible,
          bottomContentLabel,
          overflowY: scrollStyle?.overflowY ?? "",
        },
        railWidth:
          rails.length > 0 ? Math.min(...rails.map((rail) => rail.width)) : 0,
        railLeft:
          rails.length > 0 ? Math.min(...rails.map((rail) => rail.left)) : 0,
        railRight:
          rails.length > 0 ? Math.max(...rails.map((rail) => rail.right)) : 0,
        stickyFixedChildCount,
        tableWidthPx,
        firstVisiblePanel:
          visiblePanels[0]?.textContent
            ?.trim()
            .replace(/\s+/g, " ")
            .slice(0, 120) ?? "",
        lastVisiblePanel:
          visiblePanels
            .at(-1)
            ?.textContent?.trim()
            .replace(/\s+/g, " ")
            .slice(0, 120) ?? "",
        cssVariables: {
          displayFont: rootStyle.getPropertyValue(
            "--myoxus-typography-h1-family",
          ),
          bodyFont:
            rootStyle.getPropertyValue("--myoxus-typography-body-family") ||
            rootStyle.getPropertyValue("--myoxus-font-family"),
          text:
            rootStyle.getPropertyValue("--myoxus-text-primary-color") ||
            rootStyle.getPropertyValue("--foreground"),
          shellBg:
            rootStyle.getPropertyValue("--admin-shell-bg") ||
            rootStyle.getPropertyValue("--myoxus-background-primary-color") ||
            rootStyle.getPropertyValue("--background"),
        },
      } satisfies RouteVisualSnapshot;
    },
    {
      routeId: route.id,
      anchorSelector: routeAnchorSelector(route),
      themeMode,
    },
  );
}

async function captureRouteEvidence(
  page: Page,
  testInfo: TestInfo,
  route: MatrixRoute,
  themeMode: ThemeMode,
  snapshot: RouteEvidenceSnapshot | null,
  phase: EvidencePhase,
  viewportVariant?: "narrow",
): Promise<RouteEvidenceRecord> {
  const routeId = snapshot?.routeId ?? route.id;
  const viewport: EvidenceViewport = viewportVariant ?? "desktop";
  const viewportSegment = viewportVariant ? `${viewportVariant}-` : "";
  const slug = `${themeMode}-${viewportSegment}${contactSheetName(routeId)}-${phase}`;
  const screenshotPath = testInfo.outputPath(`${slug}.png`);
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    path: screenshotPath,
  });

  mkdirSync(QA_DIR, { recursive: true });
  const qaScreenshotPath = path.join(QA_DIR, `${slug}.png`);
  const qaMetadataPath = path.join(QA_DIR, `${slug}.json`);
  const reviewedAt = new Date().toISOString();
  const record: RouteEvidenceRecord = {
    routeId,
    themeMode,
    phase,
    viewport,
    screenshot: qaScreenshotPath,
    metadata: qaMetadataPath,
    reviewedAt,
    fixedByCommit: REVIEW_COMMIT,
  };
  copyFileSync(screenshotPath, qaScreenshotPath);
  writeFileSync(
    qaMetadataPath,
    JSON.stringify(
      {
        route,
        snapshot,
        screenshot: qaScreenshotPath,
        metadata: qaMetadataPath,
        viewportVariant: viewport,
        reviewedAt,
        fixedByCommit: REVIEW_COMMIT,
      },
      null,
      2,
    ),
  );
  const key = routeEvidenceKey(routeId, themeMode, viewport);
  capturedRouteEvidence.set(key, [
    ...(capturedRouteEvidence.get(key) ?? []).filter(
      (existing) => existing.phase !== phase,
    ),
    record,
  ]);
  return record;
}

function writeScrollInventory(
  scope: string,
  snapshots: readonly RouteVisualSnapshot[],
  runtimeErrors: readonly AdminRuntimeError[] = [],
) {
  mkdirSync(QA_DIR, { recursive: true });
  const inventoryPath = path.join(QA_DIR, "scroll-layout-inventory.json");
  const existing = existsSync(inventoryPath)
    ? (JSON.parse(readFileSync(inventoryPath, "utf8")) as Record<
        string,
        unknown
      >)
    : {};
  const viewport: EvidenceViewport = scope.includes("narrow")
    ? "narrow"
    : "desktop";
  const consoleErrors = runtimeErrors.map(
    (error) =>
      `[${error.source}]${error.url ? ` ${error.url}` : ""} ${error.message}`,
  );
  existing[scope] = {
    reviewedAt: new Date().toISOString(),
    fixedByCommit: REVIEW_COMMIT,
    routeCount: snapshots.length,
    routes: snapshots.map((snapshot) => ({
      sourceFiles: (() => {
        const baseRouteId = snapshot.routeId.split(":")[0] ?? snapshot.routeId;
        const route = routeById.get(baseRouteId);
        return route
          ? [`client/admin/workspaces/admin/src/modules/${route.module}/**`]
          : [];
      })(),
      tabsChecked: (() => {
        const [baseRouteId, tabSlug] = snapshot.routeId.split(":");
        const route = routeById.get(baseRouteId ?? snapshot.routeId);
        return tabSlug ? [tabSlug] : (route?.tabs ?? []);
      })(),
      drawersChecked: [],
      drawersExpected: (() => {
        const baseRouteId = snapshot.routeId.split(":")[0] ?? snapshot.routeId;
        return routeById.get(baseRouteId)?.drawers ?? [];
      })(),
      ...(() => {
        const screenshots =
          capturedRouteEvidence.get(
            routeEvidenceKey(snapshot.routeId, snapshot.themeMode, viewport),
          ) ?? [];
        const screenshotPhases = new Set(
          screenshots.map((evidence) => evidence.phase),
        );
        const minRailWidth = viewport === "narrow" ? 300 : 900;
        const findings = [
          screenshots.length === 0 ? "missing screenshot evidence" : undefined,
          !screenshotPhases.has("initial")
            ? "missing initial screenshot"
            : undefined,
          !screenshotPhases.has("bottom")
            ? "missing bottom screenshot"
            : undefined,
          !snapshot.scrollContainer.exists
            ? "missing shared admin-page-scroll root"
            : undefined,
          snapshot.scrollContainer.clientHeight >
          snapshot.scrollContainer.viewportHeight + 8
            ? "page scroll viewport exceeds browser viewport"
            : undefined,
          snapshot.scrollContainer.overflowY === "hidden"
            ? "page scroll viewport hides vertical overflow"
            : undefined,
          !snapshot.scrollContainer.bottomReached
            ? "bottom sentinel was not reached"
            : undefined,
          !snapshot.scrollContainer.bottomContentVisible
            ? "bottom content was not visible after scroll"
            : undefined,
          snapshot.horizontalOverflow > 1
            ? `horizontal overflow ${snapshot.horizontalOverflow}px`
            : undefined,
          snapshot.railWidth < minRailWidth
            ? `content rail width ${snapshot.railWidth}px below ${minRailWidth}px budget`
            : undefined,
          snapshot.suspiciousDefaultButtons.length > 0
            ? `unstyled/default buttons: ${snapshot.suspiciousDefaultButtons.join(
                ", ",
              )}`
            : undefined,
          snapshot.lowContrastControls.length > 0
            ? `low contrast controls: ${snapshot.lowContrastControls.join(
                ", ",
              )}`
            : undefined,
          ...snapshot.styleBudget.findings,
          ...consoleErrors.map((error) => `console/runtime error: ${error}`),
        ].filter((finding): finding is string => Boolean(finding));
        return {
          status: findings.length === 0 ? "passed" : "finding",
          consoleErrors,
          screenshots,
          findings,
          fixedByCommit: REVIEW_COMMIT,
        };
      })(),
      viewport,
      routeId: snapshot.routeId,
      url: snapshot.url,
      tabLabel: snapshot.tabLabel,
      scrollRoot: snapshot.scrollContainer.exists
        ? "admin-page-scroll"
        : "missing",
      innerViewportNode: snapshot.scrollContainer.innerViewportNode,
      bottomReached: snapshot.scrollContainer.bottomReached,
      bottomContentVisible: snapshot.scrollContainer.bottomContentVisible,
      bottomContentLabel: snapshot.scrollContainer.bottomContentLabel,
      clientHeight: snapshot.scrollContainer.clientHeight,
      viewportHeight: snapshot.scrollContainer.viewportHeight,
      scrollHeight: snapshot.scrollContainer.scrollHeight,
      bottomScrollTop: snapshot.scrollContainer.bottomScrollTop,
      railWidthPx: snapshot.railWidth,
      railLeftPx: snapshot.railLeft,
      railRightPx: snapshot.railRight,
      tableWidthPx: snapshot.tableWidthPx,
      stickyFixedChildCount: snapshot.stickyFixedChildCount,
      firstVisiblePanel: snapshot.firstVisiblePanel,
      lastVisiblePanel: snapshot.lastVisiblePanel,
      horizontalOverflowPx: snapshot.horizontalOverflow,
      suspiciousDefaultButtons: snapshot.suspiciousDefaultButtons,
      styleBudget: snapshot.styleBudget,
    })),
  };
  writeFileSync(inventoryPath, `${JSON.stringify(existing, null, 2)}\n`);
  writeWidthBudget(scope, snapshots);
}

function writeWidthBudget(
  scope: string,
  snapshots: readonly RouteVisualSnapshot[],
) {
  if (scope.includes("narrow")) return;
  mkdirSync(QA_DIR, { recursive: true });
  const budgetPath = path.join(QA_DIR, "width-budget.json");
  const existing = existsSync(budgetPath)
    ? (JSON.parse(readFileSync(budgetPath, "utf8")) as Record<string, unknown>)
    : {};
  const byBaseRoute = new Map<string, RouteVisualSnapshot[]>();
  snapshots.forEach((snapshot) => {
    const baseRouteId = snapshot.routeId.split(":")[0] ?? snapshot.routeId;
    byBaseRoute.set(baseRouteId, [
      ...(byBaseRoute.get(baseRouteId) ?? []),
      snapshot,
    ]);
  });
  existing[scope] = {
    reviewedAt: new Date().toISOString(),
    fixedByCommit: REVIEW_COMMIT,
    clusters: Array.from(byBaseRoute.entries()).map(([routeId, entries]) => {
      const budget = WIDTH_BUDGET_BY_ROUTE[routeId] ?? {
        expectedRail: "data",
        reason:
          "default Admin data rail until a narrower route budget is documented",
      };
      const railWidths = entries.map((entry) => entry.railWidth);
      const minRailWidth = Math.min(...railWidths);
      const maxRailWidth = Math.max(...railWidths);
      const variancePx = Math.round(maxRailWidth - minRailWidth);
      const findings = [
        variancePx > 24
          ? `rail width varies by ${variancePx}px inside ${routeId}`
          : undefined,
        ...entries.flatMap((entry) =>
          entry.horizontalOverflow > 1
            ? [
                `${entry.routeId} creates ${entry.horizontalOverflow}px horizontal overflow`,
              ]
            : [],
        ),
      ].filter((finding): finding is string => Boolean(finding));
      return {
        routeId,
        expectedRail: budget.expectedRail,
        reason: budget.reason,
        sourceFiles: routeById.get(routeId)
          ? [
              `client/admin/workspaces/admin/src/modules/${
                routeById.get(routeId)?.module
              }/**`,
            ]
          : [],
        measurements: entries.map((entry) => ({
          routeId: entry.routeId,
          url: entry.url,
          tabLabel: entry.tabLabel,
          railWidthPx: entry.railWidth,
          railLeftPx: entry.railLeft,
          railRightPx: entry.railRight,
          tableWidthPx: entry.tableWidthPx,
          horizontalOverflowPx: entry.horizontalOverflow,
        })),
        variancePx,
        findings,
        status: findings.length === 0 ? "passed" : "finding",
      };
    }),
  };
  writeFileSync(budgetPath, `${JSON.stringify(existing, null, 2)}\n`);
}

async function visibleTopLevelTabs(page: Page) {
  return page.locator('[data-testid="admin-page-subnav"] [role="tab"]');
}

async function assertTopLevelTabsMatchMatrix(page: Page, route: MatrixRoute) {
  const tabs = await visibleTopLevelTabs(page);
  await expect(
    tabs,
    `${route.id} route matrix tabs must match the rendered top-level AdminSubnav tabs`,
  ).toHaveCount(route.tabs.length);
  await expect(
    page.locator(
      '[data-testid="admin-page-subnav"] [role="tab"] svg, [data-testid="admin-page-subnav"] [role="tab"] .admin-ui-icon-leading-sm, [data-testid="admin-page-subnav"] [role="tab"] .admin-ui-icon-md.admin-ui-icon-stroke-display',
    ),
    `${route.id} top-level AdminSubnav must stay text-only; icons belong to content/preview surfaces`,
  ).toHaveCount(0);
}

function assertRouteSnapshot(snapshot: RouteVisualSnapshot) {
  expect(
    snapshot.anchorVisible,
    `${snapshot.routeId} matrix anchor must be visible`,
  ).toBe(true);
  expect(
    snapshot.horizontalOverflow,
    `${snapshot.routeId} must not create horizontal overflow`,
  ).toBeLessThanOrEqual(1);
  expect(
    snapshot.heading,
    `${snapshot.routeId} must expose a visible semantic page heading`,
  ).toBeTruthy();
  expect(
    snapshot.heading?.fontFamily.trim(),
    `${snapshot.routeId} heading must have runtime typography`,
  ).not.toBe("");
  expect(
    snapshot.heading?.color,
    `${snapshot.routeId} heading must not fall back to browser black`,
  ).not.toBe("rgb(0, 0, 0)");
  expect(
    snapshot.panelCount,
    `${snapshot.routeId} must render at least one shared panel/card/list surface`,
  ).toBeGreaterThan(0);
  expect(
    snapshot.buttonCount,
    `${snapshot.routeId} must expose interactive controls through styled buttons`,
  ).toBeGreaterThan(0);
  expect(
    snapshot.chromeCount,
    `${snapshot.routeId} must not render the removed action-only top chrome`,
  ).toBe(0);
  expect(
    snapshot.scrollContainer.exists,
    `${snapshot.routeId} must use the shared Mantine-backed page scroll area`,
  ).toBe(true);
  expect(
    snapshot.scrollContainer.clientHeight,
    `${snapshot.routeId} page scroll area must have a real viewport height`,
  ).toBeGreaterThan(0);
  expect(
    snapshot.scrollContainer.clientHeight,
    `${snapshot.routeId} page scroll area must be bounded by the browser viewport`,
  ).toBeLessThanOrEqual(snapshot.scrollContainer.viewportHeight + 8);
  expect(
    snapshot.scrollContainer.overflowY,
    `${snapshot.routeId} page scroll area must not hide vertical overflow`,
  ).not.toBe("hidden");
  expect(
    snapshot.railWidth,
    `${snapshot.routeId} content rail should use the full shared shell width`,
  ).toBeGreaterThanOrEqual(900);
  if (snapshot.scrollContainer.scrollable) {
    expect(
      snapshot.scrollContainer.bottomScrollTop,
      `${snapshot.routeId} page scroll area advertises overflow but never moves from the top`,
    ).toBeGreaterThan(0);
  }
  expect(
    snapshot.scrollContainer.bottomReached,
    `${snapshot.routeId} must allow users to scroll the shared page viewport to the bottom`,
  ).toBe(true);
  expect(
    snapshot.scrollContainer.bottomContentVisible,
    `${snapshot.routeId} bottom content must be visible after scrolling to the end; last content: ${snapshot.scrollContainer.bottomContentLabel}`,
  ).toBe(true);
  expect(
    snapshot.suspiciousDefaultButtons,
    `${snapshot.routeId} has buttons that look unstyled or bypass the facade`,
  ).toEqual([]);
  expect(
    snapshot.lowContrastControls,
    `${snapshot.routeId} has form controls whose text/background contrast is below WCAG AA`,
  ).toEqual([]);
  expect(
    snapshot.styleBudget.findings,
    `${snapshot.routeId} violates the Admin visual role budget. Signatures: ${JSON.stringify(
      snapshot.styleBudget,
    )}`,
  ).toEqual([]);
  expect(
    cssString(snapshot.cssVariables.displayFont),
    `${snapshot.routeId} missing display font variable`,
  ).not.toBe("");
  expect(
    cssString(snapshot.cssVariables.bodyFont),
    `${snapshot.routeId} missing body font variable`,
  ).not.toBe("");
  expect(
    cssString(snapshot.cssVariables.text),
    `${snapshot.routeId} missing text color variable`,
  ).not.toBe("");
  expect(
    cssString(snapshot.cssVariables.shellBg),
    `${snapshot.routeId} missing shell background variable`,
  ).not.toBe("");
}

function assertInitialRouteSnapshot(
  snapshot: InitialRouteVisualSnapshot,
  route: MatrixRoute,
  options: { requireVisibleSidebarRail?: boolean } = {},
) {
  const requireVisibleSidebarRail = options.requireVisibleSidebarRail ?? true;
  expect(
    snapshot.anchorVisible,
    `${snapshot.routeId} matrix anchor must be visible before initial visual capture`,
  ).toBe(true);
  expect(
    snapshot.headingText.trim(),
    `${snapshot.routeId} must expose heading text before initial visual capture`,
  ).not.toBe("");
  if (requireVisibleSidebarRail) {
    expect(
      snapshot.sidebarActiveNavigation.count,
      `${snapshot.routeId} must mark exactly one active sidebar navigation item; active=${JSON.stringify(
        snapshot.sidebarActiveNavigation.candidates,
      )}`,
    ).toBe(1);
    expect(
      snapshot.sidebarActiveNavigation.exists,
      `${snapshot.routeId} must expose an active sidebar navigation item`,
    ).toBe(true);
    expect(
      snapshot.sidebarActiveNavigation.label,
      `${snapshot.routeId} active sidebar item must expose a readable label`,
    ).not.toBe("");
    expect(
      snapshot.sidebarActiveNavigation.matchesCurrentRoute,
      `${snapshot.routeId} active sidebar item must match the current route; active=${JSON.stringify(
        snapshot.sidebarActiveNavigation,
      )}`,
    ).toBe(true);
    expect(
      snapshot.sidebarActiveNavigation.visibleInRail,
      `${snapshot.routeId} active sidebar item must be visible in the sidebar rail; active=${JSON.stringify(
        snapshot.sidebarActiveNavigation,
      )}`,
    ).toBe(true);
  }
  if (route.tabs.length > 0) {
    expect(
      snapshot.topLevelSubnav.exists,
      `${snapshot.routeId} must render the shared page-owned tab strip`,
    ).toBe(true);
    expect(
      snapshot.topLevelSubnav.tabCount,
      `${snapshot.routeId} shared tab strip must render every matrix tab`,
    ).toBe(route.tabs.length);
    expect(
      snapshot.topLevelSubnav.surfaceBorderBottomWidth,
      `${snapshot.routeId} tab strip must not fall back to detached full-width underline chrome`,
    ).toBe("0px");
    expect(
      snapshot.topLevelSubnav.tabsListWithinSurface,
      `${snapshot.routeId} shared tab strip must be visually contained by the page-owned subnav surface; subnav=${JSON.stringify(
        snapshot.topLevelSubnav,
      )}`,
    ).toBe(true);
    if (snapshot.topLevelSubnav.railWidth > 0) {
      expect(
        snapshot.topLevelSubnav.tabsListWidth /
          snapshot.topLevelSubnav.railWidth,
        `${snapshot.routeId} tab strip must use the shared content rail instead of a detached content-width pill; subnav=${JSON.stringify(
          snapshot.topLevelSubnav,
        )}`,
      ).toBeGreaterThanOrEqual(0.9);
    }
    expect(
      snapshot.topLevelSubnav.overlapsMobileTrigger,
      `${snapshot.routeId} shared tab strip must not collide with the fixed mobile sidebar trigger; subnav=${JSON.stringify(
        snapshot.topLevelSubnav,
      )}`,
    ).toBe(false);
    if (snapshot.topLevelSubnav.mobileTriggerExists) {
      expect(
        snapshot.topLevelSubnav.tabsListTop,
        `${snapshot.routeId} narrow tab strip must start below the fixed mobile sidebar trigger, not beside or under it; subnav=${JSON.stringify(
          snapshot.topLevelSubnav,
        )}`,
      ).toBeGreaterThanOrEqual(snapshot.topLevelSubnav.mobileTriggerBottom + 4);
      expect(
        snapshot.topLevelSubnav.tabsListHeight,
        `${snapshot.routeId} narrow tab strip must stay a single horizontally scrollable row instead of wrapping into a tall mobile chrome block; subnav=${JSON.stringify(
          snapshot.topLevelSubnav,
        )}`,
      ).toBeLessThanOrEqual(48);
      if (
        snapshot.topLevelSubnav.tabsListScrollWidth >
        snapshot.topLevelSubnav.tabsListClientWidth + 4
      ) {
        expect(
          snapshot.topLevelSubnav.tabsListMaskImage,
          `${snapshot.routeId} overflowing narrow tab strip must expose a soft scroll affordance instead of a hard clipped word edge; subnav=${JSON.stringify(
            snapshot.topLevelSubnav,
          )}`,
        ).not.toBe("none");
        expect(
          snapshot.topLevelSubnav.tabsListScrollbarWidth,
          `${snapshot.routeId} overflowing narrow tab strip must keep the scroll affordance in the tab surface, not as a second outer scrollbar; subnav=${JSON.stringify(
            snapshot.topLevelSubnav,
          )}`,
        ).toBe("none");
      }
    }
  }
  if (snapshot.mobileTrigger.exists) {
    expect(
      snapshot.mobileTrigger.overlapsFirstContent,
      `${snapshot.routeId} mobile drawer trigger must not overlap the first content card; mobile=${JSON.stringify(
        snapshot.mobileTrigger,
      )}`,
    ).toBe(false);
    expect(
      snapshot.mobileTrigger.firstContentTop,
      `${snapshot.routeId} first content card must reserve the mobile drawer trigger row; mobile=${JSON.stringify(
        snapshot.mobileTrigger,
      )}`,
    ).toBeGreaterThan(snapshot.mobileTrigger.bottom + 4);
  }
  expect(
    snapshot.loneIconShoulders,
    `${snapshot.routeId} must not render decorative icons as isolated right-aligned SectionHeader shoulders`,
  ).toEqual([]);
  expect(
    snapshot.svgOnlyHeaderActions,
    `${snapshot.routeId} must not render SVG-only section header actions that look like loose controls`,
  ).toEqual([]);
  expect(
    snapshot.directHeaderIcons,
    `${snapshot.routeId} must not render direct SVG-only section header children that look like loose controls`,
  ).toEqual([]);
  expect(
    snapshot.truncatedSelectLabels,
    `${snapshot.routeId} must not truncate visible select labels in the initial viewport`,
  ).toEqual([]);
  expect(
    snapshot.tabHeadingNumberConflicts,
    `${snapshot.routeId} must not number the active tab title as a content section`,
  ).toEqual([]);
  expect(
    snapshot.scrollContainer.exists,
    `${snapshot.routeId} must expose the shared page scroll before initial visual capture`,
  ).toBe(true);
  expect(
    snapshot.scrollContainer.clientHeight,
    `${snapshot.routeId} initial scroll viewport must have real height`,
  ).toBeGreaterThan(0);
  expect(
    snapshot.scrollContainer.clientHeight,
    `${snapshot.routeId} initial scroll viewport must be bounded by the browser viewport`,
  ).toBeLessThanOrEqual(snapshot.scrollContainer.viewportHeight + 8);
  expect(
    snapshot.scrollContainer.overflowY,
    `${snapshot.routeId} initial scroll viewport must not hide vertical overflow`,
  ).not.toBe("hidden");
  expect(
    snapshot.scrollContainer.initialScrollTop,
    `${snapshot.routeId} initial screenshot must be captured at the top of the shared scroll viewport`,
  ).toBeLessThanOrEqual(2);
  expect(
    snapshot.aboveFold.visibleRailChildren,
    `${snapshot.routeId} initial viewport is visually blank; sample: ${snapshot.aboveFold.textSample}`,
  ).toBeGreaterThan(0);
  expect(
    snapshot.aboveFold.visibleTextLength,
    `${snapshot.routeId} initial viewport must contain meaningful text, not just shell chrome`,
  ).toBeGreaterThanOrEqual(24);
  expect(
    snapshot.aboveFold.loadingTextCount,
    `${snapshot.routeId} initial screenshot was captured while loading text was still visible`,
  ).toBe(0);
  expect(
    snapshot.aboveFold.skeletonCount,
    `${snapshot.routeId} initial screenshot was captured while skeleton placeholders were still visible`,
  ).toBe(0);
  if (snapshot.aboveFold.firstContentGap !== null) {
    expect(
      snapshot.aboveFold.firstContentGap,
      `${snapshot.routeId} first visible content starts too far below the viewport top`,
    ).toBeLessThanOrEqual(80);
  }
  if (snapshot.aboveFold.heroTrailingWhitespace !== null) {
    expect(
      snapshot.aboveFold.heroTrailingWhitespace,
      `${snapshot.routeId} page hero reserves too much dead space below its standalone header`,
    ).toBeLessThanOrEqual(40);
  }
  if (snapshot.routeId === "workspaces") {
    expect(
      snapshot.aboveFold.textSample,
      "workspaces initial viewport must not expose full UUIDs as primary list content",
    ).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  }
  if (snapshot.routeId === "audit-log") {
    expect(
      snapshot.auditLog.rawPrimaryEventLabels,
      "audit-log primary table must show localized/user-readable event labels; raw event keys belong only in the detail drawer",
    ).toEqual([]);
    expect(
      snapshot.auditLog.wrappedCategoryBadges,
      "audit-log category badges must stay single-line and readable; wrapping inside category names is a visible table regression",
    ).toEqual([]);
  }
}

async function runAuthenticatedRouteVisualCheck({
  adminRequest,
  page,
  route,
  testInfo,
  themeMode,
}: {
  adminRequest: APIRequestContext;
  page: Page;
  route: MatrixRoute;
  testInfo: TestInfo;
  themeMode: ThemeMode;
}) {
  const original = await readEffectiveThemeProfile(adminRequest);
  const runtimeCollector = installAdminRuntimeErrorCollector(page);
  const routeSnapshots: RouteVisualSnapshot[] = [];

  try {
    await setThemeProfile(adminRequest, {
      themeSlug: ADMIN_VISUAL_BASELINE_THEME_SLUG,
      themeMode,
    });

    await openAdminRoute(page, route);
    await assertTopLevelTabsMatchMatrix(page, route);
    await resetAdminPageScroll(page);
    await waitForAdminRouteAboveFoldContent(page, route);
    const initialSnapshot = await readInitialRouteVisualSnapshot(
      page,
      route,
      themeMode,
    );
    assertInitialRouteSnapshot(initialSnapshot, route);
    await captureRouteEvidence(
      page,
      testInfo,
      route,
      themeMode,
      initialSnapshot,
      "initial",
    );

    const snapshot = await readRouteVisualSnapshot(page, route, themeMode);
    routeSnapshots.push(snapshot);
    assertRouteSnapshot(snapshot);

    const axe = await new AxeBuilder({ page }).include("body").analyze();
    const critical = axe.violations.filter(
      (violation) => violation.impact === "critical",
    );
    expect(
      critical.flatMap((violation) =>
        violation.nodes.map(
          (node) =>
            `${route.id}:${violation.id}:${node.target.join(" > ")}:${node.failureSummary ?? "no failure summary"}`,
        ),
      ),
    ).toEqual([]);

    await captureRouteEvidence(
      page,
      testInfo,
      route,
      themeMode,
      snapshot,
      "bottom",
    );
    runtimeCollector.assertNoFatal();
  } finally {
    await setThemeProfile(adminRequest, {
      themeSlug: original.theme.slug,
      themeMode: original.themeMode,
    });
    mkdirSync(QA_DIR, { recursive: true });
    writeFileSync(
      path.join(
        QA_DIR,
        `summary-${themeMode}-${contactSheetName(route.id)}.json`,
      ),
      JSON.stringify(
        {
          themeMode,
          routeId: route.id,
          routeCount: routeSnapshots.length,
          routes: routeSnapshots,
          runtimeErrors: runtimeCollector.errors,
          runtimeErrorText: formatAdminRuntimeErrors(runtimeCollector.errors),
        },
        null,
        2,
      ),
    );
    writeScrollInventory(
      `authenticated-${themeMode}-${route.id}`,
      routeSnapshots,
      runtimeCollector.errors,
    );
  }
}

async function readDetailSurfaceSnapshot(
  page: Page,
  scenario: DetailSurfaceScenario,
): Promise<DetailSurfaceSnapshot> {
  return page.evaluate(
    async ({
      rootSelector,
      scrollSelector,
      routeId,
      surfaceId,
      expectedDrawer,
    }) => {
      const nextFrame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const { visible } = (
        window as typeof window & {
          __myoxusAdminVisualHelpers: {
            visible: (node: Element) => boolean;
          };
        }
      ).__myoxusAdminVisualHelpers;
      const rootCandidates = Array.from(
        document.querySelectorAll<HTMLElement>(rootSelector),
      );
      const root = rootCandidates.find(visible) ?? rootCandidates[0] ?? null;
      const explicitScrollCandidates = scrollSelector
        ? Array.from(document.querySelectorAll<HTMLElement>(scrollSelector))
        : [];
      const explicitScrollRoot =
        explicitScrollCandidates.find((candidate) =>
          Boolean(root && (candidate === root || root.contains(candidate))),
        ) ??
        explicitScrollCandidates.find(visible) ??
        null;
      const scrollRoot =
        explicitScrollRoot ??
        (root?.querySelector(
          [
            ".mantine-ScrollArea-viewport",
            ".admin-panel-content-scroll",
            ".admin-ui-right-panel-scroll",
            ".admin-workspace-panel-scroll",
            ".admin-template-drawer-body",
            ".admin-pdf-detail-body",
            ".admin-audit-detail-body",
          ].join(","),
        ) as HTMLElement | null) ??
        root;
      const rootVisible = Boolean(root && visible(root));
      const focusableSelector = [
        "button:not([disabled])",
        "a[href]",
        "input:not([disabled])",
        "select:not([disabled])",
        "textarea:not([disabled])",
        "[tabindex]:not([tabindex='-1'])",
      ].join(",");
      const focusable = root
        ? Array.from(
            root.querySelectorAll<HTMLElement>(focusableSelector),
          ).filter(visible)
        : [];
      const lastFocusable = focusable.at(-1) ?? null;
      const scrollable = scrollRoot
        ? scrollRoot.scrollHeight > scrollRoot.clientHeight + 2
        : false;
      if (scrollRoot) {
        scrollRoot.scrollTop = Math.max(0, scrollRoot.scrollHeight);
        await nextFrame();
        await nextFrame();
      }
      const viewportRect = scrollRoot?.getBoundingClientRect();
      const lastFocusableRect = lastFocusable?.getBoundingClientRect();
      const bottomReached =
        !scrollRoot ||
        !scrollable ||
        scrollRoot.scrollTop >=
          scrollRoot.scrollHeight - scrollRoot.clientHeight - 8;
      const lastFocusableVisible = Boolean(
        !lastFocusable ||
        !viewportRect ||
        (lastFocusableRect &&
          lastFocusableRect.bottom <= viewportRect.bottom + 8 &&
          lastFocusableRect.top >= viewportRect.top - 8),
      );
      const bottomCandidate =
        (scrollRoot
          ? (Array.from(scrollRoot.children).findLast(visible) as
              HTMLElement | undefined)
          : undefined) ?? scrollRoot;
      const bottomRect = bottomCandidate?.getBoundingClientRect();
      const bottomContentVisible = Boolean(
        !bottomRect ||
        !viewportRect ||
        (bottomRect.bottom <= viewportRect.bottom + 8 &&
          bottomRect.top <= viewportRect.bottom - 8),
      );
      const horizontalOverflow =
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth;
      const queueRows =
        routeId === "queue"
          ? (() => {
              const rowActions = Array.from(
                document.querySelectorAll<HTMLButtonElement>(
                  '[data-myoxus-ui-role="queue-row"] [data-myoxus-ui-role="queue-row-actions"] button',
                ),
              ).filter(visible);
              const visibleActionLabels = rowActions.flatMap((button) => {
                const text = button.textContent?.trim().replace(/\s+/g, " ");
                return text &&
                  /(pause|resume|pausier|fortsetz|warteschlange)/i.test(text)
                  ? [text]
                  : [];
              });
              const oversizedActionButtons = rowActions.flatMap((button) => {
                const rect = button.getBoundingClientRect();
                const label =
                  button.getAttribute("aria-label") ||
                  button.getAttribute("title") ||
                  button.textContent?.trim() ||
                  "unnamed action";
                return rect.width > 56
                  ? [`${label} (${Math.round(rect.width)}px)`]
                  : [];
              });
              return {
                compactToggleCount: rowActions.length,
                visibleActionLabels,
                oversizedActionButtons,
              };
            })()
          : undefined;
      const findings = [
        !root ? "detail root missing" : undefined,
        root && !rootVisible ? "detail root hidden" : undefined,
        !scrollRoot ? "detail scroll root missing" : undefined,
        scrollRoot && scrollRoot.clientHeight <= 0
          ? "detail scroll root has no viewport height"
          : undefined,
        scrollRoot &&
        getComputedStyle(scrollRoot).overflowY === "hidden" &&
        scrollable
          ? "detail scroll root hides vertical overflow"
          : undefined,
        !bottomReached ? "detail surface cannot scroll to bottom" : undefined,
        !bottomContentVisible
          ? "detail bottom content is not visible after scroll"
          : undefined,
        !lastFocusableVisible
          ? "last focusable control is not visible after scroll"
          : undefined,
        horizontalOverflow > 1
          ? `detail surface creates ${horizontalOverflow}px body overflow`
          : undefined,
        queueRows && queueRows.compactToggleCount === 0
          ? "queue rows do not expose compact icon actions"
          : undefined,
        queueRows && queueRows.visibleActionLabels.length > 0
          ? `queue row actions render visible repeated labels: ${queueRows.visibleActionLabels.join(", ")}`
          : undefined,
        queueRows && queueRows.oversizedActionButtons.length > 0
          ? `queue row actions are too wide: ${queueRows.oversizedActionButtons.join(", ")}`
          : undefined,
      ].filter((finding): finding is string => Boolean(finding));
      return {
        routeId,
        surfaceId,
        expectedDrawer,
        rootExists: Boolean(root),
        rootVisible,
        rootLabel:
          root?.textContent?.trim().replace(/\s+/g, " ").slice(0, 160) ?? "",
        scrollRoot: scrollRoot
          ? scrollSelector || scrollRoot.className || scrollRoot.tagName
          : "missing",
        clientHeight: scrollRoot?.clientHeight ?? 0,
        scrollHeight: scrollRoot?.scrollHeight ?? 0,
        scrollable,
        bottomScrollTop: scrollRoot?.scrollTop ?? 0,
        bottomReached,
        bottomContentVisible,
        horizontalOverflow,
        focusableControlCount: focusable.length,
        lastFocusableVisible,
        queueRows,
        findings,
      } satisfies DetailSurfaceSnapshot;
    },
    {
      rootSelector: scenario.rootSelector,
      scrollSelector: scenario.scrollSelector,
      routeId: scenario.routeId,
      surfaceId: scenario.surfaceId,
      expectedDrawer: scenario.expectedDrawer,
    },
  );
}

async function captureDetailSurfaceEvidence(
  page: Page,
  testInfo: TestInfo,
  scenario: DetailSurfaceScenario,
  snapshot: DetailSurfaceSnapshot,
) {
  const slug = `light-${contactSheetName(
    `${scenario.routeId}-${scenario.surfaceId}`,
  )}-detail`;
  const screenshotPath = testInfo.outputPath(`${slug}.png`);
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    path: screenshotPath,
  });
  mkdirSync(QA_DIR, { recursive: true });
  const qaScreenshotPath = path.join(QA_DIR, `${slug}.png`);
  const qaMetadataPath = path.join(QA_DIR, `${slug}.json`);
  const reviewedAt = new Date().toISOString();
  copyFileSync(screenshotPath, qaScreenshotPath);
  writeFileSync(
    qaMetadataPath,
    JSON.stringify(
      {
        scenario: {
          routeId: scenario.routeId,
          surfaceId: scenario.surfaceId,
          expectedDrawer: scenario.expectedDrawer,
          rootSelector: scenario.rootSelector,
          scrollSelector: scenario.scrollSelector ?? null,
        },
        snapshot,
        screenshot: qaScreenshotPath,
        metadata: qaMetadataPath,
        reviewedAt,
        fixedByCommit: REVIEW_COMMIT,
      },
      null,
      2,
    ),
  );
  return {
    screenshot: qaScreenshotPath,
    metadata: qaMetadataPath,
    reviewedAt,
    fixedByCommit: REVIEW_COMMIT,
  };
}

function assertDetailSurfaceSnapshot(snapshot: DetailSurfaceSnapshot) {
  expect(snapshot.rootExists, `${snapshot.surfaceId} root must exist`).toBe(
    true,
  );
  expect(
    snapshot.rootVisible,
    `${snapshot.surfaceId} root must be visible`,
  ).toBe(true);
  expect(
    snapshot.clientHeight,
    `${snapshot.surfaceId} detail scroll root must have a real viewport height`,
  ).toBeGreaterThan(0);
  expect(
    snapshot.bottomReached,
    `${snapshot.surfaceId} detail surface must scroll to the bottom`,
  ).toBe(true);
  expect(
    snapshot.bottomContentVisible,
    `${snapshot.surfaceId} detail bottom content must be visible after scroll; snapshot=${JSON.stringify(
      snapshot,
    )}`,
  ).toBe(true);
  expect(
    snapshot.lastFocusableVisible,
    `${snapshot.surfaceId} last focusable control must remain reachable after scroll`,
  ).toBe(true);
  expect(
    snapshot.horizontalOverflow,
    `${snapshot.surfaceId} detail surface must not widen the body`,
  ).toBeLessThanOrEqual(1);
  expect(
    snapshot.findings,
    `${snapshot.surfaceId} detail surface findings: ${JSON.stringify(
      snapshot,
    )}`,
  ).toEqual([]);
}

function writeDetailSurfaceInventory(
  snapshots: ReadonlyArray<
    DetailSurfaceSnapshot & {
      screenshots: Array<{
        screenshot: string;
        metadata: string;
        reviewedAt: string;
        fixedByCommit: string;
      }>;
      consoleErrors: string[];
    }
  >,
) {
  mkdirSync(QA_DIR, { recursive: true });
  const inventoryPath = path.join(QA_DIR, "scroll-layout-inventory.json");
  const existing = existsSync(inventoryPath)
    ? (JSON.parse(readFileSync(inventoryPath, "utf8")) as Record<
        string,
        unknown
      >)
    : {};
  existing["detail-surfaces-light"] = {
    reviewedAt: new Date().toISOString(),
    fixedByCommit: REVIEW_COMMIT,
    routeCount: snapshots.length,
    routes: snapshots.map((snapshot) => ({
      routeId: `${snapshot.routeId}:${snapshot.surfaceId}`,
      viewport: "desktop",
      sourceFiles: (() => {
        const route = routeById.get(snapshot.routeId);
        return route
          ? [`client/admin/workspaces/admin/src/modules/${route.module}/**`]
          : [];
      })(),
      tabsChecked: [],
      drawersExpected: routeById.get(snapshot.routeId)?.drawers ?? [],
      drawersChecked: [snapshot.expectedDrawer],
      scrollRoot: snapshot.scrollRoot,
      bottomReached: snapshot.bottomReached,
      bottomContentVisible: snapshot.bottomContentVisible,
      clientHeight: snapshot.clientHeight,
      scrollHeight: snapshot.scrollHeight,
      bottomScrollTop: snapshot.bottomScrollTop,
      horizontalOverflowPx: snapshot.horizontalOverflow,
      consoleErrors: snapshot.consoleErrors,
      screenshots: snapshot.screenshots,
      findings: [...snapshot.findings, ...snapshot.consoleErrors],
      fixedByCommit: REVIEW_COMMIT,
      status:
        snapshot.findings.length === 0 && snapshot.consoleErrors.length === 0
          ? "passed"
          : "finding",
    })),
  };
  writeFileSync(inventoryPath, `${JSON.stringify(existing, null, 2)}\n`);
}

function assertSnapshotFailsWith(
  snapshot: RouteVisualSnapshot,
  expectedMessage: string,
) {
  try {
    assertRouteSnapshot(snapshot);
  } catch (error) {
    expect(String(error)).toContain(expectedMessage);
    return;
  }
  throw new Error(
    `${snapshot.routeId} defect injection did not fail the visual gate: ${expectedMessage}`,
  );
}

async function readSidebarBox(page: Page) {
  return page
    .locator('[data-myoxus-ui-role="shell-sidebar-panel"]')
    .evaluate((sidebar) => {
      const rect = sidebar.getBoundingClientRect();
      return {
        width: rect.width,
        collapsed: Boolean(
          sidebar.querySelector(
            '[data-myoxus-ui-role="sidebar-nav-root"][data-collapsed="true"]',
          ),
        ),
      };
    });
}

async function readSidebarDesignContract(page: Page) {
  return page
    .locator('[data-myoxus-ui-role="shell-sidebar-panel"]')
    .evaluate((sidebar) => {
      const read = (selector: string) => {
        const element = sidebar.querySelector<HTMLElement>(selector);
        if (!element) {
          throw new Error(`sidebar contract selector missing: ${selector}`);
        }
        const style = getComputedStyle(element);
        return {
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          height: style.height,
          lineHeight: style.lineHeight,
          width: style.width,
        };
      };

      return {
        navItem: read('[data-myoxus-ui-role="navigation-link"]'),
        userName: read('[data-myoxus-ui-role="sidebar-user-name"]'),
        userAvatar: read(
          '[data-myoxus-ui-role="sidebar-user-row"] .mantine-Avatar-root',
        ),
        userBadge: read(
          '[data-myoxus-ui-role="sidebar-user-row"] .mantine-Badge-root',
        ),
        serverVersion: read('[data-myoxus-ui-role="sidebar-version-row"]'),
        serverVersionLabel:
          sidebar
            .querySelector('[data-myoxus-ui-role="sidebar-version-row"]')
            ?.textContent?.trim() ?? "",
      };
    });
}

test.describe.configure({ mode: "serial" });

test.describe("Admin UI facade live closeout sweep", () => {
  test.beforeEach(async ({ context, adminRequest }) => {
    await installAdminVisualBaselineLocale(context);
    await installAdminVisualBrowserHelpers(context);
    await signInAsAdmin(context, adminRequest);
  });

  test("visual invariants fail on injected scroll and rail regressions", async ({
    page,
  }) => {
    const dashboardRoute = authenticatedRoutes.find(
      (route) => route.id === "dashboard",
    );
    expect(
      dashboardRoute,
      "dashboard route must exist in the matrix",
    ).toBeTruthy();

    await openAdminRoute(page, dashboardRoute!);
    const scrollRegression = await page.addStyleTag({
      content:
        ".admin-page-scroll-viewport{overflow-y:hidden!important;}.mantine-ScrollArea-viewport{overflow-y:hidden!important;}",
    });
    assertSnapshotFailsWith(
      await readRouteVisualSnapshot(page, dashboardRoute!, "light"),
      "page scroll area must not hide vertical overflow",
    );
    await scrollRegression.evaluate((style) => style.remove());

    await openAdminRoute(page, dashboardRoute!);
    const railRegression = await page.addStyleTag({
      content:
        '[data-myoxus-ui-role="admin-page-scroll-rail"]{max-width:640px!important;}',
    });
    assertSnapshotFailsWith(
      await readRouteVisualSnapshot(page, dashboardRoute!, "light"),
      "content rail should use the full shared shell width",
    );
    await railRegression.evaluate((style) => style.remove());
  });

  test("desktop sidebar can collapse and reopen from the visible collapsed control", async ({
    page,
  }) => {
    const dashboardRoute = authenticatedRoutes.find(
      (route) => route.id === "dashboard",
    );
    expect(
      dashboardRoute,
      "dashboard route must exist in the matrix",
    ).toBeTruthy();

    await openAdminRoute(page, dashboardRoute!);
    await resetAdminPageScroll(page);
    await waitForAdminRouteAboveFoldContent(page, dashboardRoute!);
    const expandedBefore = await readSidebarBox(page);
    expect(expandedBefore.width).toBeGreaterThan(180);
    expect(expandedBefore.collapsed).toBe(false);
    await expect(
      page
        .locator(
          '[data-myoxus-ui-role="shell-sidebar-panel"] [data-myoxus-ui-role="navigation-link"]',
        )
        .first(),
    ).toBeVisible();
    expect(
      await page
        .locator(
          '[data-myoxus-ui-role="shell-sidebar-panel"] [data-myoxus-ui-role="navigation-link"] svg',
        )
        .count(),
      "expanded desktop sidebar should preserve semantic route icons like the web sidebar",
    ).toBeGreaterThan(8);
    const sidebarContract = await readSidebarDesignContract(page);
    expect(sidebarContract.userName.fontFamily).toBe(
      sidebarContract.navItem.fontFamily,
    );
    expect(sidebarContract.userName.fontSize).toBe(
      sidebarContract.navItem.fontSize,
    );
    expect(sidebarContract.userBadge.fontFamily).toBe(
      sidebarContract.userName.fontFamily,
    );
    expect(Number.parseFloat(sidebarContract.userBadge.fontSize)).toBeLessThan(
      Number.parseFloat(sidebarContract.userName.fontSize),
    );
    expect(sidebarContract.userAvatar.width).toBe(
      sidebarContract.userAvatar.height,
    );
    expect(sidebarContract.serverVersion.fontFamily).toBe(
      sidebarContract.userName.fontFamily,
    );
    expect(
      Number.parseFloat(sidebarContract.serverVersion.fontSize),
    ).toBeLessThanOrEqual(Number.parseFloat(sidebarContract.userName.fontSize));
    expect(sidebarContract.serverVersionLabel).not.toContain("ServerVersion");
    await page
      .locator('[data-myoxus-ui-role="shell-sidebar-panel"]')
      .screenshot({
        path: path.join(QA_DIR, "light-dashboard-sidebar-expanded-after.png"),
      });

    await page.getByTestId("shell-sidebar-toggle-expanded").click();
    await expect(
      page.getByTestId("shell-sidebar-toggle-collapsed"),
    ).toBeVisible({ timeout: 5_000 });
    const collapsed = await readSidebarBox(page);
    expect(collapsed.width).toBeLessThan(72);
    expect(collapsed.collapsed).toBe(true);
    await expect(
      page
        .locator(
          '[data-myoxus-ui-role="shell-sidebar-panel"] [data-myoxus-ui-role="navigation-link"]',
        )
        .first(),
      "collapsed desktop sidebar should keep icon-only links available",
    ).toBeVisible();
    expect(
      await page
        .locator(
          '[data-myoxus-ui-role="shell-sidebar-panel"] [data-myoxus-ui-role="navigation-link"] svg',
        )
        .count(),
      "collapsed desktop sidebar should preserve route icons",
    ).toBeGreaterThan(8);
    await page
      .locator('[data-myoxus-ui-role="shell-sidebar-panel"]')
      .screenshot({
        path: path.join(QA_DIR, "light-dashboard-sidebar-collapsed-after.png"),
      });

    await page.getByTestId("shell-sidebar-toggle-collapsed").click();
    await expect(page.getByTestId("shell-sidebar-toggle-expanded")).toBeVisible(
      { timeout: 5_000 },
    );
    const reopened = await readSidebarBox(page);
    expect(reopened.width).toBeGreaterThan(180);
    expect(reopened.collapsed).toBe(false);
    expect(
      await page
        .locator(
          '[data-myoxus-ui-role="shell-sidebar-panel"] [data-myoxus-ui-role="navigation-link"] svg',
        )
        .count(),
      "reopened desktop sidebar should restore semantic route icons",
    ).toBeGreaterThan(8);
  });

  test("Stuttgart consumes the server-owned Zuerich background transfer", async ({
    page,
    adminRequest,
  }) => {
    const original = await readEffectiveThemeProfile(adminRequest);
    const dashboardRoute = authenticatedRoutes.find(
      (route) => route.id === "dashboard",
    );
    expect(
      dashboardRoute,
      "dashboard route must exist in the matrix",
    ).toBeTruthy();

    try {
      for (const [themeMode, expected] of [
        [
          "light",
          {
            paper: "#ffffff",
            paperDeep: "#f3f3f5",
            oldPaper: "#faf7f2",
            oldPaperDeep: "#f2ede4",
          },
        ],
        [
          "dark",
          {
            paper: "#08090c",
            paperDeep: "#11131a",
            oldPaper: "#1a1b1f",
            oldPaperDeep: "#232428",
          },
        ],
      ] as const) {
        await setThemeProfile(adminRequest, {
          themeSlug: ADMIN_VISUAL_BASELINE_THEME_SLUG,
          themeMode,
        });
        await openAdminRoute(page, dashboardRoute!);
        const values = await page.evaluate(() => {
          const rootStyle = getComputedStyle(document.documentElement);
          return {
            source: (
              document.getElementById(
                "myoxus-branding-css",
              ) as HTMLStyleElement | null
            )?.dataset.myoxusBrandingSource,
            paper: rootStyle
              .getPropertyValue("--myoxus-background-primary-color")
              .trim(),
            paperDeep: rootStyle
              .getPropertyValue("--myoxus-background-secondary-color")
              .trim(),
            rule: rootStyle.getPropertyValue("--myoxus-sem-rule").trim(),
            accent: rootStyle
              .getPropertyValue("--myoxus-sem-accent-primary")
              .trim(),
          };
        });

        expect(values.source).toBe("api");
        expect(values.paper).toBe(expected.paper);
        expect(values.paperDeep).toBe(expected.paperDeep);
        expect(values.paper).not.toBe(expected.oldPaper);
        expect(values.paperDeep).not.toBe(expected.oldPaperDeep);
        expect(
          values.rule,
          "Stuttgart must keep its own rule token, not copy Zuerich wholesale",
        ).not.toBe(themeMode === "light" ? "#cdcdd2" : "#2a2c34");
        expect(
          values.accent,
          "Stuttgart must keep its own accent token, not copy Zuerich wholesale",
        ).not.toBe(themeMode === "light" ? "#c8102e" : "#ff5a6b");
      }
    } finally {
      await setThemeProfile(adminRequest, {
        themeSlug: original.theme.slug,
        themeMode: original.themeMode,
      });
    }
  });

  test("templates catalog localizes builtin metadata in the German admin UI", async ({
    page,
    adminRequest,
  }, testInfo) => {
    const original = await readEffectiveThemeProfile(adminRequest);
    const originalLocale = await readAdminLocale(adminRequest);
    const templatesRoute = authenticatedRoutes.find(
      (route) => route.id === "templates",
    );
    expect(
      templatesRoute,
      "templates route must exist in the matrix",
    ).toBeTruthy();

    try {
      await setAdminLocale(adminRequest, "de");
      await setThemeProfile(adminRequest, {
        themeSlug: ADMIN_VISUAL_BASELINE_THEME_SLUG,
        themeMode: "light",
      });
      await openAdminRoute(page, templatesRoute!);
      await waitForAdminRouteAboveFoldContent(page, templatesRoute!);

      const catalogList = page.getByTestId("templates-catalog-soft-list");
      await expect(catalogList).toBeVisible();
      await expect(
        catalogList.getByText("Tagesplan", { exact: true }),
      ).toBeVisible();
      await expect(
        catalogList.getByText("Plane den Tag, bevor der Tag dich plant.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(catalogList.getByText("Time-Blocking-Tag")).toBeVisible();

      const visibleCatalogText = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>(
          '[data-testid="templates-catalog-soft-list"]',
        );
        return (list?.innerText ?? "").trim().replace(/\s+/g, " ");
      });
      expect(visibleCatalogText).not.toMatch(
        /\bBusiness Daily\b|Daily business planning|Schedule your day|time-management|scheduling|business/,
      );

      const snapshot = await readInitialRouteVisualSnapshot(
        page,
        templatesRoute!,
        "light",
      );
      await captureRouteEvidence(
        page,
        testInfo,
        templatesRoute!,
        "light",
        snapshot,
        "initial",
      );
    } finally {
      await setAdminLocale(adminRequest, originalLocale);
      await setThemeProfile(adminRequest, {
        themeSlug: original.theme.slug,
        themeMode: original.themeMode,
      });
    }
  });

  for (const themeMode of themeModes) {
    for (const route of authenticatedRoutes) {
      test(`authenticated route matrix is visually usable in ${themeMode} mode: ${route.id}`, async ({
        page,
        adminRequest,
      }, testInfo) => {
        await runAuthenticatedRouteVisualCheck({
          adminRequest,
          page,
          route,
          testInfo,
          themeMode,
        });
      });
    }
  }

  test("selected detail surfaces use reachable scroll paths in light mode", async ({
    page,
    adminRequest,
  }, testInfo) => {
    test.setTimeout(120_000);
    const original = await readEffectiveThemeProfile(adminRequest);
    const runtimeCollector = installAdminRuntimeErrorCollector(page);
    const snapshots: Array<
      DetailSurfaceSnapshot & {
        screenshots: Array<{
          screenshot: string;
          metadata: string;
          reviewedAt: string;
          fixedByCommit: string;
        }>;
        consoleErrors: string[];
      }
    > = [];

    try {
      await setThemeProfile(adminRequest, {
        themeSlug: ADMIN_VISUAL_BASELINE_THEME_SLUG,
        themeMode: "light",
      });

      for (const scenario of DETAIL_SURFACE_SCENARIOS) {
        const route = routeById.get(scenario.routeId);
        expect(
          route,
          `${scenario.routeId} must exist in the Admin route matrix`,
        ).toBeTruthy();
        await openAdminRoute(page, route!);
        await assertTopLevelTabsMatchMatrix(page, route!);
        await resetAdminPageScroll(page);
        await waitForAdminRouteAboveFoldContent(page, route!);
        await scenario.open(page);
        const snapshot = await readDetailSurfaceSnapshot(page, scenario);
        assertDetailSurfaceSnapshot(snapshot);
        const evidence = await captureDetailSurfaceEvidence(
          page,
          testInfo,
          scenario,
          snapshot,
        );
        runtimeCollector.assertNoFatal();
        snapshots.push({
          ...snapshot,
          screenshots: [evidence],
          consoleErrors: runtimeCollector.errors.map(
            (error) =>
              `[${error.source}]${error.url ? ` ${error.url}` : ""} ${error.message}`,
          ),
        });
      }
    } finally {
      await setThemeProfile(adminRequest, {
        themeSlug: original.theme.slug,
        themeMode: original.themeMode,
      });
      writeDetailSurfaceInventory(snapshots);
    }
  });

  test("authenticated top-level tabs keep the shared shell layout in light mode", async ({
    page,
    adminRequest,
  }, testInfo) => {
    test.setTimeout(180_000);
    const original = await readEffectiveThemeProfile(adminRequest);
    const runtimeCollector = installAdminRuntimeErrorCollector(page);
    const tabSnapshots: RouteVisualSnapshot[] = [];

    try {
      await setThemeProfile(adminRequest, {
        themeSlug: ADMIN_VISUAL_BASELINE_THEME_SLUG,
        themeMode: "light",
      });

      for (const route of authenticatedRoutes) {
        await openAdminRoute(page, route);
        await assertTopLevelTabsMatchMatrix(page, route);
        await resetAdminPageScroll(page);
        const tabs = await visibleTopLevelTabs(page);
        const count = await tabs.count();

        for (let index = 0; index < count; index += 1) {
          const tab = tabs.nth(index);
          const tabLabel = (await tab.innerText()).trim().replace(/\s+/g, " ");
          await tab.scrollIntoViewIfNeeded();
          await tab.click();
          await expect(
            tab,
            `${route.id}:${tabLabel} tab must expose selected state after click`,
          ).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
          const tabRoute = {
            ...route,
            id: `${route.id}:${contactSheetName(tabLabel || String(index))}`,
          };
          await resetAdminPageScroll(page);
          await waitForAdminRouteAboveFoldContent(page, tabRoute);
          const initialSnapshot = await readInitialRouteVisualSnapshot(
            page,
            tabRoute,
            "light",
          );
          assertInitialRouteSnapshot(initialSnapshot, route);
          await captureRouteEvidence(
            page,
            testInfo,
            tabRoute,
            "light",
            initialSnapshot,
            "initial",
          );

          const snapshot = await readRouteVisualSnapshot(
            page,
            tabRoute,
            "light",
          );
          tabSnapshots.push(snapshot);
          assertRouteSnapshot(snapshot);
          await captureRouteEvidence(
            page,
            testInfo,
            tabRoute,
            "light",
            snapshot,
            "bottom",
          );
          runtimeCollector.assertNoFatal();
        }
      }
    } finally {
      await setThemeProfile(adminRequest, {
        themeSlug: original.theme.slug,
        themeMode: original.themeMode,
      });
      mkdirSync(QA_DIR, { recursive: true });
      writeFileSync(
        path.join(QA_DIR, "summary-light-tabs.json"),
        JSON.stringify(
          {
            themeMode: "light",
            tabCount: tabSnapshots.length,
            tabs: tabSnapshots,
            runtimeErrors: runtimeCollector.errors,
            runtimeErrorText: formatAdminRuntimeErrors(runtimeCollector.errors),
          },
          null,
          2,
        ),
      );
      writeScrollInventory(
        "authenticated-tabs-light",
        tabSnapshots,
        runtimeCollector.errors,
      );
    }
  });
});

test.describe("Admin UI facade bundle budget", () => {
  test("bundle manifest is consistent and main entry stays within closeout budget", () => {
    const adminBundleDir = resolveAdminBundleDir();
    const manifestPath = path.join(adminBundleDir, "assets-manifest.json");
    expect(existsSync(manifestPath), "admin bundle manifest must exist").toBe(
      true,
    );

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      publicPath?: string;
      js: string[];
      css: string[];
    };
    expect(
      manifest.publicPath,
      "admin bundle must use self-hosted relative assets by default",
    ).toBe("/");
    const referencedAssets = [...manifest.js, ...manifest.css];
    expect(referencedAssets.length).toBeGreaterThan(0);

    for (const asset of referencedAssets) {
      expect(
        existsSync(path.join(adminBundleDir, asset)),
        `manifest asset missing: ${asset}`,
      ).toBe(true);
    }

    const mainEntry = manifest.js.find((asset) =>
      /^js\/index\..+\.js$/.test(asset),
    );
    expect(
      mainEntry,
      "manifest must contain the admin main entry",
    ).toBeTruthy();
    const mainEntryBytes = statSync(path.join(adminBundleDir, mainEntry!)).size;
    expect(mainEntryBytes).toBeLessThanOrEqual(MAIN_ENTRY_MAX_BYTES);

    const html = readFileSync(path.join(adminBundleDir, "index.html"), "utf8");
    expect(
      html,
      "admin bundle must not reference external asset origins",
    ).not.toMatch(/\b(?:src|href)=["']https?:\/\//i);

    const staleAssets = readdirSync(path.join(adminBundleDir, "js")).filter(
      (file) => /queuedash|components-ui|shadcn|radix/i.test(file),
    );
    expect(staleAssets).toEqual([]);
  });
});
