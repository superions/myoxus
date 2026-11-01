/**
 * React error boundaries for the admin frontend.
 *
 * `AppErrorBoundary` — top-level catch-all (full-page crash → Reload button).
 * `PageErrorBoundary` — per-route boundary (Retry or a full page reload).
 *   Key it by `location.pathname` so navigation automatically resets it.
 *
 * Error boundaries are class components (React requirement). i18n strings are
 * passed as props from thin wrapper function components that call `useI18n()`.
 */
import { useI18n } from "@myoxus/i18n";
import {
  ExceptionBoundaryDetails,
  ExceptionBoundaryFrame,
  ExceptionBoundarySurface,
  Group,
  MyoxusButton,
  SettingsSectionDescription,
  SettingsSectionHeading,
} from "@myoxus/ui-facade";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface BoundaryChildren {
  children: ReactNode;
}

interface PageBoundaryProps extends BoundaryChildren {
  titleText: string;
  descText: string;
  retryText: string;
  reloadText: string;
}

interface AppBoundaryProps extends BoundaryChildren {
  titleText: string;
  descText: string;
  reloadText: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Per-route error boundary (class component). Receives translated strings as
 * props from the `PageErrorBoundary` wrapper so hooks can be used for i18n.
 * Key the wrapper by `location.pathname` so navigation automatically resets it.
 */
class PageErrorBoundaryInner extends Component<PageBoundaryProps, State> {
  constructor(props: PageBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[PageErrorBoundary] Uncaught error:", error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  // A render retry cannot replace a malformed cached query before its child
  // mounts. Reload is explicit and does not silently flush other draft owners.
  handleReload = () => {
    window.location.reload();
  };

  override render() {
    if (this.state.hasError) {
      const { titleText, descText, retryText, reloadText } = this.props;
      return (
        <ExceptionBoundaryFrame scope="page">
          <ExceptionBoundarySurface>
            <SettingsSectionHeading level={1}>
              {titleText}
            </SettingsSectionHeading>
            <SettingsSectionDescription>{descText}</SettingsSectionDescription>
            {this.state.error && (
              <ExceptionBoundaryDetails>
                {this.state.error.message}
              </ExceptionBoundaryDetails>
            )}
            <Group justify="center">
              <MyoxusButton
                onClick={this.handleRetry}
                variant="primary"
                data-testid="admin-page-error-retry"
              >
                {retryText}
              </MyoxusButton>
              <MyoxusButton
                onClick={this.handleReload}
                variant="outline"
                data-testid="admin-page-error-reload"
              >
                {reloadText}
              </MyoxusButton>
            </Group>
          </ExceptionBoundarySurface>
        </ExceptionBoundaryFrame>
      );
    }

    return this.props.children;
  }
}

/**
 * Per-route error boundary wrapper. Key by `location.pathname` so navigation
 * automatically resets the boundary. Retry remounts the child; explicit Reload
 * also clears in-memory query state when a cached render failure persists.
 *
 * @example
 * <PageErrorBoundary key={location.pathname}>
 *   <Outlet />
 * </PageErrorBoundary>
 */
export function PageErrorBoundary({ children }: BoundaryChildren) {
  const i18n = useI18n();
  return (
    <PageErrorBoundaryInner
      titleText={i18n.t("admin.error.page-failed")}
      descText={i18n.t("admin.error.page-failed-desc")}
      retryText={i18n.t("admin.error.retry")}
      reloadText={i18n.t("admin.error.reload")}
    >
      {children}
    </PageErrorBoundaryInner>
  );
}

/**
 * Top-level error boundary (class component). Receives translated strings as
 * props from the `AppErrorBoundary` wrapper so hooks can be used for i18n.
 */
class AppErrorBoundaryInner extends Component<AppBoundaryProps, State> {
  constructor(props: AppBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[AppErrorBoundary] Uncaught error:", error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  override render() {
    if (this.state.hasError) {
      const { titleText, descText, reloadText } = this.props;
      return (
        <ExceptionBoundaryFrame scope="app">
          <ExceptionBoundarySurface>
            <SettingsSectionHeading level={1}>
              {titleText}
            </SettingsSectionHeading>
            <SettingsSectionDescription>{descText}</SettingsSectionDescription>
            {this.state.error && (
              <ExceptionBoundaryDetails>
                {this.state.error.message}
              </ExceptionBoundaryDetails>
            )}
            <MyoxusButton
              onClick={this.handleReload}
              variant="primary"
              data-testid="admin-app-error-reload"
            >
              {reloadText}
            </MyoxusButton>
          </ExceptionBoundarySurface>
        </ExceptionBoundaryFrame>
      );
    }

    return this.props.children;
  }
}

/**
 * Top-level catch-all error boundary wrapper. Renders a full-page crash card
 * with a Reload button. i18n-aware via the wrapper pattern.
 */
export function AppErrorBoundary({ children }: BoundaryChildren) {
  const i18n = useI18n();
  return (
    <AppErrorBoundaryInner
      titleText={i18n.t("admin.error.app-failed")}
      descText={i18n.t("admin.error.app-failed-desc")}
      reloadText={i18n.t("admin.error.reload")}
    >
      {children}
    </AppErrorBoundaryInner>
  );
}
