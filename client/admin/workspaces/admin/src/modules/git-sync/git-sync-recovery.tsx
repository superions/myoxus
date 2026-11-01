// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Button,
  SettingsNotice,
  SettingsStatusText,
  SettingsToolbar,
  Stack,
} from "@myoxus/ui-facade";
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";

import { AdminConfirmModal } from "../../components/shared/admin-confirm-modal";

import {
  createGitSyncDiagnosis,
  type GitSyncDiagnosis,
  reportGitSyncDiagnosis,
} from "./diagnostics";

type RecoveryProps = {
  diagnosis: GitSyncDiagnosis;
  onReload: () => Promise<void>;
  onDiscard?: () => void;
  message?: string;
};

export function GitSyncRecoveryNotice({
  diagnosis,
  onReload,
  onDiscard,
  message,
}: RecoveryProps) {
  const i18n = useI18n();
  const [reloading, setReloading] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  useEffect(() => {
    reportGitSyncDiagnosis(diagnosis);
  }, [diagnosis]);

  return (
    <SettingsNotice
      tone="error"
      title={i18n.t("admin.git-sync.recovery.title")}
    >
      <Stack>
        {message ?? i18n.t("admin.git-sync.recovery.description")}
        <Accordion keepMounted={false}>
          <AccordionItem value="diagnosis">
            <AccordionControl>
              {i18n.t("com.myoxus.common.technical-details")}
            </AccordionControl>
            <AccordionPanel>
              <SettingsStatusText>
                {i18n.t("admin.git-sync.recovery.diagnosis", {
                  diagnosisId: diagnosis.id,
                })}
              </SettingsStatusText>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
        {reloadFailed ? (
          <SettingsStatusText tone="error">
            {i18n.t("admin.git-sync.recovery.reload-failed")}
          </SettingsStatusText>
        ) : null}
        <SettingsToolbar justify="flex-start">
          <Button
            type="button"
            disabled={reloading}
            onClick={async () => {
              setReloading(true);
              setReloadFailed(false);
              try {
                await onReload();
              } catch {
                setReloadFailed(true);
                reportGitSyncDiagnosis(
                  createGitSyncDiagnosis({
                    code: "RECOVERY_FAILED",
                    tab: diagnosis.tab,
                    operationName: diagnosis.operationName,
                  }),
                );
              } finally {
                setReloading(false);
              }
            }}
          >
            {reloading
              ? i18n.t("admin.common.loading")
              : i18n.t("admin.git-sync.recovery.reload")}
          </Button>
          {onDiscard ? (
            <Button
              type="button"
              variant="ghost"
              disabled={reloading}
              onClick={() => setDiscardOpen(true)}
            >
              {i18n.t("admin.actions.discard")}
            </Button>
          ) : null}
        </SettingsToolbar>
        <AdminConfirmModal
          open={discardOpen}
          title={i18n.t("admin.unsaved.discard-title")}
          description={i18n.t("admin.unsaved.discard-description")}
          confirmText={i18n.t("admin.actions.discard")}
          onOpenChange={setDiscardOpen}
          onConfirm={() => {
            setDiscardOpen(false);
            onDiscard?.();
          }}
        />
      </Stack>
    </SettingsNotice>
  );
}

type BoundaryProps = {
  children: ReactNode;
  tab: string;
  onReload: () => Promise<void>;
  onDiscard: () => void;
};

type BoundaryState = {
  error: Error | null;
  diagnosis: GitSyncDiagnosis | null;
};

class GitSyncTabErrorBoundaryInner extends Component<
  BoundaryProps,
  BoundaryState
> {
  override state: BoundaryState = { error: null, diagnosis: null };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  override componentDidCatch(_error: Error, info: ErrorInfo) {
    const diagnosis = createGitSyncDiagnosis({
      code: "TAB_RENDER",
      tab: this.props.tab,
      componentStack: info.componentStack ?? undefined,
    });
    this.setState({ diagnosis });
  }

  override render() {
    if (this.state.error) {
      const diagnosis =
        this.state.diagnosis ??
        createGitSyncDiagnosis({
          code: "TAB_RENDER",
          tab: this.props.tab,
        });
      return (
        <GitSyncRecoveryNotice
          diagnosis={diagnosis}
          onReload={async () => {
            await this.props.onReload();
            this.setState({ error: null, diagnosis: null });
          }}
          onDiscard={() => {
            this.props.onDiscard();
            this.setState({ error: null, diagnosis: null });
          }}
        />
      );
    }
    return this.props.children;
  }
}

export function GitSyncTabErrorBoundary(props: BoundaryProps) {
  return <GitSyncTabErrorBoundaryInner {...props} />;
}

export function GitSyncQueryFailure({
  tab,
  operationName,
  onReload,
}: {
  tab: string;
  operationName: string;
  onReload: () => Promise<void>;
}) {
  const diagnosis = useMemo(
    () =>
      createGitSyncDiagnosis({
        code: "QUERY_FAILED",
        tab,
        operationName,
      }),
    [operationName, tab],
  );
  return <GitSyncRecoveryNotice diagnosis={diagnosis} onReload={onReload} />;
}
