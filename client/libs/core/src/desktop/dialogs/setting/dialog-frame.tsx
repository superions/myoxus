// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCurrentServerService } from "@myoxus/core/components/providers/current-server-scope";
import type { SettingTab } from "@myoxus/core/modules/dialogs/constant";
import { DefaultServerService } from "@myoxus/core/modules/server/services/default-server";
import { createIsland, type Island } from "@myoxus/core/utils/island";
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
import { MyoxusSettingsMantineProvider } from "./primitives/mantine-provider";
import {
  SubPageContext,
  type SubPageContextType,
  SubPageTarget,
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
  const [subPageIslands, setSubPageIslands] = useState<Island[]>([]);
  const [dialogState, setDialogState] = useState<SettingsDialogState<T>>({
    activeTab: initialActiveTab,
    scrollAnchor,
  });
  const defaultServerService = useService(DefaultServerService);
  const currentServer =
    useCurrentServerService() ?? defaultServerService.server;
  const modalContentRef = useRef<HTMLDivElement>(null);
  const modalContentWrapperRef = useRef<HTMLDivElement>(null);

  const onTabChange = useCallback((activeTab: T) => {
    setDialogState({ activeTab });
  }, []);
  const addSubPageIsland = useCallback(() => {
    const island = createIsland();
    setSubPageIslands((previous) => [...previous, island]);
    return {
      island,
      dispose: () => {
        setSubPageIslands((previous) =>
          previous.filter((candidate) => candidate !== island),
        );
      },
    };
  }, []);
  const contextValue = useMemo(
    () =>
      ({
        islands: subPageIslands,
        addIsland: addSubPageIsland,
      }) satisfies SubPageContextType,
    [addSubPageIsland, subPageIslands],
  );
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
                  <Suspense fallback={<WorkspaceDetailSkeleton />}>
                    {renderContent(renderProps)}
                  </Suspense>
                </SettingsDialogContentPanel>
              </SettingsDialogContentCenter>
              <Scrollable.Scrollbar />
            </SettingsDialogContentViewport>
            <SubPageTarget />
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
  const settingsDialogViewportMargin = "var(--mantine-spacing-lg)";
  return (
    <MyoxusSettingsMantineProvider>
      <Modal
        width={"780px"}
        height={`min(720px, calc(100dvh - ${settingsDialogViewportMargin}))`}
        contentOptions={{
          ["data-testid" as string]: "setting-modal",
          "aria-label": ariaLabel,
          style: {
            maxHeight: `calc(100dvh - ${settingsDialogViewportMargin})`,
            maxWidth: `calc(100dvw - ${settingsDialogViewportMargin})`,
            padding: 0,
            overflow: "hidden",
          },
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
    </MyoxusSettingsMantineProvider>
  );
};
