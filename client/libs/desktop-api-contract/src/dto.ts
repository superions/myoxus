// SPDX-License-Identifier: AGPL-3.0-or-later

export type SharedStorageValue = undefined | SharedStoragePersistedValue;

export type SharedStoragePersistedValue =
  | null
  | boolean
  | number
  | string
  | SharedStoragePersistedValue[]
  | SharedStorageValueObject;

export type SharedStorageValueObject = {
  [key: string]: SharedStoragePersistedValue;
};

export type WorkbenchPath = {
  pathname?: string;
  hash?: string;
  search?: string;
};

export type WorkbenchViewModule =
  | "trash"
  | "allDocs"
  | "collection"
  | "tag"
  | "doc"
  | "page"
  | "edgeless"
  | "journal"
  | "attachment"
  | "pdf"
  | "ai"
  | "inbox"
  | "home";

export type WorkbenchViewMeta = {
  id: string;
  path?: WorkbenchPath;
  title?: string;
  iconName?: WorkbenchViewModule;
};

export type WorkbenchMeta = {
  id: string;
  /** Core-resolved server identity; null for local/unconfigured tabs.
   * Main validates it against the registered list before exposing a route. */
  serverId?: string | null;
  activeViewIndex: number;
  pinned?: boolean;
  basename: string;
  /** Presentation only; never used to resolve server or workspace authority. */
  workspaceName?: string;
  views: WorkbenchViewMeta[];
};

export type TabViewsMetaSchema = {
  activeWorkbenchId?: string;
  workbenches: WorkbenchMeta[];
};

export type TabStatus = WorkbenchMeta & {
  active: boolean;
  loaded: boolean;
  ready: boolean;
  pinned: boolean;
};

export type AddTabOption = {
  basename?: string;
  view?: Omit<WorkbenchViewMeta, "id"> | Array<Omit<WorkbenchViewMeta, "id">>;
  target?: string;
  edge?: "left" | "right";
  show?: boolean;
  pinned?: boolean;
};

export type TabAction =
  | { type: "add-tab"; payload: WorkbenchMeta }
  | { type: "close-tab"; payload?: string }
  | {
      type: "pin-tab";
      payload: { key: string; shouldPin: boolean };
    }
  | {
      type: "activate-view" | "separate-view";
      payload: { tabId: string; viewIndex: number };
    }
  | {
      type: "open-in-split-view";
      payload: { tabId: string; view?: Omit<WorkbenchViewMeta, "id"> };
    };

export const SpellCheckStateKey = "spellCheckState" as const;
export type SpellCheckStateSchema = {
  enabled?: boolean;
};

export const MenubarStateKey = "menubarState" as const;
export type MenubarStateSchema = {
  enabled: boolean;
  openOnLeftClick: boolean;
  minimizeToTray: boolean;
  closeToTray: boolean;
  startMinimized: boolean;
};

export const MeetingSettingsKey = "meetingSettings" as const;
export type MeetingSettingsSchema = {
  enabled: boolean;
  recordingSavingMode: "new-doc" | "journal-today";
  autoTranscriptionSummary: boolean;
  autoTranscriptionTodo: boolean;
  recordingMode: "none" | "prompt" | "auto-start";
};

export type AppInfo = {
  electron: true;
  windowName: string;
  viewId: string;
  scheme: DesktopScheme;
};

export type DesktopScheme =
  "myoxus" | "myoxus-beta" | "myoxus-internal" | "myoxus-dev";

export type UpdateMeta = {
  version: string;
  allowAutoUpdate: boolean;
};

export type UpdaterUnavailableReason =
  | "development"
  | "externally-managed"
  | "portable"
  | "missing-package-marker"
  | "unsupported-architecture"
  | "unsupported-package-marker"
  | "unsupported-platform";

/** Main-owned snapshot; null progress means no download is active. */
export type UpdaterState = {
  availability:
    | { state: "enabled" }
    | { state: "disabled"; reason: UpdaterUnavailableReason };
  phase:
    | "idle"
    | "checking"
    | "latest"
    | "available"
    | "downloading"
    | "ready"
    | "error";
  available: UpdateMeta | null;
  ready: UpdateMeta | null;
  progress: number | null;
};

export type UpdateInfo =
  | { state: "checked"; version: string | null }
  | { state: "unavailable"; reason: UpdaterUnavailableReason };

export type UpdaterConfig = {
  autoCheckUpdate: boolean;
  autoDownloadUpdate: boolean;
};

export type DatabaseFileError =
  | "DB_FILE_PATH_INVALID"
  | "DB_FILE_INVALID"
  | "DB_FILE_DATABASE_UNSUPPORTED"
  | "UNKNOWN_ERROR";

export type LoadDBFileResult = {
  workspaceId?: string;
  error?: DatabaseFileError;
  canceled?: boolean;
};

export type SaveDBFileResult = {
  filePath?: string;
  canceled?: boolean;
  error?: DatabaseFileError;
};

export type SelectDBFileLocationResult = {
  filePath?: string;
  canceled?: boolean;
  error?: DatabaseFileError;
};

export type FakeDialogResult = {
  canceled?: boolean;
  filePath?: string;
  filePaths?: string[];
};

export type BackupWorkspace = {
  id: string;
  name: string;
  fileSize: number;
  updatedAt: Date;
  avatar: Uint8Array | null;
  dbPath: string;
  createdAt: Date;
  docCount: number;
};

export type BackupWorkspaces = {
  items: BackupWorkspace[];
};

