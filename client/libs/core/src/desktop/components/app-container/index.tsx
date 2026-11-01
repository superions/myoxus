/**
 * AppContainer — the root visual shell for every page in the application.
 *
 * Applies platform-specific background effects (noisy texture, macOS vibrancy
 * blur) based on user preferences and then renders the appropriate layout
 * component:
 *
 * - **DesktopLayout** (Electron): tabs header bar at the top with sidebar-
 *   switch and navigation buttons, followed by the sidebar + main content area.
 * - **BrowserLayout** (web): sidebar + main area. The open-in-app flow stays
 *   available through dedicated routes and commands, but workspace work
 *   surfaces must not be covered by a global promotional overlay.
 *
 * The `fallback` prop preserves the stable sidebar shell while the workspace
 * is loading, preventing identity flicker and layout shifts.
 *
 * `MainContainer` is the actual scrolling content region. It exposes several
 * `data-*` attributes (`data-client-border`, `data-side-bar-open`, etc.) that
 * drive Facade-owned layout adjustments.
 */
import { useDeviceSettingHelper } from "@myoxus/core/components/hooks/myoxus/use-device-setting-helper";
import { useUserPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { RootAppSidebar } from "@myoxus/core/components/root-app-sidebar";
import { AppSidebarService } from "@myoxus/core/modules/app-sidebar";
import {
  AppSidebarFallback,
  AppSidebarToggle,
} from "@myoxus/core/modules/app-sidebar/views";
import { AppTabsHeader } from "@myoxus/core/modules/app-tabs-header";
import { NavigationButtons } from "@myoxus/core/modules/navigation";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useLiveData, useServiceOptional } from "@myoxus/infra";
import {
  AppContainerDesktopMain,
  AppContainerDesktopTabsHeader,
  AppContainerLayout,
  AppContainerRoot,
  AppMainRegion,
} from "@myoxus/ui-facade";
import {
  forwardRef,
  type HTMLAttributes,
  type PropsWithChildren,
  type ReactElement,
} from "react";

/**
 * Root application container component.
 *
 * Wraps everything inside the per-page layout shell. Applies background-effect
 * CSS classes based on the current `appSettings` and delegates the actual
 * structure to `LayoutComponent` (Electron vs. browser variant).
 *
 * @param children - Page content to render inside the main area.
 * @param className - Optional additional CSS class for the root element.
 * @param fallback - When `true` renders the stable loading shell instead of
 *   the workspace navigation. Use during workspace loading.
 */
export const AppContainer = ({
  children,
  className,
  fallback = false,
  ...rest
}: PropsWithChildren<{
  className?: string;
  fallback?: boolean;
}>) => {
  const { deviceSettings } = useDeviceSettingHelper();
  const { effectivePreferences } = useUserPreferences();

  const noisyBackground =
    BUILD_CONFIG.isElectron && (effectivePreferences?.noisyBackground ?? true);
  const blurBackground =
    BUILD_CONFIG.isElectron &&
    environment.isMacOs &&
    deviceSettings.enableBlurBackground;
  return (
    <AppContainerRoot
      {...rest}
      className={className}
      noisyBackground={noisyBackground}
      translucent={blurBackground}
    >
      <LayoutComponent fallback={fallback}>{children}</LayoutComponent>
    </AppContainerRoot>
  );
};

/**
 * Electron-specific app layout.
 *
 * Renders the native-style tab header bar (containing the sidebar switch and
 * back/forward navigation buttons) above the sidebar + main-content row.
 * The sidebar switch and navigation buttons are only shown inside workspace
 * routes where `WorkspaceService` is available.
 */
const DesktopLayout = ({
  children,
  fallback = false,
}: PropsWithChildren<{ fallback?: boolean }>) => {
  const workspaceService = useServiceOptional(WorkspaceService);
  const isInWorkspace = !!workspaceService;
  return (
    <AppContainerLayout variant="desktop">
      <AppContainerDesktopTabsHeader>
        <AppTabsHeader
          left={
            <>
              {isInWorkspace && <AppSidebarToggle />}
              {isInWorkspace && <NavigationButtons />}
            </>
          }
        />
      </AppContainerDesktopTabsHeader>
      <AppContainerDesktopMain>
        {fallback ? (
          <AppSidebarFallback />
        ) : (
          isInWorkspace && <RootAppSidebar />
        )}
        <MainContainer>{children}</MainContainer>
      </AppContainerDesktopMain>
    </AppContainerLayout>
  );
};

/**
 * Browser (web) app layout.
 *
 * Browser workspace layout. It intentionally avoids global promotional
 * overlays so editor surfaces, database grids and document embeds remain
 * unobstructed in Web.
 */
const BrowserLayout = ({
  children,
  fallback = false,
}: PropsWithChildren<{ fallback?: boolean }>) => {
  const workspaceService = useServiceOptional(WorkspaceService);
  const isInWorkspace = !!workspaceService;

  return (
    <AppContainerLayout variant="browser">
      {fallback ? <AppSidebarFallback /> : isInWorkspace && <RootAppSidebar />}
      <MainContainer>{children}</MainContainer>
    </AppContainerLayout>
  );
};

/**
 * Selects the correct layout at build time.
 * Electron builds get `DesktopLayout`; all other targets get `BrowserLayout`.
 */
const LayoutComponent = BUILD_CONFIG.isElectron ? DesktopLayout : BrowserLayout;

/**
 * Scrollable main content region.
 *
 * Exposes several `data-*` attributes consumed by CSS:
 * - `data-is-desktop` — `true` in Electron builds.
 * - `data-client-border` — mirrors the user's "client border" preference.
 * - `data-side-bar-open` — `true` when the sidebar is open inside a workspace.
 * - `data-transparent` — reserved for future translucent-mode support.
 */
type MainContainerProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    "data-myoxus-ui-role"?: string;
  }
>;

const MainContainer = forwardRef<HTMLDivElement, MainContainerProps>(
  function MainContainer(
    {
      className,
      children,
      "data-myoxus-ui-role": uiRole = "app-main",
      ...props
    },
    ref,
  ): ReactElement {
    const workspaceService = useServiceOptional(WorkspaceService);
    const isInWorkspace = !!workspaceService;
    const { deviceSettings } = useDeviceSettingHelper();
    const appSidebarService = useServiceOptional(AppSidebarService)?.sidebar;
    const open = useLiveData(appSidebarService?.open$) ?? false;

    return (
      <AppMainRegion
        {...props}
        className={className}
        isDesktop={BUILD_CONFIG.isElectron}
        transparent={false}
        clientBorder={deviceSettings.clientBorder}
        data-myoxus-ui-role={uiRole}
        sideBarOpen={open && isInWorkspace}
        data-testid="main-container"
        ref={ref}
      >
        {children}
      </AppMainRegion>
    );
  },
);

MainContainer.displayName = "MainContainer";
