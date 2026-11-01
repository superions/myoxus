/**
 * Page-level error boundary for config pages (System/AI/Performance).
 *
 * Catches descendant render failures and displays a shared error notice.
 * Retry remounts the failed subtree; query hooks own their refetch policy.
 */
import { useI18n } from "@myoxus/i18n";
import {
  ErrorMessage,
  Group,
  MyoxusButton,
  SettingsNotice,
  SettingsSectionHeading,
  Stack,
} from "@myoxus/ui-facade";
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Optional title for the error notice. */
  title?: string;
  message?: string;
  retryLabel: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class PageConfigErrorBoundaryInner extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error) {
    console.error("[PageConfigErrorBoundary] Config load error:", error);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  override render() {
    if (this.state.hasError) {
      return (
        <SettingsNotice
          tone="error"
          title={
            <SettingsSectionHeading level={3}>
              {this.props.title}
            </SettingsSectionHeading>
          }
          data-myoxus-ui-role="admin-config-error-state"
        >
          <Stack>
            <ErrorMessage>
              {this.state.error?.message ?? this.props.message}
            </ErrorMessage>
            <Group>
              <MyoxusButton type="button" onClick={this.handleRetry}>
                {this.props.retryLabel}
              </MyoxusButton>
            </Group>
          </Stack>
        </SettingsNotice>
      );
    }

    return this.props.children;
  }
}

export function PageConfigErrorBoundary({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) {
  const i18n = useI18n();
  return (
    <PageConfigErrorBoundaryInner
      title={title ?? i18n.t("admin.config.error.load-failed")}
      message={i18n.t("admin.config.error.load-failed-desc")}
      retryLabel={i18n.t("admin.error.retry")}
    >
      {children}
    </PageConfigErrorBoundaryInner>
  );
}