export type FindInPageOptions = {
  forward?: boolean;
  findNext?: boolean;
  matchCase?: boolean;
};

export type Rectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type FindInPageResult = {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  selectionArea: Rectangle;
  finalUpdate: boolean;
};

export type BookmarkData = {
  title?: string;
  description?: string;
  icon?: string;
  image?: string;
};

export type DocClock = {
  docId: string;
  timestamp: Date;
};

export type DocIndexedClock = DocClock & {
  indexerVersion: number;
};

export type DocRecord = DocClock & {
  bin: Uint8Array;
  editor?: string;
};

export type BlobRecord = {
  key: string;
  data: Uint8Array;
  mime: string;
  createdAt?: Date;
};

export type ListedBlobRecord = {
  key: string;
  mime: string;
  size: number;
  createdAt?: Date;
};

export type BlockInfo = {
  blockId: string;
  flavour: string;
  content?: string[];
  blob?: string[];
  refDocId?: string[];
  refInfo?: string[];
  parentFlavour?: string;
  parentBlockId?: string;
  additional?: string;
};

export type CrawlResult = {
  blocks: BlockInfo[];
  title: string;
  summary: string;
};

export type FullTextSearchResult = {
  id: string;
  score: number;
  terms: string[];
};

export type FullTextMatch = {
  start: number;
  end: number;
};

export type NativeApplicationInfo = {
  processId: number;
  name: string;
  objectId: number;
  processGroupId: number;
  bundleIdentifier: string;
  icon: Uint8Array;
};

export type TappableAppInfo = {
  info: NativeApplicationInfo;
  isRunning: boolean;
  processId: number;
  processGroupId: number;
  bundleIdentifier: string;
  name: string;
};

export type AppGroupInfo = {
  processGroupId: number;
  apps: TappableAppInfo[];
  name: string;
  bundleIdentifier: string;
  icon?: Uint8Array;
  isRunning: boolean;
};

export type RecordingState =
  | "new"
  | "recording"
  | "paused"
  | "stopped"
  | "ready"
  | "create-block-success"
  | "create-block-failed";

/** Main captures this authority from the initiating workbench, never at stop. */
export type RecordingDestination = {
  workspaceId: string;
  workspaceName?: string;
  serverId: string | null;
  serverBaseUrl?: string;
  savingMode: "new-doc" | "journal-today";
};

export type RecordingDelivery = {
  docId: string;
  attachmentId: string;
  blobId?: string;
};

export type RecordingStatus = {
  id: number;
  status: RecordingState;
  appName?: string;
  appGroupId?: number;
  icon?: Uint8Array;
  startTime: number;
  filepath?: string;
  sampleRate?: number;
  numberOfChannels?: number;
  destination?: RecordingDestination;
  delivery?: RecordingDelivery;
  error?: string;
};

export type RecordingDetails = {
  id: number;
  appGroup?: AppGroupInfo;
  app?: TappableAppInfo;
  startTime: number;
  filepath: string;
  sampleRate: number;
  numberOfChannels: number;
};

export type RecordingFailure = {
  name?: string;
  message: string;
  stack?: string;
};

export type MeetingPermissions = {
  screen: boolean;
  microphone: boolean;
  systemAudio: boolean;
};

export type RawAudioBuffers = {
  buffer: Uint8Array;
  nextCursor: number;
};

export type WorkerConnection = {
  portId: string;
};

export type OpenSettingsRequest = {
  activeTab: DesktopSettingTab;
  scrollAnchor?: string;
};

export type DesktopUserSettingTab =
  | "shortcuts"
  | "notifications"
  | "appearance"
  | "language-region"
  | "about"
  | "backup"
  | "experimental-features"
  | "editor"
  | "journal"
  | "account"
  | "meetings";

export type DesktopWorkspaceSettingTab = `workspace:${
  | "preference"
  | "properties"
  | "documents"
  | "members"
  | "storage"
  | "integrations"
  | "embedding"
  | "search"
  | "pdf-export"
  | "organization"}`;

export type DesktopSettingTab =
  DesktopUserSettingTab | DesktopWorkspaceSettingTab;

export type DocumentVersionMenuAction =
  "new-version" | "show-sidebar" | "compare-versions" | "restore-version";

export type DocumentVersionAction = {
  action: DocumentVersionMenuAction;
  tabId: string;
  docId: string;
};

export type CalendarReminder = {
  eventId: string;
  startDate: string;
};

export type TabNavigationRequest = {
  tabId: string;
  to: string;
};

export type AuthenticationRequest =
  | {
      method: "magic-link";
      payload: { email: string; token: string };
      server?: string;
    }
  | {
      method: "oauth";
      payload: { code: string; state: string; provider: string };
      server?: string;
    }
  | {
      method: "open-app-signin";
      payload: { code: string };
      server?: string;
    };

export type SharedStorageSnapshot = Readonly<
  Record<string, SharedStorageValue>
>;

export type SharedStorageChange = {
  v: SharedStorageValue;
  r: number;
  s?: string;
};

export type SharedStorageChanges = Readonly<
  Record<string, SharedStorageChange>
>;

/** Detached SQL label projection for a server-backed workspace backup. */
export interface WorkspaceLabelExport {
  workspaceTags: {
    id: string;
    name: string;
    colorRole: string;
    description: string | null;
    archived: boolean;
    archivedAt: string | null;
  }[];
  documents: { sourceId: string; externalId: string; tags: string[] }[];
}
