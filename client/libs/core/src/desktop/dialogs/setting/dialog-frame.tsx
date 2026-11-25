// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCurrentServerService } from "@myoxus/core/components/providers/current-server-scope";
import type { SettingTab } from "@myoxus/core/modules/dialogs/constant";
import { DefaultServerService } from "@myoxus/core/modules/server/services/default-server";
import { FrameworkScope, useService } from "@myoxus/infra";
import {
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import {
  Box,
  Loading,
  Modal,
  Scrollable,
  SettingsDialogContentCenter,
  SettingsDialogContentPanel,
  SettingsDialogContentViewport,
  SettingsDialogLoadingCenter,
  SettingsDialogScrollRoot,
  SettingsDialogShell,
  WorkspaceDetailSkeleton,
} from "./primitives";
import {
  type SettingsSubPageEntry,
  SubPageContext,
  type SubPageContextType,
} from "./sub-page";

type SettingsDialogState<T extends SettingTab> = {
  activeTab: T;
  scrollAnchor?: string;
};

export type SettingsDialogRenderProps<T extends SettingTab> = {
  activeTab: T;
  onTabChange: (tab: T) => void;
};

type SettingsDialogFrameProps<T extends SettingTab> = {
  ariaLabel: string;
  close: () => void;
  initialActiveTab: T;
  renderContent: (props: SettingsDialogRenderProps<T>) => ReactNode;
  renderSidebar: (props: SettingsDialogRenderProps<T>) => ReactNode;
  scrollAnchor?: string;
};

const CenteredLoading = () => (
  <SettingsDialogLoadingCenter>
    <Loading size={24} />
  </SettingsDialogLoadingCenter>
);

const SettingsDialogBody = <T extends SettingTab>({
  ariaLabel,
  initialActiveTab,
  renderContent,
  renderSidebar,
  scrollAnchor,
}: Omit<SettingsDialogFrameProps<T>, "close">) => {
  const [subPages, setSubPages] = useState<SettingsSubPageEntry[]>([]);
  const [dialogState, setDialogState] = useState<SettingsDialogState<T>>({
    activeTab: initialActiveTab,
    scrollAnchor,
  });
  const defaultServerService = useService(DefaultServerService);
  const currentServer =
    useCurrentServerService() ?? defaultServerService.server;
  const modalContentRef = useRef<HTMLDivElement>(null);
  const modalContentWrapperRef = useRef<HTMLDivElement>(null);
  const [subPageSlot, setSubPageSlot] = useState<HTMLDivElement | null>(null);

  const onTabChange = useCallback((activeTab: T) => {
    setDialogState({ activeTab });
  }, []);

  const upsertSubPage = useCallback((entry: SettingsSubPageEntry) => {
    setSubPages((previous) => {
      const index = previous.findIndex((item) => item.id === entry.id);
      if (index === -1) {
        return [...previous, entry];
      }
      if (previous[index].backText === entry.backText) {
        return previous;
      }
      const next = [...previous];
      next[index] = entry;
      return next;
    });
  }, []);

  const removeSubPage = useCallback((id: string) => {
    setSubPages((previous) =>
      previous.some((item) => item.id === id)
        ? previous.filter((item) => item.id !== id)
        : previous,
    );
  }, []);

  const activeSubPage = subPages.at(-1) ?? null;
  const activeSubPageId = activeSubPage?.id ?? null;

  const contextValue = useMemo(
    () =>
      ({
        subPages,
        activeSubPageId,
        portalTarget: subPageSlot,
        upsertSubPage,
        removeSubPage,
      }) satisfies SubPageContextType,
    [activeSubPageId, removeSubPage, subPageSlot, subPages, upsertSubPage],
  );

  useEffect(() => {
    if (!activeSubPage) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const openDialogs = document.querySelectorAll('[role="dialog"]');
      const settingsDialog =
        modalContentWrapperRef.current?.closest('[role="dialog"]');
      if (
        openDialogs.length > 1 &&
        openDialogs[openDialogs.length - 1] !== settingsDialog
      ) {
        return;
      }
      if (document.querySelector('[role="menu"], [role="listbox"]')) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      activeSubPage.onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [activeSubPage]);

  const renderProps: SettingsDialogRenderProps<T> = {
    activeTab: dialogState.activeTab,
    onTabChange,
  };

  useEffect(() => {
    if (dialogState.scrollAnchor) {
      flushSync(() => {
        modalContentRef.current
          ?.querySelector(`#${dialogState.scrollAnchor}`)
          ?.scrollIntoView();
      });
      return;
    }
    modalContentWrapperRef.current?.scrollTo({ top: 0 });
  }, [dialogState]);

  useEffect(() => {
    modalContentWrapperRef.current?.scrollTo({ top: 0 });
  }, [activeSubPageId]);

  return (
    <FrameworkScope scope={currentServer.scope}>
      <SettingsDialogShell>
        {renderSidebar(renderProps)}
        <SubPageContext.Provider value={contextValue}>
          <SettingsDialogScrollRoot>
            <SettingsDialogContentViewport
              data-testid="setting-modal-content"
              ref={modalContentWrapperRef}
              aria-label={ariaLabel}
              data-myoxus-ui-role="settings-dialog"
              data-setting-page
              data-open
              tabIndex={0}
            >
              <SettingsDialogContentCenter>
                <SettingsDialogContentPanel ref={modalContentRef}>
                  <Box hidden={Boolean(activeSubPage)}>
                    <Suspense fallback={<WorkspaceDetailSkeleton />}>
                      {renderContent(renderProps)}
                    </Suspense>
                  </Box>
                  <Box ref={setSubPageSlot} />
                </SettingsDialogContentPanel>
              </SettingsDialogContentCenter>
              <Scrollable.Scrollbar />
            </SettingsDialogContentViewport>
          </SettingsDialogScrollRoot>
        </SubPageContext.Provider>
      </SettingsDialogShell>
    </FrameworkScope>
  );
};

export const SettingsDialogFrame = <T extends SettingTab>({
  ariaLabel,
  close,
  initialActiveTab,
  renderContent,
  renderSidebar,
  scrollAnchor,
}: SettingsDialogFrameProps<T>) => {
  return (
    <Modal
      width="xl"
      height="80dvh"
      contentOptions={{
        "data-testid": "setting-modal",
        "aria-label": ariaLabel,
        bodyPadding: "none",
        bodyOverflow: "hidden",
      }}
      open
      onOpenChange={close}
    >
      <Suspense fallback={<CenteredLoading />}>
        <SettingsDialogBody
          ariaLabel={ariaLabel}
          initialActiveTab={initialActiveTab}
          renderContent={renderContent}
          renderSidebar={renderSidebar}
          scrollAnchor={scrollAnchor}
        />
      </Suspense>
    </Modal>
  );
};
