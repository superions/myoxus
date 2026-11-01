// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  AuthenticationRequest,
  CalendarReminder,
  DocumentVersionAction,
  OpenSettingsRequest,
  RecordingStatus,
  SharedStorageChanges,
  TabAction,
  TabNavigationRequest,
  TabStatus,
  TabViewsMetaSchema,
  UpdateMeta,
  UpdaterState,
} from "./dto";

export type DesktopUnsubscribe = () => void;

/** Correlated Main request; no document/source payload crosses this boundary. */
export type RendererCloseRequest = { requestId: string; participantId: string };

export type DesktopEventSubscriber<Payload = void> = (
  callback: (payload: Payload) => void,
) => DesktopUnsubscribe;

export type MainClientEvents = {
  applicationMenu: {
    onEditHistory: DesktopEventSubscriber<{
      action: "undo" | "redo";
      tabId: string;
    }>;
    onNewPageAction: DesktopEventSubscriber<"page" | "edgeless">;
    openInSettingModal: DesktopEventSubscriber<OpenSettingsRequest>;
    onOpenJournal: DesktopEventSubscriber<void>;
    onDocumentVersionAction: DesktopEventSubscriber<DocumentVersionAction>;
  };
  updater: {
    onUpdateAvailable: DesktopEventSubscriber<UpdateMeta | null>;
    onUpdateReady: DesktopEventSubscriber<UpdateMeta | null>;
    onDownloadProgress: DesktopEventSubscriber<number | null>;
    onStateChange: DesktopEventSubscriber<UpdaterState>;
  };
  ui: {
    onBrandingUpdated: DesktopEventSubscriber<{ serverId: string }>;
    onMaximized: DesktopEventSubscriber<boolean>;
    onFullScreen: DesktopEventSubscriber<boolean>;
    onTabViewsMetaChanged: DesktopEventSubscriber<TabViewsMetaSchema>;
    onTabAction: DesktopEventSubscriber<TabAction>;
    onToggleRightSidebar: DesktopEventSubscriber<string>;
    onTabsStatusChange: DesktopEventSubscriber<TabStatus[]>;
    onActiveTabChanged: DesktopEventSubscriber<string>;
    onTabGoToRequest: DesktopEventSubscriber<TabNavigationRequest>;
    onTabShellViewActiveChange: DesktopEventSubscriber<boolean>;
    onAuthenticationRequest: DesktopEventSubscriber<AuthenticationRequest>;
    onCloseView: DesktopEventSubscriber<void>;
    onCloseRequest: DesktopEventSubscriber<RendererCloseRequest>;
    onCalendarReminderClick: DesktopEventSubscriber<CalendarReminder>;
  };
  sharedStorage: {
    onGlobalStateChanged: DesktopEventSubscriber<SharedStorageChanges>;
    onGlobalCacheChanged: DesktopEventSubscriber<SharedStorageChanges>;
  };
  recording: {
    onRecordingStatusChanged: DesktopEventSubscriber<RecordingStatus | null>;
  };
  popup: {
    onNotificationChanged: DesktopEventSubscriber<null>;
  };
  power: {
    "power-source": DesktopEventSubscriber<boolean>;
  };
};

export type HelperClientEvents = {
  workspace: Record<never, never>;
};

export type ClientEvents = MainClientEvents & HelperClientEvents;

type ChannelShape<Surface> = {
  readonly [Namespace in keyof Surface]: {
    readonly [Channel in keyof Surface[Namespace]]: true;
  };
};

export const mainEventChannelManifest = {
  applicationMenu: {
    onEditHistory: true,
    onNewPageAction: true,
    openInSettingModal: true,
    onOpenJournal: true,
    onDocumentVersionAction: true,
  },
  updater: {
    onUpdateAvailable: true,
    onUpdateReady: true,
    onDownloadProgress: true,
    onStateChange: true,
  },
  ui: {
    onBrandingUpdated: true,
    onMaximized: true,
    onFullScreen: true,
    onTabViewsMetaChanged: true,
    onTabAction: true,
    onToggleRightSidebar: true,
    onTabsStatusChange: true,
    onActiveTabChanged: true,
    onTabGoToRequest: true,
    onTabShellViewActiveChange: true,
    onAuthenticationRequest: true,
    onCloseView: true,
    onCloseRequest: true,
    onCalendarReminderClick: true,
  },
  sharedStorage: {
    onGlobalStateChanged: true,
    onGlobalCacheChanged: true,
  },
  recording: { onRecordingStatusChanged: true },
  popup: { onNotificationChanged: true },
  power: { "power-source": true },
} as const satisfies ChannelShape<MainClientEvents>;

export const helperEventChannelManifest = {
  workspace: {},
} as const satisfies ChannelShape<HelperClientEvents>;

export const clientEventChannelManifest = {
  ...mainEventChannelManifest,
  ...helperEventChannelManifest,
} as const satisfies ChannelShape<ClientEvents>;
